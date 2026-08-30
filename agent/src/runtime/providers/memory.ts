/**
 * 自建记忆（memory）能力——DSH 无原生，直接提供 memory_write / memory_search。
 *
 * 这是什么：为每个租户（orgId/userId）持久化零散记忆条目，模型通过工具写入与
 * 检索。执行面无此组件，全部在 Agent 侧完成，不经过沙箱。写入前归一化、检索
 * 时做关键词匹配，属于 MVP 文本检索；后续可换向量库而不改工具面。
 *
 * 为什么策略与存储解耦：归一化与匹配是纯函数（无 I/O），可在 macOS 单测；
 * 存储落在窄接口 `MemoryStore`，内存/ MySQL 两实现互换。
 */

export interface MemoryEntry {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly text: string;
  readonly createdAt: number;
}

export interface MemoryStore {
  put(entry: MemoryEntry): Promise<void>;
  list(orgId: string, userId: string): Promise<MemoryEntry[]>;
}

// ── 归一化与匹配（纯函数，可单测） ───────────────────────────────

export function normalizeMemoryText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 4096);
}

export function isValidMemoryText(text: string): boolean {
  const n = normalizeMemoryText(text);
  return n.length >= 2 && n.length <= 4096;
}

/** 关键词匹配：query 分词后至少一词命中 entry.text（大小写不敏感）。 */
export function memoryMatches(entryText: string, query: string): boolean {
  const q = normalizeMemoryText(query).toLowerCase();
  if (!q) return false;
  const tokens = q.split(' ').filter(Boolean);
  const lower = entryText.toLowerCase();
  return tokens.some((t) => lower.includes(t));
}

// ── 内存实现 ──────────────────────────────────────────────────

export class InMemoryMemoryStore implements MemoryStore {
  private readonly buckets = new Map<string, MemoryEntry[]>();
  private key(orgId: string, userId: string): string {
    return `${orgId}::${userId}`;
  }
  async put(entry: MemoryEntry): Promise<void> {
    const k = this.key(entry.orgId, entry.userId);
    const arr = this.buckets.get(k) ?? [];
    arr.push(entry);
    this.buckets.set(k, arr);
  }
  async list(orgId: string, userId: string): Promise<MemoryEntry[]> {
    return [...(this.buckets.get(this.key(orgId, userId)) ?? [])];
  }
}

// ── 服务（工具面） ───────────────────────────────────────────

export class MemoryService {
  constructor(private readonly store: MemoryStore, private readonly now: () => number = Date.now, private readonly genId: () => string = () => `mem_${Math.random().toString(36).slice(2, 10)}`) {}

  /** 写入一条记忆；非法文本直接抛错，调用方转 isError 工具结果。 */
  async write(orgId: string, userId: string, text: string): Promise<MemoryEntry> {
    const normalized = normalizeMemoryText(text);
    if (!isValidMemoryText(normalized)) {
      throw new Error('invalid memory text: empty or too short/long');
    }
    const entry: MemoryEntry = { id: this.genId(), orgId, userId, text: normalized, createdAt: this.now() };
    await this.store.put(entry);
    return entry;
  }

  /** 检索：返回命中 query 的条目，按创建时间倒序，截断到 limit。 */
  async search(orgId: string, userId: string, query: string, limit = 10): Promise<MemoryEntry[]> {
    const all = await this.store.list(orgId, userId);
    const hits = all.filter((e) => memoryMatches(e.text, query));
    hits.sort((a, b) => b.createdAt - a.createdAt);
    return hits.slice(0, Math.max(0, limit));
  }
}
