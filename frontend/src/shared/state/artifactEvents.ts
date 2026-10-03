/**
 * artifact.* / review.* branch of the unified reducer (split out of
 * runReducer.ts, which is pinned by the layout ratchet).
 */
import type { EntityStore } from '../../entities/types';
import {
  createArtifact,
  createTraceSpan,
  upsertArtifact,
  upsertTraceSpan,
} from '../../entities/store';
import type { RuntimeEvent } from '../schemas/events';

function str(v: unknown, fallback = ''): string {
  if (v == null) return fallback;
  return String(v);
}

/**
 * 审核决定（通过 / 驳回）落到交付物实体上。
 *
 * 事件负载里的 `artifacts[]` 是服务端认定的**当前版本**（`revised` 表示它是审核员
 * 改过的版本）。只更新已经存在的实体：一个从没见过 `artifact.created` 的 id 不该
 * 因为审核事件凭空冒出一张卡片（那会是一张下载必然 404 的卡片）。
 */
function applyReviewDecision(
  store: EntityStore,
  payload: Record<string, unknown>,
  state: 'released' | 'rejected',
): EntityStore {
  const list = Array.isArray(payload.artifacts) ? payload.artifacts : [];
  const feedback = state === 'rejected' ? str(payload.feedback) || null : null;
  let next = store;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const artifactId = str(row.artifact_id || row.artifactId);
    // 聊天卡片的 id 是智能体提交的原件；审核员修订过时，当前版本是另一个 id，按原件 id 对上。
    const originalId = str(row.original_artifact_id || row.originalArtifactId);
    const existing =
      (artifactId ? next.artifactsById[artifactId] : undefined) ??
      (originalId ? next.artifactsById[originalId] : undefined);
    if (!existing) continue;
    const size = Number(row.size ?? row.size_bytes);
    next = upsertArtifact(next, {
      ...existing,
      reviewStatus: state,
      reviewRevised: state === 'released' ? row.revised === true : false,
      reviewFeedback: feedback,
      reviewReleasedId: state === 'released' && artifactId ? artifactId : null,
      // 卡片要显示**放行版本**的大小：有修订时那是修订版，不是原件（§3.3.1）。
      ...(state === 'released' && Number.isFinite(size) && size >= 0 ? { size } : {}),
    });
  }
  return next;
}

/**
 * Durable submit_artifact id (server-issued). Reject adapter/path synth ids
 * so missing artifact_id never becomes a downloadable Workspace path card.
 */
export function isDurableArtifactId(
  artifactId: string | null | undefined,
  runId: string,
): boolean {
  if (artifactId == null) return false;
  const id = String(artifactId).trim();
  if (!id) return false;
  // Client-side placeholders are never durable server artifacts.
  if (id.startsWith('synth_') || id.startsWith('local_')) return false;
  return true;
}

export function reduceArtifactEvent(
  store: EntityStore,
  ev: RuntimeEvent,
  payload: Record<string, unknown>,
  ts: string | null,
): EntityStore {
  const runId = ev.run_id;
  let next = store;

  switch (ev.type) {
    case 'artifact.released': {
      // 审核通过：交付物放行。**挂在原 Run 上**（design §5.3），所以刷新后靠会话
      // 事件重放也能拿到；`revised` 为真表示这一版是审核员改过的。
      next = applyReviewDecision(next, payload, 'released');
      break;
    }

    case 'review.rejected': {
      next = applyReviewDecision(next, payload, 'rejected');
      break;
    }

    case 'artifact.created': {
      // Only durable server artifact_id from submit_artifact / artifact.ready.
      // Missing id → still advance event cursor below, but never create a
      // downloadable Artifact (no workspace path fallback).
      const artifactId = str(payload.artifact_id || payload.id);
      if (!isDurableArtifactId(artifactId, runId)) {
        break;
      }
      const existing = next.artifactsById[artifactId];
      next = upsertArtifact(
        next,
        createArtifact({
          id: artifactId,
          runId,
          sessionId:
            str(ev.session_id) ||
            str(payload.session_id) ||
            next.runsById[runId]?.sandboxSessionId ||
            existing?.sessionId ||
            null,
          name: str(payload.name, existing?.name || artifactId),
          path:
            payload.path != null
              ? str(payload.path)
              : existing?.path ?? null,
          mimeType:
            payload.mime_type != null
              ? str(payload.mime_type)
              : payload.mimeType != null
                ? str(payload.mimeType)
                : existing?.mimeType ?? null,
          size:
            typeof payload.size === 'number'
              ? payload.size
              : existing?.size ?? null,
          sha256:
            payload.sha256 != null
              ? str(payload.sha256)
              : existing?.sha256 ?? null,
          description:
            payload.description != null
              ? str(payload.description)
              : existing?.description ?? null,
          source: 'submit_artifact',
          // A1：review 会话的交付物带 `review_status: "pending"`。direct 会话没有
          // 这个键，保持 `null`（不显示任何审核字样）。
          reviewStatus:
            payload.review_status === 'pending'
              ? 'pending'
              : existing?.reviewStatus ?? null,
          createdAt: existing?.createdAt || ts,
        }),
      );
      next = upsertTraceSpan(
        next,
        createTraceSpan({
          id: `artspan_${artifactId}`,
          runId,
          parentId: null,
          kind: 'artifact',
          name: str(payload.name, artifactId),
          status: 'ok',
          startedAt: ts,
          finishedAt: ts,
          metadata: { artifactId },
        }),
      );
      break;
    }

    default:
      break;
  }

  return next;
}
