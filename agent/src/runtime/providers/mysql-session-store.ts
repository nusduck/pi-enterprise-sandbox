/**
 * `ctx.sessionPersistence` 的 MySQL 后端——DSH 官方 `PersistenceBackend` 的
 * 企业实现（AD0007 D5 继承 ADR0005 六决策）。
 *
 * 为什么单独一层：`dsh-session-persistence` 的 `SessionPersistence`
 * / `PersistenceCoordinator` 是写入编排，真正的落盘是 `PersistenceBackend`
 * 这一组 8 个方法（`name`/`loadStored`/`readStoredRevision`/
 * `loadStoredFrom`/`appendBatch`/`commitRepair`/`list`/`close`）。原生只有
 * JSONL 与 SQLite 后端，都不满足多租户账本；MySQL 后端是正式扩展点，不是绕路。
 *
 * 六决策落地：
 * 1. 日志文件只是适配器——在线权威是 MySQL，这张表不是 `.jsonl.zstd` 导出；
 * 2. 引擎事件拆到独立物理表 `dsh_session_events`（`session_id + seq` 主键，带
 *    `org_id`/`user_id` 租户三元组，不复用 `messages` 宽表）；
 * 3. 快照按阈值触发——由 `CheckpointPolicy` 统计事件数/字节数，阈值外不每 Run
 *    全量复制，避免二次写放大；
 * 4. 容量写入前统一判定——`appendBatch` 前先算 `packChunkRuns` 后字节数，超
 *    `MAX_SESSION_BYTES` 直接 fail-closed，不进事务；
 * 5. 租户/一致性/错误语义——所有 SQL 显式带 `org_id`/`user_id`/`session_id`，
 *    跨租户 404，首事件 seq 必须等于 next-seq 否则拒绝，事务内追加；
 * 6. 冷归档不在在线事务里——本后端不写归档，只暴露 `chunk-rows` 无损编解码，
 *    归档由独立 retention 决策定义。
 *
 * 单实例：`exec/` 与 `agent` 共用 MySQL，当前单进程+`worker_threads`，
 * 未开多进程 HTTP worker；多实例扩展点已预留（`WorkspaceLock` 接口、信封
 * 含 `workspaceId` 一致性哈希），此处事务是单机原子语义，多机需加
 * `GET_LOCK` 再议。
 *
 * 无历史迁移：研发阶段，现有 Pi `0.80.3` 会话数据直接丢弃，不写转换器。
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  decodeStorageRecord,
  isJsonValue,
  packChunkRuns,
} from '@deepseek-ai/dsh-session';
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence';
import type {
  PersistenceBackend,
  StoredPrefix,
  StoredSuffix,
} from '@deepseek-ai/dsh-session-persistence';
import { toWireError } from '@pi/contract/errors.js';

// 官方 codec 从本模块再导出，测试必须驱动这条路径而不是自己抄一份。
export { decodeStorageRecord, packChunkRuns };

const require = createRequire(import.meta.url);
type Pool = {
  execute: (...args: unknown[]) => Promise<any>;
  getConnection: () => Promise<{
    beginTransaction: () => Promise<void>;
    commit: () => Promise<void>;
    rollback: () => Promise<void>;
    execute: (...args: unknown[]) => Promise<any>;
    release: () => void;
  }>;
  end: () => Promise<void>;
};
type PoolOptions = Record<string, unknown>;
type RowDataPacket = Record<string, unknown>;
function createPool(_opts: PoolOptions): Pool {
  try {
    const m = require('mysql2/promise') as { createPool: (o: PoolOptions) => Pool };
    return m.createPool(_opts) as Pool;
  } catch {
    throw new Error('mysql2 not installed: pool creation requires mysql2');
  }
}

/** 任何抛出物无条件脱敏——空 roots 仍走 contract 的默认物理前缀，不能静默放行。 */
export function toSessionStoreError(err: unknown, physicalRoots: readonly string[]): Error {
  const wire = toWireError(err, { physicalRoots });
  return new Error(wire.message);
}

function parseJsonColumn(value: unknown, label: string): unknown {
  if (value == null) throw new Error(`${label} is empty`);
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') throw new Error(`${label} is not JSON`);
  return JSON.parse(value);
}

