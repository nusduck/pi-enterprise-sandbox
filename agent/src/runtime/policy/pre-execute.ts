/**
 * tools/pre-execute：风险表 + source_digest + 持久 PENDING 审批。
 *
 * 只读参数，不改写（上游限制）。require_approval 时工具不得执行，
 * 账本先落 PENDING，Run 投影 WAITING_APPROVAL。
 */

import { makePolicyDecision, mergePolicyDecisions, type PolicyDecision } from './decision.js';
import type { PolicyRiskLevel } from './decision.js';
import { decideFromRiskTable } from './risk-table.js';
import { digestArgs, rejectMismatchedDigest } from './source-digest.js';
import { approvalIdOf } from './approval-id.js';

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'DENIED';

export interface PendingApproval {
  readonly id: string;
  readonly toolName: string;
  readonly sourceDigest: string;
  readonly argsCanonical: string;
  readonly status: ApprovalStatus;
  readonly runStatusHint: 'WAITING_APPROVAL';
}

export interface ApprovalStore {
  persistPending(record: PendingApproval): Promise<void>;
  get(id: string): Promise<PendingApproval | null>;
  /**
   * 按「工具名 + 参数指纹」找一条**已解决**的决定（ADR 0009 D5 的续跑路径）。
   *
   * 为什么不能只按 `callId` 查：续跑是**重建会话后让模型重新发起同一个调用**，
   * 那次调用会拿到一个**新的 callId**。ADR D5 写的是「按 `callId` + args digest
   * 查到已落库的决定」——跨会话时能对上的只有 digest 这一半。
   *
   * 指纹绑的是**字节**：人批准的是 A 这组参数，落地的必须还是 A。
   * 模型改了任何一个字符，指纹就对不上，这里查不到，于是重新走审批。
   */
  findResolvedByDigest?(
    toolName: string,
    sourceDigest: string,
    args?: Record<string, unknown>,
  ): Promise<PendingApproval | null>;
  /**
   * 消费一次性授权（ADR 0009 D5：出厂词表只有 `allowed-once`，没有 allow-always）。
   * 不实现等于同一条批准可以被重复使用——那是越权。
   */
  consume?(id: string): Promise<void>;
}

export class InMemoryApprovalStore implements ApprovalStore {
  readonly records = new Map<string, PendingApproval>();
  readonly consumed = new Set<string>();
  async persistPending(record: PendingApproval): Promise<void> {
    this.records.set(record.id, record);
  }
  async get(id: string): Promise<PendingApproval | null> {
    return this.records.get(id) ?? null;
  }
  async findResolvedByDigest(
    toolName: string,
    sourceDigest: string,
    _args?: Record<string, unknown>,
  ): Promise<PendingApproval | null> {
    for (const record of this.records.values()) {
      if (record.status === 'PENDING') continue;
      if (this.consumed.has(record.id)) continue;
      if (record.toolName === toolName && record.sourceDigest === sourceDigest) return record;
    }
    return null;
  }
  async consume(id: string): Promise<void> {
    this.consumed.add(id);
  }
}

export interface PreExecuteInput {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly callId: string;
  /** 恢复重放时带上当初入账的 digest；缺省表示首次。 */
  readonly replayDigest?: string | undefined;
}

export interface PreExecuteResult {
  readonly decision: PolicyDecision;
  readonly approval: PendingApproval | null;
  readonly blocked: boolean;
}

export async function evaluatePreExecute(
  input: PreExecuteInput,
  store: ApprovalStore,
  idFactory: () => string = () => approvalIdOf(input.callId),
  /**
   * 风险覆盖。两种形态：
   * - **扁平 map**（`{ bash: 'high' }`）——单测与简单场景用。
   * - **解析函数**（`(toolName) => level | undefined`）——生产用。表达得了
   *   `mcp__github__*` 这类前缀规则与 `mcpServers` 的分层，扁平 map 表达不了。
   *
   * 不传就只用平台默认表——但那样运维配的东西就静默失效了。
   * 2026-08-31 之前就是这样：`riskOverrides` 被设在 **executor 工厂**的选项上，
   * 而 `runtime-factory` 从**它自己的** opts 读，两边根本不是同一个对象，
   * 于是 `config/agent/tool-risk.json` 零效果，而且没有任何人报错。
   */
  riskOverrides:
    | Readonly<Record<string, PolicyRiskLevel>>
    | ((toolName: string) => PolicyRiskLevel | undefined) = {},
): Promise<PreExecuteResult> {
  const digest = digestArgs(input.args);
  const pieces: PolicyDecision[] = [decideFromRiskTable(input.toolName, riskOverrides)];

  // 续跑路径（ADR 0009 D5）：这次调用的参数指纹如果对上了一条**已解决**的决定，
  // 就按那条决定走，不再问第二次人。
  //
  // 为什么在这里而不是在 answerer 里：审批 seam 的请求**不携带 arguments**
  // （出厂自陈的已知限制），拿不到指纹就绑不了字节。而这里 args 齐全。
  // ADR D5 的原话也是「digest 与租户 / fence 仍在 tools/pre-execute 上核」。
  const resolved =
    store.findResolvedByDigest === undefined
      ? null
      // 把 **args 本身**也传下去：durable 那边用的是 `integrityFingerprint`
      // （账本的算法），与我们这里的 `digestArgs` 不是同一个函数。拿我们的
      // digest 去查 MySQL 永远查不到——2026-08-31 的 compose 端到端就是这么
      // 发现的：批准之后续跑又停泊了一次，因为这一步查空、重新铸了 PENDING。
      : await store.findResolvedByDigest(input.toolName, digest, input.args);
  if (resolved !== null) {
    if (resolved.status === 'APPROVED') {
      // 一次性授权：出厂词表只有 `allowed-once`，没有 allow-always。
      // 不消费掉，同一条批准就能被反复使用。
      await store.consume?.(resolved.id);
      return {
        decision: makePolicyDecision({
          decision: 'allow',
          reasonCode: 'APPROVAL_GRANTED_ONCE',
          reason: `${input.toolName} was approved (${resolved.id}) for exactly these arguments`,
          policyId: 'platform:approval',
          riskLevel: 'low',
        }),
        approval: null,
        blocked: false,
      };
    }
    return {
      decision: makePolicyDecision({
        decision: 'deny',
        reasonCode: 'APPROVAL_REJECTED',
        reason: `${input.toolName} was rejected by a human (${resolved.id}); do not retry it`,
        policyId: 'platform:approval',
        riskLevel: 'high',
      }),
      approval: null,
      blocked: true,
    };
  }
  if (input.replayDigest !== undefined) {
    const mismatch = rejectMismatchedDigest(input.replayDigest, digest);
    if (mismatch) pieces.push(mismatch);
  }
  const decision = mergePolicyDecisions(pieces);
  if (decision.decision === 'allow') {
    return { decision, approval: null, blocked: false };
  }
  if (decision.decision === 'deny') {
    return { decision, approval: null, blocked: true };
  }
  const approval: PendingApproval = {
    id: idFactory(),
    toolName: input.toolName,
    sourceDigest: digest,
    argsCanonical: JSON.stringify(input.args),
    status: 'PENDING',
    runStatusHint: 'WAITING_APPROVAL',
  };
  await store.persistPending(approval);
  return { decision, approval, blocked: true };
}
