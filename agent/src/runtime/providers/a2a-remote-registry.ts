/**
 * `A2A_REMOTE_AGENTS_JSON` —— 运维登记的远端 A2A Agent（docs/design/a2a-remote-delegation.md D2）。
 *
 * 与 `MCP_SERVERS_JSON` 同一纪律：地址与凭据是部署面，不进 AgentVersion、不进数据库。
 * 凭据只写环境变量**名**（`authTokenRef`），明文在调用时从进程环境读，只活在内存里。
 *
 * 解析在启动时做，任何不合法都拒绝启动（fail-closed）：一条被静默跳过的登记，
 * 症状只会是「那个远端调不通」，没人会想到是配置被吞了。
 */

export const REMOTE_AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const DEFAULT_REMOTE_TIMEOUT_MS = 600_000;
export const MAX_REMOTE_TIMEOUT_MS = 3_600_000;
const MIN_REMOTE_TIMEOUT_MS = 1_000;
const ENTRY_KEYS = new Set([
  'id',
  'name',
  'description',
  'cardUrl',
  'authTokenRef',
  'timeoutMs',
  'enabled',
]);

export interface RemoteAgentEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly cardUrl: string;
  /** 环境变量名；值在调用时读。 */
  readonly authTokenRef: string;
  readonly timeoutMs: number;
}

export class RemoteAgentRegistryError extends Error {
  constructor(message: string) {
    super(`Invalid A2A_REMOTE_AGENTS_JSON: ${message}`);
    this.name = 'RemoteAgentRegistryError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalText(entry: Record<string, unknown>, key: string, where: string): string {
  const value = entry[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new RemoteAgentRegistryError(`${where}.${key} must be a string`);
  return value.trim();
}

/**
 * 解析登记表，只返回 `enabled !== false` 的条目。
 *
 * @param env 读 `A2A_REMOTE_AGENTS_JSON` 与各 `authTokenRef` 指向的变量
 * @param opts.production 生产环境拒绝 `http:`（凭据不能明文过网）
 */
export function parseRemoteAgentRegistry(
  env: Record<string, string | undefined>,
  opts: { production?: boolean } = {},
): readonly RemoteAgentEntry[] {
  const raw = String(env.A2A_REMOTE_AGENTS_JSON ?? '').trim();
  if (raw === '') return Object.freeze([]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RemoteAgentRegistryError((err as Error).message);
  }
  if (!Array.isArray(parsed)) throw new RemoteAgentRegistryError('must be a JSON array');

  const out: RemoteAgentEntry[] = [];
  const seen = new Set<string>();
  parsed.forEach((entry, index) => {
    const where = `[${index}]`;
    if (!isPlainObject(entry)) throw new RemoteAgentRegistryError(`${where} must be an object`);
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.has(key)) throw new RemoteAgentRegistryError(`${where}.${key} is not a known field`);
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      throw new RemoteAgentRegistryError(`${where}.enabled must be a boolean`);
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!REMOTE_AGENT_ID_PATTERN.test(id)) {
      throw new RemoteAgentRegistryError(`${where}.id must match ${REMOTE_AGENT_ID_PATTERN}`);
    }
    if (seen.has(id)) throw new RemoteAgentRegistryError(`duplicate id "${id}"`);
    seen.add(id);
    if (entry.enabled === false) return;

    const cardUrl = optionalText(entry, 'cardUrl', where);
    let url: URL;
    try {
      url = new URL(cardUrl);
    } catch {
      throw new RemoteAgentRegistryError(`${where}.cardUrl must be an absolute URL`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new RemoteAgentRegistryError(`${where}.cardUrl must be http(s)`);
    }
    if (url.protocol === 'http:' && opts.production) {
      throw new RemoteAgentRegistryError(`${where}.cardUrl must use https in production`);
    }
    if (url.username || url.password) {
      throw new RemoteAgentRegistryError(`${where}.cardUrl must not embed credentials; use authTokenRef`);
    }

    const authTokenRef = optionalText(entry, 'authTokenRef', where);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(authTokenRef)) {
      throw new RemoteAgentRegistryError(`${where}.authTokenRef must name an environment variable`);
    }
    if (!String(env[authTokenRef] ?? '').trim()) {
      throw new RemoteAgentRegistryError(`${where}.authTokenRef ${authTokenRef} is not set`);
    }

    let timeoutMs = DEFAULT_REMOTE_TIMEOUT_MS;
    if (entry.timeoutMs !== undefined) {
      const n = entry.timeoutMs;
      if (
        typeof n !== 'number' ||
        !Number.isSafeInteger(n) ||
        n < MIN_REMOTE_TIMEOUT_MS ||
        n > MAX_REMOTE_TIMEOUT_MS
      ) {
        throw new RemoteAgentRegistryError(
          `${where}.timeoutMs must be an integer in [${MIN_REMOTE_TIMEOUT_MS}, ${MAX_REMOTE_TIMEOUT_MS}]`,
        );
      }
      timeoutMs = n;
    }

    out.push(
      Object.freeze({
        id,
        name: optionalText(entry, 'name', where) || id,
        description: optionalText(entry, 'description', where),
        cardUrl: url.toString(),
        authTokenRef,
        timeoutMs,
      }),
    );
  });
  return Object.freeze(out);
}
