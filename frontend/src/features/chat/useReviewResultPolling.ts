/**
 * 审核结果轮询的 React 接线（T1 / 返工单 R2、R3）。
 *
 * 纯状态机在 `reviewResultPolling.ts`（可直接单测）；这里只负责把它接到 `document` 的
 * `visibilitychange` 与 `entityBridge.pollReviewDecisions` 上。放在独立文件里还有一个原因：
 * `ChatContext.tsx` 是行数棘轮上的热点文件（`tests/test_repository_layout.py`），只能减不能增。
 */
import { useEffect, useMemo } from 'react';
import type { EntityBridge } from './entityBridge';
import type { EntityStore } from '../../entities';
import { createReviewResultPoller, hasPendingReviewArtifact } from './reviewResultPolling';

const isDocumentVisible = () =>
  typeof document === 'undefined' || document.visibilityState === 'visible';

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
    // 只要还有待审交付物就装监听——**不能**因为此刻不可见就整体 return（R2 的根因）。
    if (!conversationId || !pending) return;

    const poller = createReviewResultPoller({
      poll: () => {
        void bridge.pollReviewDecisions(conversationId).catch(() => {
          /* 轮询失败不打扰用户：下一次照常重试，SSE 与手动刷新仍是主路径。 */
        });
      },
      isVisible: isDocumentVisible,
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (handle) => clearInterval(handle),
    });

    poller.start();
    document.addEventListener('visibilitychange', poller.onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', poller.onVisibilityChange);
      poller.dispose();
    };
  }, [bridge, pending, conversationId]);
}
