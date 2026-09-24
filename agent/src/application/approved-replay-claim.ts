/**
 * 已批准调用的**续跑认领**（ADR 0009 D5 / 计划 H4.4）。
 *
 * 从 `dsh-run-executor.ts` 拆出来的原因是职责：那个文件负责一次 Run 的编排，
 * 而这里回答的是一个独立问题——「模型重发的这次调用，是否可以消费某条已经
 * 人工批准的记录，且只消费一次」。两个动作必须成对：
 *
 * - `findResolvedByDigest`：模型重新发起的调用带的是**新 callId**，只能按
 *   「工具名 + 参数指纹」去找那条已批准的记录。指纹用 durable 侧的
 *   `integrityFingerprint`——账本存的就是它；拿策略层的 `digestArgs` 去查
 *   MySQL 永远查不到（2026-09-02 compose 实测：批准之后又停泊了一次，
 *   因为这一步查空、重新铸了 PENDING）。
 * - `consume`：在记录 started 的同一笔带围栏的事务里认领那条记录。这是
 *   一次性消费的 CAS，**必须在 DSH 派发工具体之前完成**。
 *
 * 三条 fail-closed 纪律：APPROVED 本身不是可复用的能力（关联的
 * ToolExecution 必须仍停在 `WAITING_APPROVAL`）；缺失或形状不对的参数指纹
 * 不是「历史兼容」，而是拒绝；参数指纹不一致一律拒绝。
 */
import { approvalIdOf } from '../runtime/policy/approval-id.js';
import { integrityFingerprint } from '../infrastructure/mysql/repositories/tool-execution-repository.js';

/** 过渡期宽松类型：仓储与记录器多数还是 JS 类，形状由各自模块负责。 */
type Loose = any;

/** SHA-256 十六进制。形状不对的指纹按缺失处理，不做「尽力而为」的比较。 */
const ARGS_INTEGRITY_RE = /^[0-9a-f]{64}$/i;

export interface ApprovedReplayClaimDeps {
  readonly tx: { run: <T>(fn: (trx: Loose) => Promise<T>) => Promise<T> };
  readonly createRepositories: (trx: Loose) => Loose;
  readonly runId: string;
  readonly scope: Loose;
  /** 治理记录器：`recordToolStarted` 就是认领所在的那笔事务。 */
  readonly recorder: { recordToolStarted: (input: Loose) => Promise<unknown> };
}

/** 指纹是否可用于比较——不可用时调用方必须重新要一次人工决定。 */
function usableIntegrity(value: unknown): value is string {
  return typeof value === 'string' && ARGS_INTEGRITY_RE.test(value);
}

/**
 * 构造 `GovernanceApprovalStore` 的 `findResolvedByDigest` / `consume` 实参。
 * 两者一起返回：分开接线过一次，结果是查得到、却没人认领。
 */
export function createApprovedReplayClaim(deps: ApprovedReplayClaimDeps) {
  const { tx, createRepositories, runId, scope, recorder } = deps;

  return {
    findResolvedByDigest: async (
      toolName: string,
      _digest: unknown,
      args: Record<string, unknown> | null | undefined,
    ) => {
      const found = await tx.run(async (trx: Loose) => {
        const repos = createRepositories(trx);
        const approvals = await repos.approvals.listByRunId(runId, scope);
        const wanted = integrityFingerprint(args ?? {});
        for (const approval of approvals) {
          if (String(approval.status).toUpperCase() !== 'APPROVED') continue;
          const exec = await repos.toolExecutions
            .getById(approval.toolExecutionId, scope)
            .catch(() => null);
          if (exec == null || exec.toolName !== toolName) continue;
          // 关联的 ToolExecution 必须还停在可认领的那一个状态。别的 Worker
          // 一旦把它推到 RUNNING 或终态，这条批准就不能再用——否则同一次
          // 人工批准会被消费两次。
          if (String(exec.status).toUpperCase() !== 'WAITING_APPROVAL') continue;
          if (!usableIntegrity(exec._argsIntegrity)) continue;
          if (exec._argsIntegrity !== wanted) continue;
          return { approval, exec };
        }
        return null;
      });
      if (found == null) return null;
      return {
        id: approvalIdOf(String(found.exec.toolCallId ?? '')),
        toolName,
        sourceDigest: found.exec._argsIntegrity,
        argsCanonical: JSON.stringify(args ?? {}),
        argsIntegrity: found.exec._argsIntegrity,
        durableApprovalId: found.approval.approvalId,
        toolExecutionId: found.exec.toolExecutionId,
        toolCallId: found.exec.toolCallId,
        status: 'APPROVED',
        runStatusHint: 'WAITING_APPROVAL',
      } as never;
    },

    consume: async (claim: Loose) => {
      const expected = claim.argsIntegrity;
      if (!usableIntegrity(expected)) {
        throw new Error('approved replay has no valid durable args integrity fingerprint');
      }
      if (integrityFingerprint(claim.args) !== expected) {
        throw new Error('approved replay args integrity mismatch');
      }
      await recorder.recordToolStarted({
        toolCallId: claim.toolCallId,
        toolName: claim.toolName,
        args: claim.args,
        approvalId: claim.approvalId,
      });
    },
  };
}
