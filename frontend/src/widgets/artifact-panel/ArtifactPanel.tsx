/**
 * Artifact Panel (plan §19.8) — only submit_artifact deliverables.
 * Downloads go through getArtifactDownloadUrl(sessionId, artifactId) — an
 * artifact id, never a workspace path.
 */
import { useMemo, useState } from 'react';
import type { ArtifactEntity } from '../../entities';
import { getArtifactDownloadUrl } from '../../shared/api';
import { downloadAttrName, safeApiUrl } from '../../shared/security/url';
import { fileTypeLabel } from '../../shared/state';
import { isDurableArtifactId } from '../../shared/state/runReducer';

function formatSize(n?: number | null): string {
  if (n == null || Number.isNaN(Number(n))) return '';
  const b = Number(n);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value?: string | null): string {
  if (!value || Number.isNaN(Date.parse(value))) return '';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatMime(value?: string | null): string {
  if (!value || value === 'application/octet-stream') return 'File';
  const subtype = value.split('/').pop() || value;
  return subtype
    .replace(/^vnd\.[^.]+\./, '')
    .replace(/[.+-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function ArtifactPanel({
  artifacts,
  sessionId,
  selectedId,
  onSelect,
  /** When true, hide path-only workspace leftovers (default true). */
  submitOnly = true,
  emptyHint = 'No submitted artifacts yet. Only submit_artifact deliverables appear here.',
  conversations = [],
  currentConversationId = null,
  onImport,
}: {
  artifacts: ArtifactEntity[];
  sessionId?: string | null;
  selectedId?: string | null;
  onSelect?: (artifactId: string) => void;
  submitOnly?: boolean;
  emptyHint?: string;
  conversations?: Array<{ id: string; title?: string | null }>;
  currentConversationId?: string | null;
  onImport?: (
    artifactId: string,
    targetConversationId: string,
    targetFilename?: string | null,
  ) => Promise<void>;
}) {
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [importingId, setImportingId] = useState<string | null>(null);
  const [importError, setImportError] = useState<Record<string, string>>({});
  const importTargets = useMemo(
    () => conversations.filter((c) => c.id !== currentConversationId),
    [conversations, currentConversationId],
  );
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
        const created = formatDate(a.createdAt);
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
            <div className="artifact-card-head">
              <span className="file-type-tile artifact-file-tile" aria-hidden="true">
                {fileTypeLabel(a.name, a.mimeType)}
              </span>
              <span className="artifact-card-copy">
                <span className="artifact-card-name" title={a.path || a.name}>
                  {a.name}
                </span>
                <span className="artifact-card-meta">
                  {[formatMime(a.mimeType), size, created].filter(Boolean).join(' · ')}
                </span>
              </span>
            </div>
            {a.description ? (
              <p className="artifact-description">{a.description}</p>
            ) : null}
            <div className="artifact-card-actions">
              {safe ? (
                <a
                  className="rtc-link-btn artifact-download-btn"
                  href={safe}
                  download={downloadAttrName(a.name)}
                  onClick={(e) => e.stopPropagation()}
                >
                  <span aria-hidden="true">↓</span>
                  Download
                </a>
              ) : (
                <span className="rtc-muted">Download unavailable</span>
              )}
              {a.sha256 || a.runId ? (
                <details
                  className="artifact-technical"
                  onClick={(e) => e.stopPropagation()}
                >
                  <summary>Details</summary>
                  <div className="artifact-technical-body">
                    {a.runId ? (
                      <span title={a.runId}>Run {a.runId.slice(0, 12)}…</span>
                    ) : null}
                    {a.sha256 ? (
                      <span className="mono" title={a.sha256}>
                        SHA-256 {a.sha256.slice(0, 16)}…
                      </span>
                    ) : null}
                  </div>
                </details>
              ) : null}
            </div>
            {onImport ? (
              <details
                className="artifact-import"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <summary>Import to another conversation</summary>
                {importTargets.length ? (
                  <div className="artifact-import-controls">
                    <select
                      aria-label={`Target conversation for ${a.name}`}
                      value={targets[a.id] || ''}
                      disabled={importingId === a.id}
                      onChange={(e) =>
                        setTargets((current) => ({
                          ...current,
                          [a.id]: e.target.value,
                        }))
                      }
                    >
                      <option value="">Import to conversation…</option>
                      {importTargets.map((conversation) => (
                        <option key={conversation.id} value={conversation.id}>
                          {conversation.title?.trim() ||
                            `Conversation ${conversation.id.slice(0, 10)}…`}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="rtc-link-btn"
                      disabled={!targets[a.id] || importingId === a.id}
                      onClick={async () => {
                        const target = targets[a.id];
                        if (!target) return;
                        setImportingId(a.id);
                        setImportError((current) => ({ ...current, [a.id]: '' }));
                        try {
                          await onImport(a.id, target, a.name);
                        } catch (err) {
                          setImportError((current) => ({
                            ...current,
                            [a.id]: (err as Error).message || 'Import failed',
                          }));
                        } finally {
                          setImportingId(null);
                        }
                      }}
                    >
                      {importingId === a.id ? 'Importing…' : 'Import'}
                    </button>
                  </div>
                ) : (
                  <div className="row-sub muted">
                    Open or create another conversation to import this artifact.
                  </div>
                )}
              </details>
            ) : null}
            {importError[a.id] ? (
              <div className="row-sub danger" role="alert">
                {importError[a.id]}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
