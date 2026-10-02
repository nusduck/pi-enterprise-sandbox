import { useMemo } from 'react';
import { useChat } from '../../features/chat/ChatContext';
import { getArtifactDownloadUrl } from '../../shared/api';
import { downloadAttrName, safeApiUrl } from '../../shared/security/url';
import { isDurableArtifactId } from '../../shared/state/runReducer';
import { artifactDownloadId, deliveryBadge, listedNotShownAsCards } from '../turn-stream/artifactView';
import type { ArtifactEntity } from '../../entities/types';
import { IconDownload, IconFile } from '../../shared/ui/Icons';

function formatSize(n?: number | null): string {
  if (n == null || Number.isNaN(Number(n))) return '';
  const b = Number(n);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Deliverables strip — only explicit submit_artifact items.
 * Prefers EntityStore artifacts; falls back to session list API rows.
 */
export function DeliverablesPanel() {
  const { state, activeSessionId, entityStore, activeRunId } = useChat();

  const entityArtifacts = useMemo(() => {
    const runIds = new Set<string>();
    if (activeRunId) runIds.add(activeRunId);
    const convId = state.conversationId;
    if (convId) {
      for (const run of Object.values(entityStore.runsById)) {
        if (run.conversationId === convId) runIds.add(run.id);
      }
    }
    const seen = new Set<string>();
    const out: Array<{
      id: string;
      name: string;
      path: string | null;
      size: number | null;
      sessionId: string | null;
      reviewStatus: ArtifactEntity['reviewStatus'];
      reviewRevised: boolean;
      reviewFeedback: string | null;
      reviewReleasedId: string | null;
    }> = [];
    for (const art of Object.values(entityStore.artifactsById)) {
      if (art.source !== 'submit_artifact') continue;
      if (art.runId && !runIds.has(art.runId) && runIds.size > 0) continue;
      if (seen.has(art.id)) continue;
      seen.add(art.id);
      out.push({
        id: art.id,
        name: art.name,
        path: art.path,
        size: art.size,
        sessionId: art.sessionId,
        reviewStatus: art.reviewStatus,
        reviewRevised: art.reviewRevised,
        reviewFeedback: art.reviewFeedback,
        reviewReleasedId: art.reviewReleasedId,
      });
    }
    return out;
  }, [entityStore, activeRunId, state.conversationId]);

  const listed = listedNotShownAsCards(
    state.artifacts || [],
    entityArtifacts as unknown as ArtifactEntity[],
  );

  const total = entityArtifacts.length + listed.length;
  const hidden = total === 0 || !activeSessionId;

  if (hidden) {
    return (
      <div id="deliverables" className="deliverables" hidden>
        <div className="deliverables-head">
          <span className="deliverables-title">交付物</span>
          <span className="deliverables-count" id="deliverables-count">
            0
          </span>
        </div>
        <div className="deliverables-list" id="deliverables-list" />
      </div>
    );
  }

  return (
    <div id="deliverables" className="deliverables">
      <div className="deliverables-head">
        <IconFile size={14} className="deliverables-icon" />
        <span className="deliverables-title">交付物</span>
        <span className="deliverables-count" id="deliverables-count">
          {total}
        </span>
      </div>
      <div className="deliverables-list" id="deliverables-list">
        {entityArtifacts.map((a) => {
          const sid = a.sessionId || activeSessionId;
          if (!sid || !a.id || !isDurableArtifactId(a.id, activeRunId || '')) {
            return null;
          }
          // 待审 / 驳回的交付物不是链接（design §8）：显示状态而不是一个必然 404
          // 的下载入口。`reviewStatus` 为 null 的是 direct 会话，行为不变。
          if (a.reviewStatus === 'pending' || a.reviewStatus === 'rejected') {
            const badge = deliveryBadge(a as unknown as ArtifactEntity);
            return (
              <span
                key={a.id}
                className="artifact-chip artifact-chip-held"
                title={badge || a.name}
                data-source="submit_artifact"
                data-review-status={a.reviewStatus}
              >
                <span className="artifact-chip-name">{a.name}</span>
                {badge ? <span className="chip-size">{badge}</span> : null}
              </span>
            );
          }
          const url = getArtifactDownloadUrl(sid, artifactDownloadId(a as unknown as ArtifactEntity));
          const safe = safeApiUrl(url);
          if (!safe) return null;
          // 修订版的大小不在卡片实体上（实体记的是原件）：改为标注「经审核员修订」。
          const size = a.reviewRevised ? '经审核员修订' : formatSize(a.size);
          return (
            <a
              key={a.id}
              className="artifact-chip"
              href={safe}
              download={downloadAttrName(a.name, a.path)}
              title={a.path || a.name}
              data-source="submit_artifact"
            >
              <IconDownload size={13} />
              <span className="artifact-chip-name">{a.name}</span>
              {size ? <span className="chip-size">{size}</span> : null}
            </a>
          );
        })}
        {listed.map((a) => {
          const id = a.artifact_id || a.id;
          const name = a.name || a.path || id || 'file';
          if (!id || !activeSessionId || !isDurableArtifactId(String(id), activeRunId || '')) {
            return null;
          }
          const url = getArtifactDownloadUrl(activeSessionId, String(id));
          const safe = safeApiUrl(url);
          if (!safe) return null;
          const size = formatSize(a.size as number | undefined);
          return (
            <a
              key={String(id)}
              className="artifact-chip"
              href={safe}
              download={downloadAttrName(name, a.path)}
              title={a.path || String(name)}
              data-source="submit_artifact"
            >
              <IconDownload size={13} />
              <span className="artifact-chip-name">{String(name)}</span>
              {size ? <span className="chip-size">{size}</span> : null}
            </a>
          );
        })}
      </div>
    </div>
  );
}
