/**
 * 数据源（沙箱内连接业务库）的两侧共用契约（design `sandbox-data-sources.md`）。
 *
 * 授权权威在 Agent：AgentVersion 的 `dataSources` 决定一个 Run 能用哪些库。Agent 在
 * Run 开始时得到 id 清单，随每个内部 shell 请求交给 exec；清单进 `body_sha256`，与
 * `enabledSkills` 一样受 HMAC 覆盖。exec 只挂清单点名、且目录里登记过的数据源。
 *
 * 清单只含 id：地址、账号、口令永远不经过这条通道。
 *
 * 数据源目录（`SANDBOX_DATA_SOURCES_JSON`）的解析也在这里：exec 用它建转发，Agent 用它
 * 校验配置、给配置面列可选项。两侧同一套规则，不会出现「Agent 收下、exec 拒绝」的配置。
 * 目录不含口令（口令只由 exec 向 DBPM 取），Agent 对外只投影 id / 名称 / 说明 / 引擎。
 */

import { ContractError } from './errors.js';

/** 数据源 id：小写开头，也是子进程环境变量名的一段（大写后拼进 `DSH_DB_<ID>_*`）。 */
export const DATA_SOURCE_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** 单个请求可携带的数据源条数上限。 */
export const ENABLED_DATA_SOURCES_MAX = 16;
/** 沙箱内数据源 socket 的逻辑根：`/run/dsh-db/<id>/mysql.sock`。 */
export const DATA_SOURCE_MOUNT_ROOT = '/run/dsh-db';
/** 数据源注入的环境变量前缀。模型传入的同前缀键一律丢弃，不能伪造。 */
export const DATA_SOURCE_ENV_PREFIX = 'DSH_DB_';

/** 一期只支持 MySQL；字段为其他引擎预留。 */
export type DataSourceEngine = 'mysql';
export const DATA_SOURCE_ENGINES: readonly DataSourceEngine[] = ['mysql'];

/** 目录对外投影：不含地址、库名、账号与口令。 */
export interface DataSourceCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly engine: DataSourceEngine;
}

function invalid(message: string): ContractError {
  return new ContractError('ENVELOPE_INVALID', message);
}

/**
 * 校验请求携带的数据源清单。缺省（`undefined`/`null`）即空清单；其余形状错误一律拒绝，
 * 不静默丢弃——丢一个 id 等于让模型以为库不存在。重复 id 去重，保留首次出现的顺序。
 */
export function parseEnabledDataSources(raw: unknown): readonly string[] {
  if (raw === undefined || raw === null) return Object.freeze([]);
  if (!Array.isArray(raw)) throw invalid('dataSources must be an array');
  if (raw.length > ENABLED_DATA_SOURCES_MAX) {
    throw invalid(`dataSources must have at most ${ENABLED_DATA_SOURCES_MAX} entries`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !DATA_SOURCE_ID_PATTERN.test(item)) {
      throw invalid('dataSources entries must be data source ids');
    }
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return Object.freeze(out);
}

/** 数据源 id 对应的环境变量名前缀，例如 `employees` → `DSH_DB_EMPLOYEES_`。 */
export function dataSourceEnvPrefix(id: string): string {
  return `${DATA_SOURCE_ENV_PREFIX}${id.toUpperCase()}_`;
}

export class DataSourceConfigError extends Error {
  override name = 'DataSourceConfigError';
}

/** 一条登记。口令不在这里。 */
export interface DataSourceConfig {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly engine: DataSourceEngine;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly dbpmDbName: string;
  readonly userName: string;
}

const ALLOWED_KEYS = new Set([
  'id',
  'label',
  'description',
  'engine',
  'endpoint',
  'database',
  'dbpmDbName',
  'userName',
]);
/** 任何看起来像口令的键：出现即拒绝，而不是忽略。 */
const SECRET_KEY_RE = /pass|pwd|secret|token|credential/i;
const MAX_SOURCES = 32;
const MAX_TEXT = 200;
const NAME_RE = /^[^\s\p{Cc}]{1,128}$/u;

function fail(message: string): never {
  throw new DataSourceConfigError(`SANDBOX_DATA_SOURCES_JSON: ${message}`);
}

function text(value: unknown, field: string, id: string, required: boolean): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || (required && value.trim() === '') || value.length > MAX_TEXT) {
    fail(`${id}.${field} must be a ${required ? 'non-empty ' : ''}string of at most ${MAX_TEXT} characters`);
  }
  return value.trim();
}

function name(value: unknown, field: string, id: string): string {
  if (typeof value !== 'string' || !NAME_RE.test(value)) {
    fail(`${id}.${field} must be 1-128 characters without whitespace`);
  }
  return value;
}

function endpoint(value: unknown, id: string): { host: string; port: number } {
  if (typeof value !== 'string') fail(`${id}.endpoint must be host:port`);
  const m = /^([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]+\]):(\d{1,5})$/.exec(value);
  const port = m ? Number(m[2]) : 0;
  if (!m || port < 1 || port > 65535) fail(`${id}.endpoint must be host:port`);
  const host = m[1]!.startsWith('[') ? m[1]!.slice(1, -1) : m[1]!;
  return { host, port };
}

/** 解析并校验目录。未配置 → 空目录；配置了但任何一条不合法 → 拒绝启动。 */
export function readDataSourceCatalog(env: Readonly<Record<string, string | undefined>>): readonly DataSourceConfig[] {
  const raw = String(env['SANDBOX_DATA_SOURCES_JSON'] ?? '').trim();
  if (raw === '') return Object.freeze([]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('must be valid JSON');
  }
  if (!Array.isArray(parsed)) fail('must be a JSON array');
  if (parsed.length > MAX_SOURCES) fail(`must have at most ${MAX_SOURCES} entries`);

  const seen = new Set<string>();
  const out: DataSourceConfig[] = [];
  for (const [index, item] of parsed.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) fail(`entry ${index} must be an object`);
    const record = item as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (SECRET_KEY_RE.test(key)) {
        fail(`entry ${index} must not embed credentials (${key}); passwords come from DBPM`);
      }
      if (!ALLOWED_KEYS.has(key)) fail(`entry ${index} has unsupported key ${key}`);
    }
    const id = record['id'];
    if (typeof id !== 'string' || !DATA_SOURCE_ID_PATTERN.test(id)) {
      fail(`entry ${index}.id must match ${DATA_SOURCE_ID_PATTERN.source}`);
    }
    if (seen.has(id)) fail(`duplicate id ${id}`);
    seen.add(id);
    const engine = record['engine'] ?? 'mysql';
    if (!DATA_SOURCE_ENGINES.includes(engine as DataSourceEngine)) {
      fail(`${id}.engine must be one of ${DATA_SOURCE_ENGINES.join(', ')}`);
    }
    out.push(
      Object.freeze({
        id,
        label: text(record['label'], 'label', id, true),
        description: text(record['description'], 'description', id, false),
        engine: engine as DataSourceEngine,
        ...endpoint(record['endpoint'], id),
        database: name(record['database'], 'database', id),
        dbpmDbName: name(record['dbpmDbName'], 'dbpmDbName', id),
        userName: name(record['userName'], 'userName', id),
      }),
    );
  }
  return Object.freeze(out);
}

/** 对外投影（Agent 配置面）：不含地址、库名与账号。 */
export function catalogEntryOf(cfg: DataSourceConfig): DataSourceCatalogEntry {
  return { id: cfg.id, label: cfg.label, description: cfg.description, engine: cfg.engine };
}
