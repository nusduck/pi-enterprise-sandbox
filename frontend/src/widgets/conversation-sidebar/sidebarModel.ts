/**
 * Pure helpers for the conversation sidebar: filtering, date grouping and the
 * per-agent tag colour. Kept free of React so they can be unit tested.
 */

export type SidebarConversation = {
  id: string;
  title?: string | null;
  agent_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type ConversationGroup<T> = { label: string; items: T[] };

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function activity(conv: SidebarConversation): number {
  const t = Date.parse(conv.updated_at || conv.created_at || '');
  return Number.isFinite(t) ? t : 0;
}

/** Newest first, bucketed into 今天 / 昨天 / 近 7 天 / 更早; empty buckets are dropped. */
export function groupConversations<T extends SidebarConversation>(
  conversations: readonly T[],
  now: number = Date.now(),
): ConversationGroup<T>[] {
  const today = startOfDay(now);
  const buckets: ConversationGroup<T>[] = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '近 7 天', items: [] },
    { label: '更早', items: [] },
  ];
  const sorted = [...conversations].sort(
    (a, b) => activity(b) - activity(a) || String(a.id).localeCompare(String(b.id)),
  );
  for (const conv of sorted) {
    const t = activity(conv);
    const idx = t >= today ? 0 : t >= today - DAY ? 1 : t >= today - 6 * DAY ? 2 : 3;
    buckets[idx].items.push(conv);
  }
  return buckets.filter((b) => b.items.length > 0);
}

/** Case-insensitive title match, optionally restricted to one agent. */
export function filterConversations<T extends SidebarConversation>(
  conversations: readonly T[],
  query: string,
  agentId: string | null,
  titleOf: (conv: T) => string,
): T[] {
  const q = query.trim().toLowerCase();
  return conversations.filter(
    (conv) =>
      (!agentId || conv.agent_id === agentId) &&
      (!q || titleOf(conv).toLowerCase().includes(q)),
  );
}

/** Stable 0–5 colour slot for an agent tag, so one agent keeps one colour. */
export function agentTone(agentId: string): number {
  let h = 0;
  for (let i = 0; i < agentId.length; i += 1) h = (h * 31 + agentId.charCodeAt(i)) >>> 0;
  return h % 6;
}

/** The org's default agent carries no tag: most conversations use it. */
export function isDefaultAgentName(name: string | null | undefined): boolean {
  return !name || name.trim().toLowerCase() === 'default';
}
