/**
 * Pure part of the ⌘K palette: which entries show for a query, in which order.
 * Conversations and actions are matched locally; artifacts come from the
 * library search and are appended by the component.
 */
export type PaletteGroup = '操作' | '会话' | '产物';

export type PaletteEntry = {
  id: string;
  group: PaletteGroup;
  label: string;
  hint?: string;
  /** Extra text searched besides the label (keywords, English aliases). */
  keywords?: string;
};

const GROUP_ORDER: Record<PaletteGroup, number> = { 会话: 0, 产物: 1, 操作: 2 };

/**
 * Entries matching `query` (case-insensitive substring of label or keywords),
 * grouped 会话 → 产物 → 操作; a label that starts with the query ranks first.
 * With an empty query: the most recent conversations, then all actions.
 */
export function filterPalette(entries: readonly PaletteEntry[], query: string, recentLimit = 6): PaletteEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    const recent = entries.filter((e) => e.group === '会话').slice(0, recentLimit);
    return [...recent, ...entries.filter((e) => e.group === '操作')];
  }
  const scored = entries
    .map((e, index) => {
      const label = e.label.toLowerCase();
      const hay = `${label} ${(e.keywords || '').toLowerCase()}`;
      if (!hay.includes(q)) return null;
      return { e, index, score: label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2 };
    })
    .filter((x): x is { e: PaletteEntry; index: number; score: number } => x != null);
  scored.sort((a, b) => GROUP_ORDER[a.e.group] - GROUP_ORDER[b.e.group] || a.score - b.score || a.index - b.index);
  return scored.map((x) => x.e);
}
