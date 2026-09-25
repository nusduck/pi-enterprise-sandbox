/**
 * ⌘K command palette: jump to a conversation, an artifact or an action from
 * anywhere. Conversations and actions filter locally; artifacts use the
 * library search (debounced). Arrow keys move, Enter runs, Esc closes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { listLibraryArtifacts, type LibraryArtifact } from '../../shared/api/artifactLibrary';
import { filterPalette, type PaletteEntry } from './paletteModel';
import s from './commandPalette.module.css';

export type PaletteAction = PaletteEntry & { run: () => void };

export function CommandPalette({
  open,
  onClose,
  conversations,
  actions,
  onOpenConversation,
  onOpenArtifact,
}: {
  open: boolean;
  onClose: () => void;
  conversations: Array<{ id: string; title: string; hint?: string }>;
  actions: PaletteAction[];
  onOpenConversation: (id: string) => void;
  onOpenArtifact: (artifact: LibraryArtifact) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [artifacts, setArtifacts] = useState<LibraryArtifact[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery('');
      setActive(0);
      d.showModal();
      inputRef.current?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  // Artifacts only when there is something to search for; stale replies are dropped.
  useEffect(() => {
    const q = query.trim();
    if (!open || !q) {
      setArtifacts([]);
      return;
    }
    let stale = false;
    const t = window.setTimeout(() => {
      listLibraryArtifacts({ q, limit: 5 })
        .then((page) => { if (!stale) setArtifacts(page.artifacts); })
        .catch(() => { if (!stale) setArtifacts([]); });
    }, 200);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
  }, [open, query]);

  const entries = useMemo(() => {
    const base: PaletteEntry[] = [
      ...conversations.map((c) => ({ id: `c:${c.id}`, group: '会话' as const, label: c.title, hint: c.hint })),
      ...actions,
    ];
    const local = filterPalette(base, query);
    const arts: PaletteEntry[] = artifacts.map((a) => ({ id: `a:${a.artifact_id}`, group: '产物', label: a.name, hint: a.mime_type || undefined }));
    // Artifacts slot in after conversations, before actions.
    const firstAction = local.findIndex((e) => e.group === '操作');
    return firstAction < 0 ? [...local, ...arts] : [...local.slice(0, firstAction), ...arts, ...local.slice(firstAction)];
  }, [conversations, actions, artifacts, query]);

  useEffect(() => {
    if (active >= entries.length) setActive(Math.max(0, entries.length - 1));
  }, [entries.length, active]);

  function run(entry: PaletteEntry | undefined) {
    if (!entry) return;
    onClose();
    if (entry.id.startsWith('c:')) onOpenConversation(entry.id.slice(2));
    else if (entry.id.startsWith('a:')) {
      const a = artifacts.find((x) => x.artifact_id === entry.id.slice(2));
      if (a) onOpenArtifact(a);
    } else actions.find((x) => x.id === entry.id)?.run();
  }

  let lastGroup: string | null = null;
  return (
    <dialog
      ref={ref}
      className={s.palette}
      aria-label="命令面板"
      onClose={onClose}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <input
        ref={inputRef}
        className={s.input}
        value={query}
        placeholder="搜索会话、产物或操作…"
        aria-label="搜索会话、产物或操作"
        aria-controls="palette-list"
        aria-activedescendant={entries[active] ? `pal-${entries[active].id}` : undefined}
        onChange={(e) => { setQuery(e.target.value); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(entries.length - 1, i + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
          else if (e.key === 'Enter') { e.preventDefault(); run(entries[active]); }
        }}
      />
      <div id="palette-list" className={s.list} role="listbox" aria-label="结果">
        {entries.length === 0 ? <p className={s.empty}>没有匹配的结果</p> : null}
        {entries.map((entry, i) => {
          const heading = entry.group !== lastGroup ? entry.group : null;
          lastGroup = entry.group;
          return (
            <div key={entry.id}>
              {heading ? <div className={s.group}>{heading}</div> : null}
              <div
                id={`pal-${entry.id}`}
                role="option"
                aria-selected={i === active}
                className={s.item}
                onMouseMove={() => setActive(i)}
                onClick={() => run(entry)}
              >
                <span className={s.label}>{entry.label}</span>
                {entry.hint ? <small>{entry.hint}</small> : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className={s.foot}>↑↓ 选择 · Enter 打开 · Esc 关闭</div>
    </dialog>
  );
}
