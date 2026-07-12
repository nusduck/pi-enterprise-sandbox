import { useChat } from '../../features/chat/ChatContext';
import {
  getArtifactDownloadUrl,
  getDownloadUrl,
} from '../../shared/api';
import { safeApiUrl } from '../../shared/security/url';

function formatSize(n?: number | null): string {
  if (n == null || Number.isNaN(Number(n))) return '';
  const b = Number(n);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export function DeliverablesPanel() {
  const { state } = useChat();
  const artifacts = state.artifacts || [];
  const hidden = !artifacts.length || !state.sessionId;

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
          {artifacts.length}
        </span>
      </div>
      <div className="deliverables-list" id="deliverables-list">
        {artifacts.map((a) => {
          const id = a.artifact_id || a.id;
          const name = a.name || a.path || id || 'file';
          let url: string | null = null;
          if (id && state.sessionId) {
            url = getArtifactDownloadUrl(state.sessionId, id);
          } else if (a.path && state.sessionId) {
            url = getDownloadUrl(state.sessionId, a.path);
          }
          const safe = safeApiUrl(url);
          if (!safe) return null;
          const size = formatSize(a.size as number | undefined);
          return (
            <a
              key={String(id || a.path)}
              className="artifact-chip"
              href={safe}
              download=""
              title={a.path || String(name)}
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
