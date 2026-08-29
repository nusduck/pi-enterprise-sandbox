/**
 * 外部 MCP `context_id` → Sandbox 身份的 Redis 权威表。
 * 移植自 `sandbox/mcp/context_store.py`。
 *
 * 映射是持久的；首次使用时的开通走一把短 Redis 锁，避免同一个 `context_id`
 * 并发首用时开出两个工作区。
 *
 * ## Model Experience
 * 模型只看见 `context_id`：它在每个工具结果里回显，模型据此把后续调用绑到
 * 同一个工作区。所有失败都是稳定短句（`Invalid context_id`、
 * `Context is busy; retry the request`），不含 Redis 键名或地址。
 *
 * ## Known Limitations and Deferred Work
 * - 锁只在 `lockTtlSeconds` 内有效。持有者卡住超过 TTL 时另一个请求会拿到锁；
 *   开通本身是幂等的（拿到锁后先复读一次映射），所以最坏结果是多做一次
 *   `ensureContext`，不会产生两条映射。
 */
import { randomBytes } from 'node:crypto';
import type { McpSettings } from './settings.js';
import { newUlid } from './ulid.js';

const CONTEXT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const KEY_PART_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class ContextStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextStoreError';
  }
}

export interface ContextRecord {
  readonly contextId: string;
  readonly sandboxSessionId: string;
  readonly workspaceId: string;
}

/** ContextStore 用到的 Redis 子集，方便测试替身只实现这几个方法。 */
export interface RedisLike {
  ping(): Promise<string>;
  hgetall(key: string): Promise<Record<string, string>>;
  hset(key: string, value: Record<string, string>): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  /** `SET key value EX <seconds> [NX]`. 省略 `NX` 即无条件覆盖写。 */
  set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number,
    condition?: 'NX',
  ): Promise<string | null>;
  get(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  quit(): Promise<unknown>;
}

const RELEASE_LOCK =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class ContextStore {
  readonly #settings: McpSettings;
  #redis: RedisLike | null;
  readonly #connect: (() => Promise<RedisLike>) | null;

  constructor(
    settings: McpSettings,
    redisClient?: RedisLike | null,
    connect?: () => Promise<RedisLike>,
  ) {
    this.#settings = settings;
    this.#redis = redisClient ?? null;
    this.#connect = connect ?? null;
  }

  async start(): Promise<void> {
    if (this.#redis !== null) return;
    if (this.#connect === null) throw new ContextStoreError('MCP context store is unavailable');
    try {
      const client = await this.#connect();
      await client.ping();
      this.#redis = client;
    } catch {
      this.#redis = null;
      throw new ContextStoreError('MCP context store is unavailable');
    }
  }

  async close(): Promise<void> {
    const client = this.#redis;
    this.#redis = null;
    if (client === null) return;
    try {
      await client.quit();
    } catch {
      // 关闭失败不应该盖过调用方正在处理的错误。
    }
  }

  #require(): RedisLike {
    if (this.#redis === null) throw new ContextStoreError('MCP context store is unavailable');
    return this.#redis;
  }

  #scope(): string {
    if (!KEY_PART_RE.test(this.#settings.clientId) || !KEY_PART_RE.test(this.#settings.tenantId)) {
      throw new ContextStoreError('MCP context store is unavailable');
    }
    return `${this.#settings.redisPrefix}:${this.#settings.tenantId}:${this.#settings.clientId}`;
  }

  #contextKey(contextId: string): string {
    return `${this.#scope()}:context:${contextId}`;
  }

  #lockKey(contextId: string): string {
    return `${this.#scope()}:lock:${contextId}`;
  }

  artifactKey(artifactId: string): string {
    return `${this.#scope()}:artifact:${artifactId}`;
  }

  static normaliseContextId(contextId: string | null | undefined): string {
    const value =
      contextId === null || contextId === undefined || contextId.trim() === ''
        ? newUlid()
        : contextId.trim();
    if (!CONTEXT_RE.test(value)) throw new ContextStoreError('Invalid context_id');
    return value;
  }

  async #get(contextId: string): Promise<ContextRecord | null> {
    const redis = this.#require();
    const data = await redis.hgetall(this.#contextKey(contextId));
    if (!data || Object.keys(data).length === 0) return null;
    const sandboxSessionId = data['sandbox_session_id'];
    const workspaceId = data['workspace_id'];
    if (typeof sandboxSessionId !== 'string' || typeof workspaceId !== 'string') {
      throw new ContextStoreError('MCP context mapping is invalid');
    }
    return { contextId, sandboxSessionId, workspaceId };
  }

  /** 读出映射，或在分布式锁下创建并校验一次。 */
  async resolve(
    contextId: string | null | undefined,
    ensureContext: (record: ContextRecord) => Promise<unknown>,
  ): Promise<ContextRecord> {
    const safeContextId = ContextStore.normaliseContextId(contextId);
    const existing = await this.#get(safeContextId);
    if (existing !== null) return existing;

    const redis = this.#require();
    const owner = randomBytes(18).toString('base64url');
    const lockKey = this.#lockKey(safeContextId);
    const deadline = Date.now() + Math.max(2, this.#settings.lockTtlSeconds) * 1000;
    let acquired = false;
    while (Date.now() < deadline) {
      acquired =
        (await redis.set(lockKey, owner, 'EX', this.#settings.lockTtlSeconds, 'NX')) !== null;
      if (acquired) break;
      await sleep(50);
      const raced = await this.#get(safeContextId);
      if (raced !== null) return raced;
    }
    if (!acquired) throw new ContextStoreError('Context is busy; retry the request');

    try {
      const raced = await this.#get(safeContextId);
      if (raced !== null) return raced;
      const record: ContextRecord = {
        contextId: safeContextId,
        sandboxSessionId: newUlid(),
        workspaceId: newUlid(),
      };
      await ensureContext(record);
      await redis.hset(this.#contextKey(safeContextId), {
        context_id: record.contextId,
        sandbox_session_id: record.sandboxSessionId,
        workspace_id: record.workspaceId,
      });
      await redis.expire(this.#contextKey(safeContextId), this.#settings.contextTtlSeconds);
      return record;
    } catch (error) {
      if (error instanceof ContextStoreError) throw error;
      throw new ContextStoreError('Unable to provision Sandbox context');
    } finally {
      // 比较后删除：防止一个已过期的持有者删掉别人新拿的锁。
      try {
        await redis.eval(RELEASE_LOCK, 1, lockKey, owner);
      } catch {
        // 锁会自己过期，删不掉不影响正确性。
      }
    }
  }

  async touch(record: ContextRecord): Promise<void> {
    const redis = this.#require();
    await redis.expire(this.#contextKey(record.contextId), this.#settings.contextTtlSeconds);
  }

  async putArtifact(artifactId: string, metadata: Record<string, unknown>): Promise<void> {
    const redis = this.#require();
    // 无条件覆盖写（与 Python 版一致）。加 NX 会让同一 id 的重复提交静默失败。
    await redis.set(
      this.artifactKey(artifactId),
      JSON.stringify(metadata),
      'EX',
      this.#settings.artifactTtlSeconds,
    );
  }

  async getArtifact(artifactId: string): Promise<Record<string, unknown> | null> {
    const redis = this.#require();
    const raw = await redis.get(this.artifactKey(artifactId));
    if (!raw) return null;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new ContextStoreError('MCP artifact metadata is invalid');
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
    return data as Record<string, unknown>;
  }
}
