/**
 * Right-hand preview for an artifact picked in the turn stream: images full
 * width, text-like files (Markdown rendered, the rest as plain text) read
 * through the same download URL, everything else as a type tile + download.
 * Lists the conversation's other artifacts below so they are one click away.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ArtifactEntity } from '../../entities/types';
import { MarkdownBody } from '../markdown/Markdown';
import s from './artifactDrawer.module.css';

/** Bytes read for a text preview; bigger files show the start and a note. */
const PREVIEW_BYTES = 200 * 1024;
const TEXT_EXT = /\.(md|markdown|txt|csv|tsv|json|log|py|sql|ya?ml|xml|html?|js|ts|sh|ini|toml)$/i;

export type DrawerArtifact = {
  artifact: ArtifactEntity;
  url: string | null;
  downloadName: string;
  label: string;
};

function kindOf(a: ArtifactEntity): 'image' | 'markdown' | 'text' | 'other' {
  const mime = String(a.mimeType || '').toLowerCase();
  const name = a.name || a.path || '';
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'image';
  if (mime === 'text/markdown' || /\.(md|markdown)$/i.test(name)) return 'markdown';
  if (mime.startsWith('text/') || mime.includes('json') || TEXT_EXT.test(name)) return 'text';
  return 'other';
}

function TextPreview({ url, markdown }: { url: string; markdown: boolean }) {
  const [state, setState] = useState<{ text: string; truncated: boolean } | { error: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState(null);
    (async () => {
      try {
        const resp = await fetch(url, { signal: controller.signal, credentials: 'same-origin' });
        if (!resp.ok || !resp.body) throw new Error(`读取失败（${resp.status}）`);
        const reader = resp.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        let truncated = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          size += value.length;
          if (size >= PREVIEW_BYTES) {
            truncated = true;
            await reader.cancel();
            break;
          }
        }
        const bytes = new Uint8Array(Math.min(size, PREVIEW_BYTES));
        let offset = 0;
        for (const c of chunks) {
          const take = Math.min(c.length, bytes.length - offset);
          bytes.set(c.subarray(0, take), offset);
          offset += take;
          if (offset >= bytes.length) break;
        }
        setState({ text: new TextDecoder().decode(bytes), truncated });
      } catch (err) {
        if (!controller.signal.aborted) setState({ error: (err as Error).message || '读取失败' });
      }
    })();
    return () => controller.abort();
  }, [url]);

  if (!state) return <p className={s.muted}>正在读取…</p>;
  if ('error' in state) return <p className={s.muted}>{state.error}，可以直接下载查看。</p>;
  return (
    <>
      {markdown ? <div className={s.doc}><MarkdownBody text={state.text} /></div> : <pre className={s.pre}>{state.text}</pre>}
      {state.truncated ? <p className={s.muted}>只预览了前 200 KB，完整内容请下载。</p> : null}
    </>
  );
}

export function ArtifactDrawer({
  current,
  others,
  onSelect,
  onClose,
}: {
  current: DrawerArtifact | null;
  others: DrawerArtifact[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [current, onClose]);

  if (!current) return null;
  const { artifact, url } = current;
  const kind = kindOf(artifact);
  const rest = others.filter((o) => o.artifact.id !== artifact.id);

  return createPortal(
    <aside className={s.drawer} aria-label={`产物预览：${current.downloadName}`}>
      <div className={s.head}>
        <b title={current.downloadName}>{artifact.name || artifact.path || '产物'}</b>
        <span className={s.sp} />
        {url ? <a className={s.btn} href={url} download={current.downloadName}>下载</a> : null}
        <button type="button" className={s.btn} onClick={onClose} aria-label="关闭预览">✕</button>
      </div>
      <div className={s.body}>
        {!url ? <p className={s.muted}>这个产物还没有可下载的记录。</p> : null}
        {url && kind === 'image' ? <img className={s.img} src={url} alt={artifact.name || ''} /> : null}
        {url && (kind === 'markdown' || kind === 'text') ? <TextPreview url={url} markdown={kind === 'markdown'} /> : null}
        {url && kind === 'other' ? (
          <div className={s.tile}>
            <span>{current.label}</span>
            <small>这种类型不能在页面里预览，请下载后查看。</small>
          </div>
        ) : null}
        {rest.length ? (
          <section className={s.others}>
            <h5>本会话的其他产物</h5>
            {rest.map((o) => (
              <button key={o.artifact.id} type="button" className={s.row} onClick={() => onSelect(o.artifact.id)}>
                <span className={s.ic}>{o.label}</span>
                <span className={s.rowName}>{o.artifact.name || o.artifact.path || '产物'}</span>
              </button>
            ))}
          </section>
        ) : null}
      </div>
    </aside>,
    document.body,
  );
}
