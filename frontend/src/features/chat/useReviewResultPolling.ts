/**
 * 审核结果轮询的 React 接线（T1）。
 *
 * 纯判定在 `reviewResultPolling.ts`（可直接单测）；这里只负责计时器与
 * `visibilitychange` 的生命周期。放在独立文件里还有一个原因：`ChatContext.tsx` 是
 * 行数棘轮上的热点文件（`tests/test_repository_layout.py`），只能减不能增。
 */
import { useEffect, useMemo } from 'react';
import type { EntityBridge } from './entityBridge';
import type { EntityStore } from '../../entities';
import {
  REVIEW_RESULT_POLL_MS,
  hasPendingReviewArtifact,
  shouldPollReviewResults,
} from './reviewResultPolling';

export function useReviewResultPolling(
  bridge: EntityBridge,
  entityStore: EntityStore,
  conversationId: string | null | undefined,
): void {
  const pending = useMemo(
    () => hasPendingReviewArtifact(entityStore, conversationId),
    [entityStore, conversationId],
  );

  useEffect(() => {
    if (!conversationId) return;
    const visible = () =>
      typeof document === 'undefined' || document.visibilityState === 'visible';
    if (!shouldPollReviewResults({ pending, visible: visible() })) return;

    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const start = () => {
      if (stopped || timer !== null) return;
      timer = setInterval(() => {
        // 隐藏标签页不发请求；重新可见时由 visibilitychange 重启。
        if (!visible()) return;
        void bridge.rehydrateConversation(conversationId).catch(() => {
          /* 轮询失败不打扰用户：下一次照常重试，SSE 与手动刷新仍是主路径。 */
        });
      }, REVIEW_RESULT_POLL_MS);
    };
    const onVisibilityChange = () => {
      if (visible()) start();
      else stop();
    };

    start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stopped = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [bridge, pending, conversationId]);
}
