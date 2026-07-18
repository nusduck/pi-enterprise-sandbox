import { useMemo } from 'react';
import { useChat } from '../../features/chat/ChatContext';
import { getArtifactDownloadUrl } from '../../shared/api';
import { safeApiUrl } from '../../shared/security/url';
import { isDurableArtifactId } from '../../shared/state/runReducer';

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
      });
    }
    return out;
  }, [entityStore, activeRunId, state.conversationId]);

  // API list is already sandbox artifact register (submit path); de-dupe by id.
  const listed = (state.artifacts || []).filter((a) => {
    const id = a.artifact_id || a.id;
    if (!id) return false;
    return !entityArtifacts.some((e) => e.id === id);
  });

  const total = entityArtifacts.length + listed.length;
  const hidden = total === 0 || !activeSessionId;

  if (hidden) {
    return (
      <div id="deliverables" className="deliverables" hidden>
        <div className="deliverables-head">
          <span className="deliverables-title">Deliverables</span>
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
        <span className="deliverables-title">Deliverables</span>
        <span className="deliverables-count" id="deliverables-count">
          {total}
        </span>
      </div>
      <div className="deliverables-list" id="deliverables-list">
        {entityArtifacts.map((a) => {
          const sid = a.sessionId || activeSessionId;
          // Strict: durable artifact_id only — never workspace path download.
          if (!sid || !a.id || !isDurableArtifactId(a.id, activeRunId || '')) {
            return null;
          }
          const url = getArtifactDownloadUrl(sid, a.id);
          const safe = safeApiUrl(url);
          if (!safe) return null;
          const size = formatSize(a.size);
          return (
            <a
              key={a.id}
              className="artifact-chip"
              href={safe}
              download=""
              title={a.path || a.name}
              data-source="submit_artifact"
            >
              ⬇ {a.name}
              {size ? <span className="chip-size"> {size}</span> : null}
            </a>
          );
        })}
        {listed.map((a) => {
          const id = a.artifact_id || a.id;
          const name = a.name || a.path || id || 'file';
          // Strict: durable artifact_id only — never workspace path download.
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
              download=""
              title={a.path || String(name)}
              data-source="submit_artifact"
            >
              ⬇ {String(name)}
              {size ? <span className="chip-size"> {size}</span> : null}
            </a>
          );
        })}
      </div>
    </div>
  );
}
