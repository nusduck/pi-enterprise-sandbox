import { useEffect, useMemo, useRef, useState } from 'react';
import { listLibraryArtifacts, formatBytes, type LibraryArtifact } from '../../shared/api/artifactLibrary';
import type { Conversation } from '../../shared/schemas/api';
import { conversationTitle } from '../../shared/state';
import s from './composer.module.css';

const ALL = '__all__';

/**
 * Pick artifacts from other conversations and copy them into this one
 * (POST /api/conversations/{id}/artifact-imports). Lists come from the
 * artifact library, so a search covers every conversation at once; picking a
 * conversation on the left only narrows the list.
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
  const [source, setSource] = useState<string>(ALL);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [rows, setRows] = useState<LibraryArtifact[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const current = conversations.find((c) => c.id === currentConversationId);
  const currentSession = current?.sandbox_session_id ? String(current.sandbox_session_id) : null;
  const candidates = conversations.filter((c) => c.id !== currentConversationId && c.sandbox_session_id);
  const titleBySession = useMemo(
    () => new Map(conversations.filter((c) => c.sandbox_session_id).map((c) => [String(c.sandbox_session_id), conversationTitle(c)])),
    [conversations],
  );

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), 300);
    return () => window.clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setRows(null);
    setError(null);
    setPicked(new Set());
    listLibraryArtifacts({ q: debounced || null, limit: 100 })
      .then((page) => {
        if (stale) return;
        setRows(page.artifacts);
        setCursor(page.nextCursor);
      })
      .catch((err: Error) => {
        if (!stale) setError(err.message || '读取产物失败');
      });
    return () => {
      stale = true;
    };
  }, [open, debounced]);

  async function more() {
    if (!cursor) return;
    try {
      const page = await listLibraryArtifacts({ q: debounced || null, cursor, limit: 100 });
      setRows((cur) => [...(cur || []), ...page.artifacts]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError((err as Error).message || '读取产物失败');
    }
  }

  const sourceSession = source === ALL ? null : String(candidates.find((c) => c.id === source)?.sandbox_session_id || '');
  const visible = (rows || []).filter((r) => r.session_id !== currentSession && (!sourceSession || r.session_id === sourceSession));

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
          <button type="button" role="option" aria-selected={source === ALL} className={source === ALL ? s.impCur : undefined} onClick={() => setSource(ALL)}>
            全部会话
          </button>
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
          <input className={s.impSearch} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索文件名" aria-label="搜索产物" />
          {!rows && !error ? <p className={s.muted}>正在读取…</p> : null}
          {error ? <p className={s.err}>{error}</p> : null}
          {rows && visible.length === 0 ? <p className={s.muted}>{debounced ? '没有匹配的产物' : '没有可引用的产物'}</p> : null}
          {visible.map((r) => (
            <label key={r.artifact_id} className={`${s.impRow}${picked.has(r.artifact_id) ? ` ${s.impPicked}` : ''}`}>
              <input
                type="checkbox"
                checked={picked.has(r.artifact_id)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(r.artifact_id);
                  else next.delete(r.artifact_id);
                  setPicked(next);
                }}
              />
              <span className={s.attName}>{r.name}</span>
              <small className={s.muted}>
                {source === ALL ? `${titleBySession.get(r.session_id) || '其他会话'} · ` : ''}{formatBytes(r.size)}
              </small>
            </label>
          ))}
          {cursor ? <button type="button" className={s.btn} onClick={() => void more()}>加载更多</button> : null}
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
