/**
 * MCP Config Loader (plan §21 / PR-06).
 *
 * Parses and validates AgentVersion logical MCP refs only.
 * Never stores or returns plaintext secrets — secretRef only.
 * Never embeds secret values in error messages.
 *
 * Does NOT implement MCP protocol, tools/list, JSON-RPC, SSE, or fetch.
 */

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

export class McpConfigError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: Loose;
  details: Loose;

  constructor(message: string, opts: { code?: string, details?: Record<string, any> } = {}) {
    super(message);
    this.name = 'McpConfigError';
    this.code = opts.code ?? 'MCP_CONFIG_INVALID';
    this.details = opts.details ?? undefined;
  }
}

const DEFAULT_TIMEOUT_SEC = 60;
const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 300;

const SENSITIVE_KEY =
  /(?:^|_)(?:api[_-]?key|secret|password|authorization|bearer|access[_-]?token|refresh[_-]?token)(?:$|_)/i;

/** Mirrors enterprise-policy RISK_LEVELS; duplicated to keep this loader
 * dependency-free (it is imported by the risk classifier). */
const MCP_RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);

/**
 * Final tool name pattern after adapter registration (plan §21.1).
 * @param serverName
 * @param toolName
 */
export function mcpToolName(serverName: string, toolName: string) {
  return `mcp__${serverName}__${toolName}`;
}

/**
 * @param name
 * @returns {boolean}
 */
export function isValidMcpToolName(name: string) {
  return (
    typeof name === 'string' &&
    /^mcp__[A-Za-z0-9._-]+__[A-Za-z0-9._-]+$/.test(name)
  );
}

/**
 * @param value
 * @param field
 * @returns {number}
 */
function parseTimeoutSec(value: unknown, field: string) {
  if (value == null) return DEFAULT_TIMEOUT_SEC;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new McpConfigError(`${field} must be an integer seconds value`, {
      code: 'MCP_TIMEOUT_INVALID',
    });
  }
  if (n < MIN_TIMEOUT_SEC || n > MAX_TIMEOUT_SEC) {
    throw new McpConfigError(
      `${field} must be between ${MIN_TIMEOUT_SEC} and ${MAX_TIMEOUT_SEC} seconds (got ${n})`,
      { code: 'MCP_TIMEOUT_INVALID' },
    );
  }
  return n;
}

/**
 * Recursively reject plaintext secret-bearing keys.
 * `secretRef` is the only allowed secret-related field name (logical ref).
 * Never includes secret values in the error message.
 *
 * @param value
 * @param path
 * @param [depth]
 */
export function assertNoPlaintextSecrets(value: unknown, path: string, depth: number = 0) {
  if (depth > 12) {
    throw new McpConfigError(`${path} exceeds max nesting for secret scan`, {
      code: 'MCP_CONFIG_SHAPE',
    });
  }
  if (value == null) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoPlaintextSecrets(value[i], `${path}[${i}]`, depth + 1);
    }
    return;
  }
  if (typeof value !== 'object') return;

  const obj = (value as Record<string, unknown>);
  for (const key of Object.keys(obj)) {
    if (key === 'secretRef') {
      // Logical ref only — do not recurse into its string value as a secret map.
      continue;
    }
    if (
      key === 'env' ||
      key === 'headers' ||
      key === 'token' ||
      key === 'apiKey' ||
      key === 'api_key' ||
      SENSITIVE_KEY.test(key)
    ) {
      throw new McpConfigError(
        `${path}.${key} must not embed plaintext secrets (use secretRef)`,
        { code: 'MCP_PLAINTEXT_SECRET_FORBIDDEN' },
      );
    }
    assertNoPlaintextSecrets(obj[key], `${path}.${key}`, depth + 1);
  }
}

/**
 * @param raw
 * @returns {ReadonlyArray<{
 *   serverId: string,
 *   enabledTools: readonly string[],
 *   toolPolicy: Readonly<{ default: string } & Record<string, unknown>>,
 *   timeoutSec: number,
 *   secretRef: string | null,
 *   toolInputSchemas?: Readonly<Record<string, unknown>> | null,
 *   toolDescriptions?: Readonly<Record<string, string>> | null,
 * }>}
 */