function recordSeq(rec: unknown): number {
  if (rec !== null && typeof rec === 'object') {
    const row = rec as { seq?: unknown; seq0?: unknown };
    if (typeof row.seq === 'number' && Number.isSafeInteger(row.seq)) return row.seq;
    if (typeof row.seq0 === 'number' && Number.isSafeInteger(row.seq0)) return row.seq0;
  }
  throw toSessionStoreError(new Error('storage record missing seq'), []);
}

function decodeRecords(records: readonly unknown[]): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const rec of records) {
    events.push(...decodeStorageRecord(rec));
  }
  return events;
}

// ---------------------------------------------------------------------------
// 常量与 DDL
// ---------------------------------------------------------------------------

/** 在线会话 8 MiB 上限——写入前统一判定（决策 4）。与 `PI_MAX_JSONL_BYTES` 对齐。 */
export const MAX_SESSION_BYTES = 8 * 1024 * 1024;

/** DDL——迁移权威在 `agent/`，此处仅常量化供单测与文档固化。 */
export const DSH_SESSIONS_DDL = `
CREATE TABLE dsh_sessions (
  session_id   CHAR(26)       NOT NULL,
  org_id       CHAR(26)       NOT NULL,
  user_id      CHAR(26)       NOT NULL,
  header_json  JSON           NOT NULL,
  revision     VARCHAR(128)   NOT NULL,
  created_at   DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (session_id),
  KEY idx_dsh_sessions_owner (org_id, user_id, session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`.trim();

export const DSH_SESSION_EVENTS_DDL = `
CREATE TABLE dsh_session_events (
  session_id   CHAR(26)       NOT NULL,
  org_id       CHAR(26)       NOT NULL,
  user_id      CHAR(26)       NOT NULL,
  seq          BIGINT UNSIGNED NOT NULL,
  record_json  JSON           NOT NULL,
  created_at   DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (session_id, seq),
  KEY idx_dsh_events_seq (session_id, seq),
  KEY idx_dsh_events_owner (org_id, user_id, session_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`.trim();

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function revisionFor(events: readonly SessionEvent[], header: SessionHeader): string {
  const h = createHash('sha256');
  h.update(JSON.stringify(header));
  for (const e of events) {
    h.update(String(e.seq));
    h.update(e.type);
    h.update(JSON.stringify(e.data));
  }
  return h.digest('hex').slice(0, 32);
}

function toRevision(value: string): ReturnType<typeof SessionPersistenceRevision> {
  return SessionPersistenceRevision(value);
}

function assertTenant(
  orgId: string | undefined,
  userId: string | undefined,
): { orgId: string; userId: string } {
  if (!orgId || !userId) throw new Error('missing tenant: orgId/userId required');
  return { orgId, userId };
}

function redactErr(err: unknown, roots: readonly string[]): Error {
  return toSessionStoreError(err, roots);
}

// ---------------------------------------------------------------------------
// 配置与 Pool
// ---------------------------------------------------------------------------

export interface MysqlSessionStoreConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly connectionLimit?: number | undefined;
  readonly physicalRoots?: readonly string[] | undefined;
}

export interface SessionStoreOwner {
  readonly orgId: string;
  readonly userId: string;
}

export class MysqlSessionStoreConfigError extends Error {
  override name = 'MysqlSessionStoreConfigError';
}

function configFromDatabaseUrl(raw: string | undefined): MysqlSessionStoreConfig | undefined {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return undefined;
  if (!/^mysql2?:\/\//i.test(trimmed)) {
    throw new MysqlSessionStoreConfigError('unsupported database URL scheme');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new MysqlSessionStoreConfigError('invalid database URL');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')).split('/')[0] ?? '';
  if (!parsed.hostname || !parsed.username || !database) {
    throw new MysqlSessionStoreConfigError('database URL missing host, user, or database');
  }
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 3306;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new MysqlSessionStoreConfigError('invalid database URL port');
  }
  return {
    host: parsed.hostname,
    port,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  };
}

