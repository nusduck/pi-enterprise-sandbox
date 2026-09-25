import { useEffect, useMemo } from 'react';
import type { AttachmentDraft } from '../../shared/state';
import { fileTypeLabel } from '../../shared/state';
import { IconClose, IconRefresh } from '../../shared/ui/Icons';
import s from './composer.module.css';

function formatSize(n?: number | null): string {
  if (n == null || !Number.isFinite(Number(n)) || Number(n) <= 0) return '';
  const b = Number(n);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function isPreviewableImage(a: AttachmentDraft): a is AttachmentDraft & { file: Blob } {
  return a.file instanceof Blob && /^image\/(png|jpe?g|gif|webp|bmp)$/.test(a.mimeType || a.file.type);
}

/** Local blob previews for image drafts; revoked when the draft goes away. */
function usePreviews(attachments: AttachmentDraft[]): Map<string, string> {
  const previews = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of attachments) {
      if (isPreviewableImage(a)) map.set(a.localId, URL.createObjectURL(a.file));
    }
    return map;
  }, [attachments]);
  useEffect(() => () => previews.forEach((url) => URL.revokeObjectURL(url)), [previews]);
  return previews;
}

export function AttachmentChips({
  attachments,
  onRemove,
  onRetry,
}: {
  attachments: AttachmentDraft[];
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}) {
  const previews = usePreviews(attachments);
  if (!attachments.length) return null;
  return (
    <div id="attachment-drafts" className={s.atts} aria-live="polite">
      {attachments.map((a) => {
        const busy = a.status === 'uploading' || a.status === 'queued';
        const preview = previews.get(a.localId);
        const imported = a.idempotencyKey.startsWith('artifact_import_');
        return (
          <div key={a.localId} className={`${s.att}${a.status === 'failed' ? ` ${s.attFailed}` : ''}`} data-local-id={a.localId}>
            <span className={s.mini} aria-hidden="true">
              {preview ? <img src={preview} alt="" /> : a.status === 'failed' ? '!' : fileTypeLabel(a.name, a.mimeType)}
            </span>
            <span className={s.attText}>
              <span className={s.attName} title={a.path || a.name}>{a.name || '文件'}</span>
              <small title={a.error || undefined}>
                {a.status === 'failed'
                  ? a.error || '上传失败'
                  : busy
                    ? a.status === 'queued' ? '等待上传' : '上传中…'
                    : imported ? '引用自其他会话' : formatSize(a.size) || '已就绪'}
              </small>
              {busy ? <span className={s.prog}><i /></span> : null}
            </span>
            {a.status === 'failed' ? (
              <button type="button" className={s.attBtn} aria-label={`重试 ${a.name}`} title="重试" onClick={() => onRetry(a.localId)}>
                <IconRefresh size={13} />
              </button>
            ) : null}
            <button type="button" className={s.attBtn} aria-label={`移除 ${a.name}`} title="移除" onClick={() => onRemove(a.localId)}>
              <IconClose size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
