/**
 * 同一 Agent Session 的顶层 Run 按提交顺序依次执行（plan §12：Run 执行期间用户再发的消息
 * 「创建 follow-up message，等待当前 Run 完成后自动执行」）。
 *
 * Worker 取到作业、执行之前问一次 {@link SessionTurnGate}：需要等就把作业原样放回 delayed，
 * Run 保持 QUEUED、不消耗 attempts。此前没有这一步，follow-up 进执行器后拿不到 session 锁，
 * 立即以 `FAILED / session lock busy` 结束（2026-09-18 K8s 演练发现，单副本同样复现）。
 *
 * 需要等待的只有两种情况，别的一概放行（与此前行为一致）：
 * - session 锁被占：前一个 Run 仍在执行（锁随执行续约），或崩溃后残留的锁还没过期；
 * - 同会话里有更早、仍在排队（ACCEPTED / QUEUED / RETRYING）的顶层 Run：保证排队的 follow-up 先来先执行。
 * 不等 WAITING_* 挂起的 Run，也不等已失去锁的孤儿 RUNNING——那样会让会话无限期卡住。
 * 子代理 Run（有 parent_run_id）不参与：父 Run 执行时子 Run 必须能跑，否则互相等待。
 *
 * 执行器里「拿不到锁即 FAILED」仍保留为兜底：判定与加锁之间仍有极窄的竞争窗口。
 */
import { RUN_STATUS } from '../domain/run/run-status.js';

const WAITING_FOR_TURN = [RUN_STATUS.ACCEPTED, RUN_STATUS.QUEUED, RUN_STATUS.RETRYING];
const QUEUED_AHEAD = [RUN_STATUS.ACCEPTED, RUN_STATUS.QUEUED, RUN_STATUS.RETRYING];

export type SessionTurnGate = (ref: { runId: string; orgId: string }) => Promise<boolean>;

export function createSessionTurnGate(deps: {
  db: import('knex').Knex;
  sessionLockOwner: (agentSessionId: string) => Promise<string | null>;
}): SessionTurnGate {
  return async function mustWait(ref) {
    const run = await deps
      .db('tbl_agsvc_runs')
      .select('agent_session_id', 'created_at', 'status', 'parent_run_id')
      .where({ run_id: ref.runId, org_id: ref.orgId })
      .first();
    if (!run || run.parent_run_id != null || !WAITING_FOR_TURN.includes(run.status)) {
      return false;
    }
    if ((await deps.sessionLockOwner(run.agent_session_id)) != null) return true;
    const ahead = await deps
      .db('tbl_agsvc_runs')
      .first('run_id')
      .where({ agent_session_id: run.agent_session_id })
      .whereNull('parent_run_id')
      .whereIn('status', QUEUED_AHEAD)
      .whereNot('run_id', ref.runId)
      .andWhere((q) =>
        q
          .where('created_at', '<', run.created_at)
          .orWhere((same) => same.where('created_at', run.created_at).andWhere('run_id', '<', ref.runId)),
      );
    return Boolean(ahead);
  };
}