export function readMysqlSessionStoreConfig(
  env: NodeJS.ProcessEnv = process.env,
): MysqlSessionStoreConfig {
  const fromUrl = configFromDatabaseUrl(
    env['AGENT_DATABASE_URL'] ?? env['TEST_MYSQL_URL'] ?? env['MYSQL_URL'] ?? env['DATABASE_URL'],
  );
  if (fromUrl) return fromUrl;
  const host = env['MYSQL_HOST'] ?? env['DB_HOST'] ?? env['EXEC_DB_HOST'];
  const user = env['MYSQL_USER'] ?? env['DB_USER'] ?? env['EXEC_DB_USER'];
  const password = env['MYSQL_PASSWORD'] ?? env['DB_PASSWORD'] ?? env['EXEC_DB_PASSWORD'];
  const database = env['MYSQL_DATABASE'] ?? env['DB_DATABASE'] ?? env['EXEC_DB_DATABASE'];
  const portRaw = env['MYSQL_PORT'] ?? env['DB_PORT'] ?? env['EXEC_DB_PORT'];
  if (!host || !user || password === undefined || !database) {
    throw new MysqlSessionStoreConfigError(
      'missing MySQL config: set AGENT_DATABASE_URL or MYSQL_HOST/USER/PASSWORD/DATABASE',
    );
  }
  const port = portRaw ? Number.parseInt(portRaw, 10) : 3306;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new MysqlSessionStoreConfigError('invalid MYSQL_PORT');
  }
  return { host, port, user, password, database };
}

// ---------------------------------------------------------------------------
// InMemory 后端（macOS 无 MySQL 时单测用）
// ---------------------------------------------------------------------------

interface MemEntry {
  header: SessionHeader;
  records: unknown[];
  revision: string;
}

export class InMemorySessionStore implements PersistenceBackend<string> {
  readonly name = 'mysql-memory';

  private readonly sessions = new Map<string, MemEntry>();

  private key(id: SessionId): string {
    return String(id);
  }

  private decoded(entry: MemEntry): SessionEvent[] {
    return decodeRecords(entry.records);
  }

  async loadStored(id: SessionId): Promise<StoredPrefix<string> | undefined> {
    const entry = this.sessions.get(this.key(id));
    if (!entry) return undefined;
    const rev = toRevision(entry.revision);
    return {
      meta: structuredClone(entry.header),
      events: this.decoded(entry).map((e) => structuredClone(e)),
      revision: rev,
    } as StoredPrefix<string>;
  }

  async readStoredRevision(id: SessionId): Promise<ReturnType<typeof SessionPersistenceRevision> | undefined> {
    const entry = this.sessions.get(this.key(id));
    if (!entry) return undefined;
    return toRevision(entry.revision);
  }

  async loadStoredFrom(id: SessionId, fromSeq: number): Promise<StoredSuffix | undefined> {
    const stored = await this.loadStored(id);
    if (!stored) return undefined;
    return { meta: stored.meta, events: stored.events.filter((e) => e.seq >= fromSeq) };
  }

  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    // 容量判定（决策 4）
    for (const e of events) {
      if (!isJsonValue(e.data)) {
        throw new Error(`non-serializable event data: ${e.type} seq ${e.seq}`);
      }
    }
    const packed = packChunkRuns([...events]);
    const bytes = Buffer.byteLength(JSON.stringify(packed), 'utf8');
    if (bytes > MAX_SESSION_BYTES) {
      throw new Error(`session capacity exceeded: ${bytes} > ${MAX_SESSION_BYTES}`);
    }

    const k = this.key(meta.id);
    const existing = this.sessions.get(k);
    if (!isMaterialized && !existing) {
      const decoded = decodeRecords(packed);
      const rev = revisionFor(decoded, meta);
      this.sessions.set(k, {
        header: structuredClone(meta),
        records: packed,
        revision: rev,
      });
      return;
    }
    if (!existing) {
      throw new Error(`appendBatch: session not materialized: ${String(meta.id)}`);
    }
    const already = this.decoded(existing);
    const nextSeq = already.length > 0 ? Math.max(...already.map((e) => e.seq)) + 1 : 0;
    if (events.length > 0 && events[0]!.seq !== nextSeq) {
      throw new Error(`appendBatch seq mismatch: expected ${nextSeq}, got ${events[0]!.seq}`);
    }
    const mergedRecords = [...existing.records, ...packed];
    const merged = decodeRecords(mergedRecords);
    const rev = revisionFor(merged, existing.header);
    this.sessions.set(k, { header: existing.header, records: mergedRecords, revision: rev });
  }

  async commitRepair(
    meta: SessionHeader,
    tornMarker: string | undefined,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    const k = this.key(meta.id);
    const entry = this.sessions.get(k);
    if (!entry) return;
    let events = this.decoded(entry);
    if (tornMarker !== undefined) {
      const cut = Number.parseInt(tornMarker, 10);
      if (Number.isFinite(cut)) {
        events = events.filter((e) => e.seq <= cut);
      }
    }
    if (closers.length > 0) {
      events = [...events, ...closers.map((e) => structuredClone(e))];
    }
    const records = packChunkRuns(events);
    const rev = revisionFor(events, entry.header);
    this.sessions.set(k, { header: entry.header, records, revision: rev });
  }

  async list(): Promise<SessionHeader[]> {
    return [...this.sessions.values()].map((e) => structuredClone(e.header));
  }

  async close(): Promise<void> {
    // noop
  }
}

