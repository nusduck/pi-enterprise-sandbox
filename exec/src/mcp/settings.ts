/**
 * `sandbox-mcp` 进程自己的配置。移植自 `sandbox/mcp/settings.py`。
 *
 * facade 的凭据与 Sandbox API、Agent 的凭据分开：它是唯一对外暴露的面，
 * 泄漏一个 token 不应该顺带交出内部面。
 *
 * ## Model Experience
 * 模型看不到配置本身，但 `maxCodeLength` / `maxCommandLength` /
 * `maxFileSizeBytes` / `maxTimeoutSeconds` 决定它的调用会不会在到达执行面
 * 之前就被拒绝，拒绝理由是稳定短句，不含任何配置值。
 *
 * ## Known Limitations and Deferred Work
 * - 只读进程环境变量，不读设置文件、不热重载（与 ADR 0007 D6 的凭据 provider
 *   同一条理由：多租户下的热重载设置文件是配置漂移面）。
 */

export interface McpSettings {
  readonly token: string;
  readonly internalToken: string;
  readonly downloadSecret: string;
  readonly sandboxBaseUrl: string;
  readonly publicBaseUrl: string;
  readonly redisUrl: string;
  readonly clientId: string;
  readonly tenantId: string;
  readonly contextTtlSeconds: number;
  readonly lockTtlSeconds: number;
  readonly artifactTtlSeconds: number;
  readonly maxTimeoutSeconds: number;
  readonly maxCodeLength: number;
  readonly maxCommandLength: number;
  readonly maxFileSizeBytes: number;
  readonly redisPrefix: string;
}

export type Env = Record<string, string | undefined>;

function str(env: Env, name: string, fallback: string): string {
  const raw = env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

/**
 * 正整数字段。空缺取默认值；给了但不是正整数就抛——静默回落到默认值会让一个
 * 打错的上限变成"看起来生效了"。
 */
function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadMcpSettings(env: Env = process.env): McpSettings {
  return {
    token: str(env, 'SANDBOX_MCP_TOKEN', ''),
    internalToken: str(env, 'SANDBOX_MCP_INTERNAL_TOKEN', ''),
    downloadSecret: str(env, 'SANDBOX_MCP_DOWNLOAD_SECRET', ''),
    sandboxBaseUrl: str(env, 'SANDBOX_MCP_SANDBOX_BASE_URL', 'http://sandbox:8081'),
    publicBaseUrl: str(env, 'SANDBOX_MCP_PUBLIC_BASE_URL', ''),
    // Python 版用 AliasChoices 接受这两个名字，顺序不能反。
    redisUrl: str(env, 'SANDBOX_MCP_REDIS_URL', str(env, 'REDIS_URL', '')),
    clientId: str(env, 'SANDBOX_MCP_CLIENT_ID', 'upagent'),
    tenantId: str(env, 'SANDBOX_MCP_TENANT_ID', 'default'),
    contextTtlSeconds: positiveInt(env, 'SANDBOX_MCP_CONTEXT_TTL_SECONDS', 7 * 24 * 3600),
    lockTtlSeconds: positiveInt(env, 'SANDBOX_MCP_LOCK_TTL_SECONDS', 15),
    artifactTtlSeconds: positiveInt(env, 'SANDBOX_MCP_ARTIFACT_TTL_SECONDS', 24 * 3600),
    maxTimeoutSeconds: positiveInt(env, 'SANDBOX_MCP_MAX_TIMEOUT_SECONDS', 300),
    maxCodeLength: positiveInt(env, 'SANDBOX_MCP_MAX_CODE_LENGTH', 200_000),
    maxCommandLength: positiveInt(env, 'SANDBOX_MCP_MAX_COMMAND_LENGTH', 20_000),
    maxFileSizeBytes: positiveInt(env, 'SANDBOX_MCP_MAX_FILE_SIZE_BYTES', 10 * 1024 * 1024),
    redisPrefix: str(env, 'SANDBOX_MCP_REDIS_PREFIX', 'sandbox:mcp:v1'),
  };
}

/**
 * 四个必需的密钥缺一不可。fail-closed：缺配置时服务起不来，而不是起来了
 * 用空 token 比对（空 token 会让 bearer 检查恒假，但那是靠巧合而不是靠设计）。
 */
export function validateRuntime(settings: McpSettings): void {
  const missing = (
    [
      ['SANDBOX_MCP_TOKEN', settings.token],
      ['SANDBOX_MCP_INTERNAL_TOKEN', settings.internalToken],
      ['SANDBOX_MCP_DOWNLOAD_SECRET', settings.downloadSecret],
      ['SANDBOX_MCP_REDIS_URL', settings.redisUrl],
    ] as const
  )
    .filter(([, value]) => value.trim() === '')
    .map(([name]) => name);
  if (missing.length > 0) throw new Error('MCP service is not configured');
}
