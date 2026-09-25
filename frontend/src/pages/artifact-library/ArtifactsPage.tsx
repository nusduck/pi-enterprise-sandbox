/**
 * 产物库：本人所有会话的产物按时间排成网格（全部 / 文档 / 图片 / 数据 + 搜索），
 * 点开预览、下载或回到所在会话。数据来自 `GET /api/artifacts`（不带 session_id）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChat } from '../../features/chat/ChatContext';
import { getArtifactDownloadUrl } from '../../shared/api/client';
import {
  artifactTypeLabel,
  dateBucket,
  formatBytes,
  isImageArtifact,
  listLibraryArtifacts,
  type ArtifactKind,
  type LibraryArtifact,
} from '../../shared/api/artifactLibrary';
import { conversationTitle } from '../../shared/state';
import s from './artifacts.module.css';

const KINDS: Array<[ArtifactKind, string]> = [['all', '全部'], ['document', '文档'], ['image', '图片'], ['data', '数据']];

function formatDay(iso: string | null | undefined): string {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    : d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
}

export function ArtifactsPage() {
  const navigate = useNavigate();
  const { state } = useChat();
  const [kind, setKind] = useState<ArtifactKind>('all');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [items, setItems] = useState<LibraryArtifact[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<LibraryArtifact | null>(null);
  const generation = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), 300);
    return () => window.clearTimeout(t);
  }, [query]);

  const load = useCallback(async (after: string | null = null) => {
    const gen = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const page = await listLibraryArtifacts({ q: debounced || null, kind, cursor: after });
      if (gen !== generation.current) return;
      setItems((cur) => (after ? [...cur, ...page.artifacts] : page.artifacts));
      setCursor(page.nextCursor);
    } catch (err) {
      if (gen === generation.current) setError((err as Error).message || '读取产物失败');
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [debounced, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  // Artifacts record the sandbox session they were produced in; conversations carry the same id.
  const conversationBySession = useMemo(
    () => new Map((state.conversations || []).filter((c) => c.sandbox_session_id).map((c) => [String(c.sandbox_session_id), c])),
    [state.conversations],
  );
  const groups = useMemo(() => {
    const out: Array<[string, LibraryArtifact[]]> = [];
    for (const a of items) {
      const bucket = dateBucket(a.created_at);
      const last = out[out.length - 1];
      if (last && last[0] === bucket) last[1].push(a);
      else out.push([bucket, [a]]);
    }
    return out;
  }, [items]);

  const convOf = (a: LibraryArtifact) => conversationBySession.get(a.session_id) ?? null;
  const url = (a: LibraryArtifact) => getArtifactDownloadUrl(a.session_id, a.artifact_id);

  return (
    <div className={s.page}>
      <div className={s.inner}>
        <div className={s.top}>
          <div className={s.tabs} role="tablist" aria-label="产物类型">
            {KINDS.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={kind === id} onClick={() => setKind(id)}>{label}</button>
            ))}
          </div>
          <span className={s.sp} />
          <input className={s.search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索文件名" aria-label="搜索产物" />
        </div>

        {error ? <p className={s.banner} role="alert">{error}</p> : null}
        {!loading && !error && items.length === 0 ? (
          <div className={s.empty}>
            <b>{debounced || kind !== 'all' ? '没有符合条件的产物' : '还没有产物'}</b>
            <span>智能体用「提交产物」交付的文件会出现在这里，可以下载，或在输入框的「＋」里引用到其他会话。</span>
          </div>
        ) : null}

        {groups.map(([bucket, list]) => (
          <section key={bucket} className={s.group} aria-label={bucket}>
            <h2>{bucket}</h2>
            <div className={s.grid}>
              {list.map((a) => {
                const conv = convOf(a);
                const src = isImageArtifact(a) ? url(a) : null;
                return (
                  <button key={a.artifact_id} type="button" className={s.card} onClick={() => setOpen(a)}>
                    <span className={s.preview}>
                      {src ? <img src={src} alt="" loading="lazy" /> : <span className={s.type}>{artifactTypeLabel(a)}</span>}
                    </span>
                    <span className={s.meta}>
                      <b>{a.name}</b>
                      <small>{conv ? conversationTitle(conv) : '其他会话'} · {formatDay(a.created_at)}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}

        {loading ? <p className={s.muted}>正在读取…</p> : null}
        {cursor && !loading ? (
          <button type="button" className={s.more} onClick={() => void load(cursor)}>加载更多</button>
        ) : null}
      </div>

      <dialog ref={dialog} className={s.dialog} onClose={() => setOpen(null)} aria-label="产物预览">
        {open ? (
          <>
            <div className={s.dlgHead}>
              <b>{open.name}</b>
              <span className={s.sp} />
              <button type="button" className={s.btn} onClick={() => setOpen(null)}>关闭</button>
            </div>
            <div className={s.dlgBody}>
              {isImageArtifact(open) && url(open)
                ? <img className={s.big} src={url(open)!} alt={open.name} />
                : <div className={s.bigType}>{artifactTypeLabel(open)}</div>}
              <dl className={s.kv}>
                <dt>所在会话</dt><dd>{convOf(open) ? conversationTitle(convOf(open)!) : '—'}</dd>
                <dt>类型</dt><dd>{open.mime_type || '—'}</dd>
                <dt>大小</dt><dd>{formatBytes(open.size) || '—'}</dd>
                <dt>时间</dt><dd>{open.created_at ? new Date(open.created_at).toLocaleString('zh-CN', { hour12: false }) : '—'}</dd>
                <dt>路径</dt><dd className={s.mono}>{open.path || '—'}</dd>
              </dl>
            </div>
            <div className={s.dlgFoot}>
              <span className={s.muted}>在其他会话的输入框「＋ → 引用其他会话的产物」可以把它复制过去。</span>
              <span className={s.sp} />
              {convOf(open) ? (
                <button type="button" className={s.btn} onClick={() => navigate(`/c/${encodeURIComponent(convOf(open)!.id)}`)}>打开所在会话</button>
              ) : null}
              {url(open) ? <a className={s.btnPri} href={url(open)!} download={open.name}>下载</a> : null}
            </div>
          </>
        ) : null}
      </dialog>
    </div>
  );
}