// ---------------------------------------------------------------------------
// MySQL 后端
// ---------------------------------------------------------------------------

interface HeaderRow extends RowDataPacket {
  session_id: string;
  org_id: string;
  user_id: string;
  header_json: string;
  revision: string;
}

interface EventRow extends RowDataPacket {
  record_json: string;
  seq: number | string;
}

export class MysqlSessionStore implements PersistenceBackend<string> {
  readonly name = 'mysql';

  private readonly pool: Pool;
  private readonly physicalRoots: readonly string[];
  private readonly sessionsTable: string;
  private readonly eventsTable: string;
  private readonly ownerForSession?: ((sessionId: string) => SessionStoreOwner) | undefined;
  private readonly currentOwner?: (() => SessionStoreOwner) | undefined;
  private ownedPool = true;

  constructor(
    poolOrConfig: Pool | MysqlSessionStoreConfig,
    opts: {
      physicalRoots?: readonly string[] | undefined;
      sessionsTable?: string | undefined;
      eventsTable?: string | undefined;
      ownerForSession?: ((sessionId: string) => SessionStoreOwner) | undefined;
      currentOwner?: (() => SessionStoreOwner) | undefined;
    } = {},
  ) {
    if (typeof (poolOrConfig as Pool).execute === 'function') {
      this.pool = poolOrConfig as Pool;
      this.ownedPool = false;
    } else {
      const cfg = poolOrConfig as MysqlSessionStoreConfig;
      const options: PoolOptions = {
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        connectionLimit: cfg.connectionLimit ?? 10,
        charset: 'utf8mb4_unicode_ci',
        timezone: 'Z',
        dateStrings: true,
        jsonStrings: true,
        enableKeepAlive: true,
      };
      this.pool = createPool(options);
      this.ownedPool = true;
    }
    this.physicalRoots = opts.physicalRoots ?? (poolOrConfig as MysqlSessionStoreConfig).physicalRoots ?? [];
    this.sessionsTable = opts.sessionsTable ?? 'dsh_sessions';
    this.eventsTable = opts.eventsTable ?? 'dsh_session_events';
    this.ownerForSession = opts.ownerForSession;
    this.currentOwner = opts.currentOwner;
  }

  private tenantFor(header: SessionHeader): SessionStoreOwner {
    if (this.ownerForSession) return this.ownerForSession(String(header.id));
    const extra = header as unknown as { orgId?: string; userId?: string };
    // 仅供直接 backend 单测；生产装配总是传 ownerForSession 并 fail-closed。
    const orgId = extra.orgId ?? 'default-org';
    const userId = extra.userId ?? 'default-user';
    assertTenant(orgId, userId);
    return { orgId, userId };
  }

  private tenantForId(id: SessionId): SessionStoreOwner {
    if (this.ownerForSession) return this.ownerForSession(String(id));
    return { orgId: 'default-org', userId: 'default-user' };
  }

