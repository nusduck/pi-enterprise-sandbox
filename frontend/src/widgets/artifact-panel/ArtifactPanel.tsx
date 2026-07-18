/**
 * Artifact Panel (plan §19.8) — only submit_artifact deliverables.
 * Downloads use getArtifactDownloadUrl(sessionId, artifactId) only —
 * never workspace path getDownloadUrl.
 */
import type { ArtifactEntity } from '../../entities';
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

export function ArtifactPanel({
  artifacts,
  sessionId,
  selectedId,
  onSelect,
  /** When true, hide path-only workspace leftovers (default true). */
  submitOnly = true,
  emptyHint = 'No submitted artifacts yet. Only submit_artifact deliverables appear here.',
}: {
  artifacts: ArtifactEntity[];
  sessionId?: string | null;
  selectedId?: string | null;
  onSelect?: (artifactId: string) => void;
  submitOnly?: boolean;
  emptyHint?: string;
}) {
  const rows = (submitOnly
    ? artifacts.filter((a) => a.source === 'submit_artifact')
    : artifacts
  ).filter((a) => isDurableArtifactId(a.id, a.runId || ''));

  if (!rows.length) {
    return <p className="inspector-empty">{emptyHint}</p>;
  }

  return (
    <ul className="inspector-list cards artifact-panel" aria-label="Artifacts">
      {rows.map((a) => {
        const sid = sessionId || a.sessionId;
        // Strict: only durable artifact_id download — no path fallback.
        const url =
          sid && a.id ? getArtifactDownloadUrl(sid, a.id) : null;
        const safe = safeApiUrl(url);
        const size = formatSize(a.size);
        return (
          <li
            key={a.id}
            className={`inspector-row rtc-card rtc-artifact${selectedId === a.id ? ' selected' : ''}`}
            data-artifact-id={a.id}
            data-source={a.source}
            onClick={() => onSelect?.(a.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect?.(a.id);
              }
            }}
            role={onSelect ? 'button' : undefined}
            tabIndex={onSelect ? 0 : undefined}
          >
            <div className="row-title" title={a.path || a.name}>
              {a.name}
            </div>
            <div className="row-meta">
              {a.mimeType || 'file'}
              {size ? ` · ${size}` : ''}
              {a.runId ? ` · run ${a.runId.slice(0, 10)}…` : ''}
            </div>
            {a.description ? (
              <div className="row-sub">{a.description}</div>
            ) : null}
            {a.sha256 ? (
              <div className="row-sub mono muted">sha256 {a.sha256.slice(0, 16)}…</div>
            ) : null}
            {a.createdAt ? (
              <div className="row-meta muted">{a.createdAt}</div>
            ) : null}
            {safe ? (
              <a
                className="rtc-link-btn"
                href={safe}
                download=""
                onClick={(e) => e.stopPropagation()}
              >
                Download
              </a>
            ) : (
              <span className="rtc-muted">No download URL</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
