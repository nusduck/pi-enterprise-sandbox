/**
 * 把 runtime 侧的 `ApprovalStore` 接到 MySQL 的治理记录器（ADR 0009 D5 / 计划 H4.3）。
 *
 * ## 这里补的是一条**断掉的链**
 *
 * `FencedToolGovernanceRecorder.requestApproval()` 才是真正干活的那一环：
 * 一个事务里铸 approval + tool_execution + `run.status.changed` 事件 + outbox 行，
 * 并把 Run 从 RUNNING 迁到 WAITING_APPROVAL，然后回一个 `DURABLE_APPROVAL_PENDING`
 * 信号给 executor 的 `runSuspensionPort`——executor 收到它才会停泊并释放 Worker。
 *
 * 而 2026-08-31 之前，这个 recorder **只经 `extensionBundleFactory` 到达运行时**，
 * 也就是那批已经删掉的 Pi Extension。DSH 重建之后没有人再调它，于是：
 * runtime 侧的策略挂载点用的是进程内的 `InMemoryApprovalStore`，
 * 审批「判定」是对的，但**不落库、不发事件、不停泊 Run、不释放 Worker**。
 * 换句话说审批链条从判定之后就断了。
 *
 * 本适配器把 runtime 的 `persistPending` 转成 `requestApproval`，
 * 并把返回的 durable 信号交给 executor。
 *
 * ## 为什么是「每 Run 一个」
 *
 * recorder 与 suspension port 都绑在这一个 Run 上（fence、runId、scope）。
 * 做成进程级单例就会把 A 的审批记到 B 的 Run 上。
 */
import type {
  ApprovalStore,
  PendingApproval,
} from '../runtime/policy/pre-execute.js';

/** `FencedToolGovernanceRecorder` 里本适配器真正用到的那部分。 */
interface GovernanceRecorderLike {
  requestApproval(input: {
    toolCallId: string;
    toolName: string;
    args?: unknown;
    decision: Record<string, unknown>;
  }): Promise<{ durablePending?: unknown; approval?: { approvalId?: string; status?: string } } | null>;
}

export interface GovernanceApprovalConsumeInput {
  readonly approvalId: string;
  readonly toolExecutionId?: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly argsIntegrity?: string | null;
}

/** executor 的停泊端口。收到信号才会把 Run 停下并释放 Worker。 */
type SuspensionSink = (pending: unknown) => void;

export interface GovernanceApprovalStoreDeps {
  readonly recorder: GovernanceRecorderLike;
  readonly onDurableApprovalPending: SuspensionSink;
  /**
   * 查已解决的决定（续跑路径，ADR 0009 D5）。按「工具名 + 参数指纹」查，
   * 因为续跑时模型重新发起的调用带的是**新 callId**。
   */
  readonly findResolvedByDigest?: (
    toolName: string,
    sourceDigest: string,
    args?: Record<string, unknown>,
  ) => Promise<PendingApproval | null>;
  /** Atomic durable claim performed immediately before tool dispatch. */
  readonly consume?: (input: GovernanceApprovalConsumeInput) => Promise<void>;
}

export class GovernanceApprovalStore implements ApprovalStore {
  /** 本 Run 内已经铸过的记录，供 answerer 按 id 回查，省一次往返。 */
  private readonly local = new Map<string, PendingApproval>();

  constructor(private readonly deps: GovernanceApprovalStoreDeps) {}

  /**
   * 铸一条 durable PENDING 并**停泊 Run**。
   *
   * `record.id` 是 runtime 侧按 `appr_<callId>` 生成的本地 id；MySQL 那边的
   * `approvalId` 是 ULID，由 recorder 生成。两者都留在本地映射里，因为
   * answerer 回查用的是前者，而审批中心 / HTTP 用的是后者。
   */
  async persistPending(record: PendingApproval): Promise<void> {
    this.local.set(record.id, record);
    const callId = record.id.startsWith('appr_') ? record.id.slice('appr_'.length) : record.id;
    const out = await this.deps.recorder.requestApproval({
      toolCallId: callId,
      toolName: record.toolName,
      args: safeParse(record.argsCanonical),
      decision: {
        decision: 'require_approval',
        reasonCode: 'RISK_HIGH',
        reason: `${record.toolName} requires approval`,
        policyId: 'platform:risk-table',
        riskLevel: 'high',
      },
    });
    const pending = out?.durablePending;
    if (pending !== undefined && pending !== null) {
      const durableApprovalId = String(
        (out?.approval as { approvalId?: unknown } | undefined)?.approvalId ??
          (pending as { approvalId?: unknown }).approvalId ??
          '',
      ).trim();
      const toolExecutionId = String(
        (pending as { toolExecutionId?: unknown }).toolExecutionId ?? '',
      ).trim();
      if (durableApprovalId || toolExecutionId) {
        this.local.set(record.id, {
          ...record,
          ...(durableApprovalId ? { durableApprovalId } : {}),
          ...(toolExecutionId ? { toolExecutionId } : {}),
          toolCallId: callId,
        });
      }
      // executor 收到这个信号才会停泊。**不能吞掉**——吞掉的后果是审批落了库，
      // Run 却继续跑到超时，人在审批中心点同意也无处可续。
      this.deps.onDurableApprovalPending(pending);
    }
  }

  async get(id: string): Promise<PendingApproval | null> {
    return this.local.get(id) ?? null;
  }

  async findResolvedByDigest(
    toolName: string,
    sourceDigest: string,
    args?: Record<string, unknown>,
  ): Promise<PendingApproval | null> {
    if (this.deps.findResolvedByDigest === undefined) return null;
    const found = await this.deps.findResolvedByDigest(toolName, sourceDigest, args);
    if (found !== null) this.local.set(found.id, found);
    return found;
  }

  async consume(
    id: string,
    expected?: {
      toolName: string;
      args: Record<string, unknown>;
      argsIntegrity?: string | null;
    },
  ): Promise<void> {
    if (typeof this.deps.consume !== 'function') {
      throw new Error('durable approval consumer is not configured');
    }
    const record = this.local.get(id);
    if (record === undefined) {
      throw new Error(`durable approval metadata is unavailable for ${id}`);
    }
    const approvalId = String(record.durableApprovalId ?? '').trim();
    const toolCallId = String(record.toolCallId ?? deriveToolCallId(record.id)).trim();
    if (!approvalId || !toolCallId) {
      throw new Error(`durable approval binding is incomplete for ${id}`);
    }
    const args = expected?.args ?? safeParse(record.argsCanonical);
    await this.deps.consume({
      approvalId,
      ...(record.toolExecutionId ? { toolExecutionId: record.toolExecutionId } : {}),
      toolCallId,
      toolName: expected?.toolName ?? record.toolName,
      args,
      ...(expected?.argsIntegrity !== undefined
        ? { argsIntegrity: expected.argsIntegrity }
        : record.argsIntegrity !== undefined
          ? { argsIntegrity: record.argsIntegrity }
          : {}),
    });
  }
}

/** `argsCanonical` 是 `JSON.stringify(args)`；坏了就当空对象，不为记账把一次调用打死。 */
function safeParse(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function deriveToolCallId(id: string): string {
  return id.startsWith('appr_') ? id.slice('appr_'.length) : id;
}
