/**
 * 审核结果的到达通道（T1，design `docs/design/agent-output-review.md` §4 A2）。
 *
 * **问题**：`artifact.released` / `review.rejected` 是审核员在 Run **结束之后**才追加到
 * 那个 Run 上的；而 Run 一到终态，后端就结束 SSE 推流，前端
 * （`shared/api/runs.ts` 的 `streamRunEvents`）也停止订阅。发起人页面因此收不到审核结果，
 * 手动刷新才看得到——刷新走的是 `GET /api/conversations/{id}/events` 的完整时间线重放。
 *
 * **做法**（不改后端）：当前会话里还有 `reviewStatus === 'pending'` 的交付物时定时轮询。
 * 轮询本身走 `entityBridge.pollReviewDecisions`（只拉会话事件、只归约两类审核结果事件，
 * 返工单 R3）。
 *
 * 这里放**纯逻辑**（能不能轮询、周期、可见性状态迁移），React 层只负责把计时器与
 * `document` 接上，便于单测。
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

export interface ReviewResultPollerDeps {
  /** 一次轮询（调用方负责吞掉错误）。 */
  poll: () => void;
  isVisible: () => boolean;
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (handle: ReturnType<typeof setInterval>) => void;
}

/**
 * 轮询的可见性状态机（返工单 R2）。
 *
 * **关键**：只要还有待审交付物，`visibilitychange` 监听就必须装上——不能因为「此刻不可见」
 * 就整体不注册。否则「发起任务 → 切到别的标签页 → Run 在后台结束、pending 变真 → 切回来」
 * 这条最常见的路径永远不会开始轮询（上次就是这个 bug）。
 *
 * 状态迁移：
 * - `start()`：可见才排定时器，并**立即拉一次**（切回前台不用等满一个周期）；不可见时只
 *   返回，等 `onVisibilityChange` 再调；
 * - `onVisibilityChange()`：可见 → `start()`；不可见 → `stop()`；
 * - `dispose()`：停表并禁止再次启动。
 */
export function createReviewResultPoller(deps: ReviewResultPollerDeps) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function stop(): void {
    if (timer !== null) {
      deps.clearInterval(timer);
      timer = null;
    }
  }

  function start(): void {
    if (stopped || timer !== null) return;
    if (!deps.isVisible()) return;
    deps.poll();
    timer = deps.setInterval(() => {
      if (deps.isVisible()) deps.poll();
    }, REVIEW_RESULT_POLL_MS);
  }

  function onVisibilityChange(): void {
    if (deps.isVisible()) start();
    else stop();
  }

  function dispose(): void {
    stopped = true;
    stop();
  }

  return { start, stop, onVisibilityChange, dispose };
}
