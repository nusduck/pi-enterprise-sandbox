import { useEffect, useRef, useState } from 'react';
import { listArtifacts } from '../../shared/api/client';
import type { Artifact, Conversation } from '../../shared/schemas/api';
import { conversationTitle } from '../../shared/state';
import s from './composer.module.css';

type Row = { id: string; name: string; mime: string | null; size: number | null };

function toRow(a: Artifact): Row | null {
  const raw = a as unknown as Record<string, unknown>;
  const id = String(raw.artifact_id || raw.id || '').trim();
  if (!id) return null;
  return {
    id,
    name: String(raw.name || raw.path || id),
    mime: typeof raw.mime_type === 'string' ? raw.mime_type : null,
    size: typeof raw.size === 'number' ? raw.size : null,
  };
}

/**
 * Pick artifacts from another conversation and copy them into this one
 * (POST /api/conversations/{id}/artifact-imports). The API lists artifacts per
 * sandbox session only, so the dialog is conversation first, then artifacts.
 */
export function ImportArtifactDialog({
  open,
  onClose,
  conversations,
  currentConversationId,
  onImport,
}: {
  open: boolean;
  onClose: () => void;
  conversations: Conversation[];
  currentConversationId: string;
  onImport: (artifactId: string, targetConversationId: string) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [source, setSource] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const candidates = conversations.filter((c) => c.id !== currentConversationId && c.sandbox_session_id);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setPicked(new Set());
    const conv = candidates.find((c) => c.id === source);
    if (!conv?.sandbox_session_id) {
      setRows(null);
      return;
    }
    let stale = false;
    setRows(null);
    setError(null);
    listArtifacts(conv.sandbox_session_id)
      .then((res) => {
        if (!stale) setRows(res.artifacts.map(toRow).filter((r): r is Row => r != null));
      })
      .catch((err: Error) => {
        if (!stale) setError(err.message || '读取产物失败');
      });
    return () => {
      stale = true;
    };
    // candidates is derived from conversations; only a new pick re-fetches.
  }, [open, source]);

  async function submit() {
    setBusy(true);
    try {
      for (const id of picked) await onImport(id, currentConversationId);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className={s.dialog} onClose={onClose} aria-label="引用其他会话的产物">
      <div className={s.dlgHead}>
        <b>引用其他会话的产物</b>
        <button type="button" className={s.btn} onClick={onClose}>关闭</button>
      </div>
      <div className={s.imp}>
        <div className={s.impList} role="listbox" aria-label="来源会话">
          {candidates.length === 0 ? <p className={s.muted}>没有其他会话</p> : null}
          {candidates.map((c) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={c.id === source}
              className={c.id === source ? s.impCur : undefined}
              onClick={() => setSource(c.id)}
            >
              {conversationTitle(c)}
            </button>
          ))}
        </div>
        <div className={s.impArts}>
          {!source ? <p className={s.muted}>先在左侧选择一个会话</p> : null}
          {source && !rows && !error ? <p className={s.muted}>正在读取…</p> : null}
          {error ? <p className={s.err}>{error}</p> : null}
          {rows && rows.length === 0 ? <p className={s.muted}>这个会话没有产物</p> : null}
          {rows?.map((r) => (
            <label key={r.id} className={`${s.impRow}${picked.has(r.id) ? ` ${s.impPicked}` : ''}`}>
              <input
                type="checkbox"
                checked={picked.has(r.id)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(r.id);
                  else next.delete(r.id);
                  setPicked(next);
                }}
              />
              <span className={s.attName}>{r.name}</span>
              <small className={s.muted}>{r.mime || ''}</small>
            </label>
          ))}
        </div>
      </div>
      <div className={s.dlgFoot}>
        <span className={s.muted}>产物会复制到当前会话的工作区，作为附件随下一条消息发送。</span>
        <span className={s.sp} />
        <button type="button" className={s.btn} onClick={onClose}>取消</button>
        <button type="button" className={s.btnPri} disabled={!picked.size || busy} onClick={() => void submit()}>
          引用 {picked.size || ''} 个
        </button>
      </div>
    </dialog>
  );
}