export function loadMcpConfig(raw: unknown) {
  if (raw == null) {
    return Object.freeze([]);
  }

  let list = raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = (raw as Record<string, unknown>);
    if (Array.isArray(obj.mcpServers)) {
      list = obj.mcpServers;
    } else if (Array.isArray(obj.servers)) {
      list = obj.servers;
    } else {
      throw new McpConfigError(
        'mcp config must be an array or { mcpServers: [] }',
        { code: 'MCP_CONFIG_SHAPE' },
      );
    }
  }

  if (!Array.isArray(list)) {
    throw new McpConfigError('mcpServers must be an array', {
      code: 'MCP_CONFIG_SHAPE',
    });
  }

  const out: Array<Record<string, any>> = [];
  const seen = new Set();

  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    const path = `mcpServers[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new McpConfigError(`${path} must be an object`, {
        code: 'MCP_CONFIG_SHAPE',
      });
    }
    const e = (entry as Record<string, unknown>);
    assertNoPlaintextSecrets(e, path);

    const serverId = String(e.serverId ?? e.name ?? e.server_id ?? '').trim();
    if (!serverId) {
      throw new McpConfigError(`${path}.serverId is required (logical ref)`, {
        code: 'MCP_SERVER_ID_REQUIRED',
      });
    }
    if (!/^[A-Za-z0-9._-]+$/.test(serverId)) {
      throw new McpConfigError(
        `${path}.serverId must match [A-Za-z0-9._-]+ (got ${serverId})`,
        { code: 'MCP_SERVER_ID_INVALID' },
      );
    }
    if (seen.has(serverId)) {
      throw new McpConfigError(`duplicate mcp serverId: ${serverId}`, {
        code: 'MCP_SERVER_ID_DUPLICATE',
      });
    }
    seen.add(serverId);

    let enabledTools = [];
    if (e.enabledTools != null) {
      if (!Array.isArray(e.enabledTools)) {
        throw new McpConfigError(
          `${path}.enabledTools must be an array of tool names`,
          { code: 'MCP_ENABLED_TOOLS_INVALID' },
        );
      }
      enabledTools = e.enabledTools.map((t, j) => {
        const name = String(t ?? '').trim();
        if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
          throw new McpConfigError(
            `${path}.enabledTools[${j}] must be a simple tool name (not mcp__ prefixed)`,
            { code: 'MCP_ENABLED_TOOLS_INVALID' },
          );
        }
        if (name.startsWith('mcp__')) {
          throw new McpConfigError(
            `${path}.enabledTools[${j}] must be the bare tool name`,
            { code: 'MCP_ENABLED_TOOLS_INVALID' },
          );
        }
        return name;
      });
    }

    let toolPolicy: Record<string, unknown> = { default: 'allow' };
    if (e.toolPolicy != null) {
      if (typeof e.toolPolicy !== 'object' || Array.isArray(e.toolPolicy)) {
        throw new McpConfigError(`${path}.toolPolicy must be an object`, {
          code: 'MCP_TOOL_POLICY_INVALID',
        });
      }
      // Nested scan already done via assertNoPlaintextSecrets(e)
      toolPolicy = { default: 'allow', ...(e.toolPolicy as Record<string, any>) };
      const d = String(toolPolicy.default ?? 'allow');
      if (!['allow', 'deny', 'require_approval'].includes(d)) {
        throw new McpConfigError(
          `${path}.toolPolicy.default must be allow|deny|require_approval`,
          { code: 'MCP_TOOL_POLICY_INVALID' },
        );
      }
      toolPolicy.default = d;

      // Risk levels are validated here so a bad value fails at config load
      // rather than at the first tool call. The risk table itself is built by
      // buildMcpRiskBindings.
      if (toolPolicy.riskLevel != null) {
        const level = String(toolPolicy.riskLevel).trim().toLowerCase();
        if (!MCP_RISK_LEVELS.includes(level)) {
          throw new McpConfigError(
            `${path}.toolPolicy.riskLevel must be ${MCP_RISK_LEVELS.join('|')}`,
            { code: 'MCP_TOOL_POLICY_INVALID' },
          );
        }
        toolPolicy.riskLevel = level;
      }
      if (toolPolicy.toolRiskLevels != null) {
        if (
          typeof toolPolicy.toolRiskLevels !== 'object' ||
          Array.isArray(toolPolicy.toolRiskLevels)
        ) {
          throw new McpConfigError(
            `${path}.toolPolicy.toolRiskLevels must be an object map`,
            { code: 'MCP_TOOL_POLICY_INVALID' },
          );
        }
        const normalizedRisk: Record<string, string> = {};
        for (const [toolName, raw] of Object.entries(
          (toolPolicy.toolRiskLevels as Record<string, unknown>),
        )) {
          if (!/^[A-Za-z0-9._-]+$/.test(toolName)) {
            throw new McpConfigError(
              `${path}.toolPolicy.toolRiskLevels key "${toolName}" must be a bare tool name`,
              { code: 'MCP_TOOL_POLICY_INVALID' },
            );
          }
          const level = String(raw ?? '').trim().toLowerCase();
          if (!MCP_RISK_LEVELS.includes(level)) {
            throw new McpConfigError(
              `${path}.toolPolicy.toolRiskLevels.${toolName} must be ${MCP_RISK_LEVELS.join('|')}`,
              { code: 'MCP_TOOL_POLICY_INVALID' },
            );
          }
          normalizedRisk[toolName] = level;
        }
        toolPolicy.toolRiskLevels = normalizedRisk;
      }
    }

    const timeoutSec = parseTimeoutSec(
      e.timeoutSec ?? e.timeout ?? e.timeoutSeconds,
      `${path}.timeoutSec`,
    );

    let secretRef = null;
    if (e.secretRef != null) {
      secretRef = String(e.secretRef).trim();
      if (!secretRef) {
        throw new McpConfigError(
          `${path}.secretRef must be non-empty when set`,
          { code: 'MCP_SECRET_REF_INVALID' },
        );
      }
      if (/\s/.test(secretRef) || secretRef.length > 256) {
        throw new McpConfigError(`${path}.secretRef looks invalid`, {
          code: 'MCP_SECRET_REF_INVALID',
        });
      }
    }

    for (const tool of enabledTools) {
      const full = mcpToolName(serverId, tool);
      if (!isValidMcpToolName(full)) {
        throw new McpConfigError(`invalid projected tool name shape`, {
          code: 'MCP_TOOL_NAME_INVALID',
        });
      }
    }

    /** Optional per-tool JSON Schema from discovery (not AgentVersion config). */
    let toolInputSchemas = null;
    if (e.toolInputSchemas != null) {
      if (
        typeof e.toolInputSchemas !== 'object' ||
        Array.isArray(e.toolInputSchemas)
      ) {
        throw new McpConfigError(`${path}.toolInputSchemas must be an object map`, {
          code: 'MCP_CONFIG_SHAPE',
        });
      }
      toolInputSchemas = Object.freeze({
        ...(e.toolInputSchemas as Record<string, unknown>),
      });
    }

    /** Optional per-tool descriptions from discovery (not AgentVersion config). */
    let toolDescriptions = null;
    if (e.toolDescriptions != null) {
      if (
        typeof e.toolDescriptions !== 'object' ||
        Array.isArray(e.toolDescriptions)
      ) {
        throw new McpConfigError(`${path}.toolDescriptions must be an object map`, {
          code: 'MCP_CONFIG_SHAPE',
        });
      }
      const normalized: Record<string, string> = {};
      for (const [tool, raw] of Object.entries(
        (e.toolDescriptions as Record<string, unknown>),
      )) {
        if (typeof raw !== 'string') continue;
        const desc = raw.trim();
        if (desc) normalized[tool] = desc;
      }
      toolDescriptions = Object.freeze(normalized);
    }

    out.push(
      Object.freeze({
        serverId,
        enabledTools: Object.freeze([...enabledTools]),
        toolPolicy: Object.freeze({ ...toolPolicy }),
        timeoutSec,
        secretRef,
        toolInputSchemas,
        toolDescriptions,
      }),
    );
  }

  return Object.freeze(out);
}

/**
 * Parse config_json / configJson which may be an object or a JSON string.
 * Invalid JSON fails closed (no silent empty).
 *
 * @param raw
 * @param field
 * @returns {Record<string, unknown>}
 */
export function parseAgentVersionConfigJson(raw: unknown, field: string = 'configJson') {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new McpConfigError(
          `${field} JSON must be an object`,
          { code: 'MCP_CONFIG_JSON_INVALID' },
        );
      }
      return (parsed as Record<string, unknown>);
    } catch (err) {
      if (err instanceof McpConfigError) throw err;
      throw new McpConfigError(`${field} contains invalid JSON`, {
        code: 'MCP_CONFIG_JSON_INVALID',
      });
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return (raw as Record<string, unknown>);
  }
  throw new McpConfigError(`${field} must be an object or JSON string`, {
    code: 'MCP_CONFIG_JSON_INVALID',
  });
}

/**
 * Load MCP config from AgentVersion bound config / raw configJson.
 * @param agentVersionOrConfig
 */
export function loadMcpConfigFromAgentVersion(agentVersionOrConfig: Record<string, any> | null | undefined) {
  if (!agentVersionOrConfig) return loadMcpConfig([]);
  const v = (agentVersionOrConfig as Record<string, unknown>);
  if (Array.isArray(v)) return loadMcpConfig(v);
  if (Array.isArray(v.mcpServers)) return loadMcpConfig(v.mcpServers);

  let configObj = null;
  if (v.configJson != null) {
    configObj = parseAgentVersionConfigJson(v.configJson, 'configJson');
  } else if (v.config_json != null) {
    configObj = parseAgentVersionConfigJson(v.config_json, 'config_json');
  } else if (typeof v === 'object') {
    // Treat whole object as config when it already looks like configJson
    configObj = v;
  }

  const mcpServers =
    configObj && typeof configObj === 'object'
      ? configObj.mcpServers ?? []
      : [];
  return loadMcpConfig(mcpServers);
}
