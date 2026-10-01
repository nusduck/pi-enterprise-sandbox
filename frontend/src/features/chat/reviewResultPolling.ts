/**
 * 审核结果的到达通道（T1，design `docs/design/agent-output-review.md` §4 A2）。
 *
 * **问题**：`artifact.released` / `review.rejected` 是审核员在 Run **结束之后**才追加到
 * 那个 Run 上的；而 Run 一到终态，后端就结束 SSE 推流，前端
 * （`shared/api/runs.ts` 的 `streamRunEvents`）也停止订阅。发起人页面因此收不到审核结果，
 * 手动刷新才看得到——刷新走的是 `GET /api/conversations/{id}/events` 的完整时间线重放。
 *
 * **做法**（不改后端）：当前会话里还有 `reviewStatus === 'pending'` 的交付物、并且页面可见
 * 时，定时重新拉一次会话事件，交给已有的重放与去重逻辑（按 `event_id` / `sequence`）。
 * 没有待审交付物就停止，切换会话/离开页面时清理定时器。
 *
 * 这里只放**纯逻辑**（能不能轮询、轮询周期），计时器由 React 层持有，便于单测。
 */
import type { EntityStore } from '../../entities/types';

/** 轮询周期：任务单要求 15–30 秒，取 20 秒（审核通常以分钟计，不必更密）。 */
export const REVIEW_RESULT_POLL_MS = 20_000;

/**
 * 当前会话里是否还有待审交付物。
 *
 * 交付物按 `runId` 归属，Run 再归属会话——`ArtifactEntity` 本身没有 `conversationId`。
 */
export function hasPendingReviewArtifact(
  store: EntityStore,
  conversationId: string | null | undefined,
): boolean {
  if (!conversationId) return false;
  for (const artifact of Object.values(store.artifactsById || {})) {
    if (artifact.reviewStatus !== 'pending') continue;
    const run = artifact.runId ? store.runsById?.[artifact.runId] : null;
    if (run?.conversationId === conversationId) return true;
  }
  return false;
}

/** 是否该起轮询：有待审交付物**且**页面可见（隐藏标签页不发请求）。 */
export function shouldPollReviewResults(input: {
  pending: boolean;
  visible: boolean;
}): boolean {
  return input.pending && input.visible;
}