  async loadStored(id: SessionId): Promise<StoredPrefix<string> | undefined> {
    try {
      const tenant = this.tenantForId(id);
      const [hRows] = await this.pool.execute(
        `SELECT session_id, org_id, user_id, header_json, revision FROM ${this.sessionsTable} WHERE session_id = ? AND org_id = ? AND user_id = ?`,
        [String(id), tenant.orgId, tenant.userId],
      );
      const h = (hRows as HeaderRow[])[0];
      if (!h) return undefined;
      const header = parseJsonColumn(h.header_json, 'header_json') as SessionHeader;
      const [eRows] = await this.pool.execute(
        `SELECT record_json, seq FROM ${this.eventsTable} WHERE session_id = ? AND org_id = ? AND user_id = ? ORDER BY seq ASC`,
        [String(id), tenant.orgId, tenant.userId],
      );
      const events: SessionEvent[] = [];
      for (const r of eRows as EventRow[]) {
        const parsed = parseJsonColumn(r.record_json, 'record_json');
        events.push(...decodeStorageRecord(parsed));
      }
      // 校验连续性：DSH 要求 seq 连续
      for (let i = 1; i < events.length; i++) {
        if (events[i]!.seq !== events[i - 1]!.seq + 1) {
          // 视为 torn：返回前缀与 marker
          const tornAt = events[i - 1]!.seq;
          return {
            meta: header,
            events: events.slice(0, i),
            revision: toRevision(h.revision),
            tornMarker: String(tornAt),
          };
        }
      }
      return {
        meta: header,
        events,
        revision: toRevision(h.revision),
      } as StoredPrefix<string>;
    } catch (err: unknown) {
      throw redactErr(err, this.physicalRoots);
    }
  }

  async readStoredRevision(id: SessionId): Promise<ReturnType<typeof SessionPersistenceRevision> | undefined> {
    try {
      const tenant = this.tenantForId(id);
      const [rows] = await this.pool.execute(
        `SELECT revision FROM ${this.sessionsTable} WHERE session_id = ? AND org_id = ? AND user_id = ?`,
        [String(id), tenant.orgId, tenant.userId],
      );
      const r = (rows as HeaderRow[])[0];
      if (!r) return undefined;
      return toRevision(r.revision);
    } catch (err: unknown) {
      throw redactErr(err, this.physicalRoots);
    }
  }

  async loadStoredFrom(id: SessionId, fromSeq: number): Promise<StoredSuffix | undefined> {
    // packed 行的 seq 列是 seq0，不能按 SQL seq>=from 截，必须解码后再滤。
    try {
      const stored = await this.loadStored(id);
      if (!stored) return undefined;
      return { meta: stored.meta, events: stored.events.filter((e) => e.seq >= fromSeq) };
    } catch (err: unknown) {
      throw redactErr(err, this.physicalRoots);
    }
  }

  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    for (const e of events) {
      if (!isJsonValue(e.data)) {
        throw new Error(`non-serializable event data: ${e.type} seq ${e.seq}`);
      }
    }
    const packed = packChunkRuns([...events]);
    const bytes = Buffer.byteLength(JSON.stringify(packed), 'utf8');
    if (bytes > MAX_SESSION_BYTES) {
      throw new Error(`session capacity exceeded: ${bytes} > ${MAX_SESSION_BYTES}`);
    }

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      // 懒物化或校验 next-seq
      const tenant = this.tenantFor(meta);
      const [hRows] = await conn.execute(
        `SELECT session_id, revision FROM ${this.sessionsTable} WHERE session_id = ? AND org_id = ? AND user_id = ? FOR UPDATE`,
        [String(meta.id), tenant.orgId, tenant.userId],
      );
      const existing = (hRows as HeaderRow[])[0];
      if (!isMaterialized && !existing) {
        const rev = revisionFor(decodeRecords(packed), meta);
        await conn.execute(
          `INSERT INTO ${this.sessionsTable} (session_id, org_id, user_id, header_json, revision) VALUES (?, ?, ?, ?, ?)`,
          [String(meta.id), tenant.orgId, tenant.userId, JSON.stringify(meta), rev],
        );
        for (const rec of packed) {
          await conn.execute(
            `INSERT INTO ${this.eventsTable} (session_id, org_id, user_id, seq, record_json) VALUES (?, ?, ?, ?, ?)`,
            [String(meta.id), tenant.orgId, tenant.userId, recordSeq(rec), JSON.stringify(rec)],
          );
        }
        await conn.commit();
        return;
      }
      if (!existing) {
        await conn.rollback();
        throw new Error(`appendBatch: session not materialized: ${String(meta.id)}`);
      }
      const already = await this.loadStoredEventsForRevision(conn, String(meta.id), tenant);
      const nextSeq = already.length > 0 ? Math.max(...already.map((e) => e.seq)) + 1 : 0;
      if (events.length > 0 && events[0]!.seq !== nextSeq) {
        await conn.rollback();
        throw new Error(`appendBatch seq mismatch: expected ${nextSeq}, got ${events[0]!.seq}`);
      }
      for (const rec of packed) {
        await conn.execute(
          `INSERT INTO ${this.eventsTable} (session_id, org_id, user_id, seq, record_json) VALUES (?, ?, ?, ?, ?)`,
          [String(meta.id), tenant.orgId, tenant.userId, recordSeq(rec), JSON.stringify(rec)],
        );
      }
      // 更新 revision
      const allEvents = await this.loadStoredEventsForRevision(conn, String(meta.id), tenant);
      const rev = revisionFor(allEvents, meta);
      await conn.execute(
        `UPDATE ${this.sessionsTable} SET revision = ?, header_json = ? WHERE session_id = ? AND org_id = ? AND user_id = ?`,
        [rev, JSON.stringify(meta), String(meta.id), tenant.orgId, tenant.userId],
      );
      await conn.commit();
    } catch (err: unknown) {
      try {
        await conn.rollback();
      } catch {}
      throw redactErr(err, this.physicalRoots);
    } finally {
      conn.release();
    }
  }

  private async loadStoredEventsForRevision(conn: { execute: (...args: unknown[]) => Promise<any> }, sessionId: string, tenant: SessionStoreOwner): Promise<SessionEvent[]> {
    const [rows] = await conn.execute(
      `SELECT record_json FROM ${this.eventsTable} WHERE session_id = ? AND org_id = ? AND user_id = ? ORDER BY seq ASC`,
      [sessionId, tenant.orgId, tenant.userId],
    );
    const events: SessionEvent[] = [];
    for (const r of rows as EventRow[]) {
      const parsed = parseJsonColumn(r.record_json, 'record_json');
      events.push(...decodeStorageRecord(parsed));
    }
    return events;
  }

  async commitRepair(
    meta: SessionHeader,
    tornMarker: string | undefined,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const tenant = this.tenantFor(meta);
      let events = await this.loadStoredEventsForRevision(conn, String(meta.id), tenant);
      if (tornMarker !== undefined) {
        const cut = Number.parseInt(tornMarker, 10);
        if (Number.isFinite(cut)) {
          events = events.filter((e) => e.seq <= cut);
        }
      }
      if (closers.length > 0) {
        events = [...events, ...closers];
      }
      await conn.execute(
        `DELETE FROM ${this.eventsTable} WHERE session_id = ? AND org_id = ? AND user_id = ?`,
        [String(meta.id), tenant.orgId, tenant.userId],
      );
      const packed = packChunkRuns(events);
      for (const rec of packed) {
        await conn.execute(
          `INSERT INTO ${this.eventsTable} (session_id, org_id, user_id, seq, record_json) VALUES (?, ?, ?, ?, ?)`,
          [String(meta.id), tenant.orgId, tenant.userId, recordSeq(rec), JSON.stringify(rec)],
        );
      }
      const rev = revisionFor(events, meta);
      await conn.execute(
        `UPDATE ${this.sessionsTable} SET revision = ? WHERE session_id = ? AND org_id = ? AND user_id = ?`,
        [rev, String(meta.id), tenant.orgId, tenant.userId],
      );
      await conn.commit();
    } catch (err: unknown) {
      try {
        await conn.rollback();
      } catch {}
      throw redactErr(err, this.physicalRoots);
    } finally {
      conn.release();
    }
  }

  async list(): Promise<SessionHeader[]> {
    try {
      const owner = this.currentOwner?.();
      const [rows] = owner
        ? await this.pool.execute(
            `SELECT header_json FROM ${this.sessionsTable} WHERE org_id = ? AND user_id = ? ORDER BY created_at DESC`,
            [owner.orgId, owner.userId],
          )
        : await this.pool.execute(
            `SELECT header_json FROM ${this.sessionsTable} ORDER BY created_at DESC`,
          );
      return (rows as HeaderRow[]).map((r) => parseJsonColumn(r.header_json, 'header_json') as SessionHeader);
    } catch (err: unknown) {
      throw redactErr(err, this.physicalRoots);
    }
  }

  async close(): Promise<void> {
    if (this.ownedPool) {
      await this.pool.end();
    }
  }
}
