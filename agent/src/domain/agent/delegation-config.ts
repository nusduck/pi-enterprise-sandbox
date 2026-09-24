/**
 * AgentVersion `configJson.delegation`：本 Agent 可以把任务委派给谁
 * （docs/design/agent-delegation.md D2、a2a-remote-delegation.md D3）。
 *
 * 纯解析，三处共用：
 * - `bindAgentVersionConfig` —— 保存与 Run 启动两个时点 fail-closed；
 * - `AgentConfigValidator` —— 给配置面逐字段诊断；
 * - Run 执行期 —— 投影成本 Run 的白名单。
 *
 * 缺省（键不存在、`{}`、空数组）= 不可委派。
 */

/** 与 `agent_definitions.name` 的列宽一致（`agent-catalog-service.ts` requireName）。 */
export const DELEGATION_AGENT_NAME_MAX = 255;
/** 名单长度上限。名单会进系统提示，太长就是在给模型塞噪声。 */
export const DELEGATION_MAX_ENTRIES = 20;

export const DELEGATION_KEYS = Object.freeze(['agents', 'remoteAgents']);

/** 与 `A2A_REMOTE_AGENTS_JSON` 的 id 规则一致（a2a-remote-registry.ts）。 */
const REMOTE_AGENT_ID = /^[A-Za-z0-9_-]{1,32}$/;

export interface DelegationConfig {
  /** 同 org 内可委派的 Agent `name`，已 trim、去重、保序。 */
  readonly agents: readonly string[];
  /** 可调用的远端 A2A Agent id（`A2A_REMOTE_AGENTS_JSON` 登记表里的 id）。 */
  readonly remoteAgents: readonly string[];
}

export interface DelegationDiagnostic {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export const EMPTY_DELEGATION: DelegationConfig = Object.freeze({
  agents: Object.freeze([]) as readonly string[],
  remoteAgents: Object.freeze([]) as readonly string[],
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 解析并逐字段诊断。有任何诊断时 `config` 为 `null`——调用方不得拿半个名单去跑。
 */
export function parseDelegationConfig(raw: unknown): {
  config: DelegationConfig | null;
  errors: DelegationDiagnostic[];
} {
  const errors: DelegationDiagnostic[] = [];
  if (raw === undefined || raw === null) return { config: EMPTY_DELEGATION, errors };
  if (!isPlainObject(raw)) {
    errors.push({ path: 'delegation', code: 'CONFIG_TYPE', message: 'delegation must be an object' });
    return { config: null, errors };
  }
  for (const key of Object.keys(raw)) {
    if (!DELEGATION_KEYS.includes(key)) {
      errors.push({
        path: `delegation.${key}`,
        code: 'CONFIG_UNKNOWN_FIELD',
        message: `Unknown field "delegation.${key}"`,
      });
    }
  }

  const agents: string[] = [];
  const rawAgents = raw.agents;
  if (rawAgents !== undefined && !Array.isArray(rawAgents)) {
    errors.push({ path: 'delegation.agents', code: 'CONFIG_TYPE', message: 'delegation.agents must be an array of agent names' });
  } else if (Array.isArray(rawAgents)) {
    if (rawAgents.length > DELEGATION_MAX_ENTRIES) {
      errors.push({
        path: 'delegation.agents',
        code: 'CONFIG_LIMIT',
        message: `delegation.agents allows at most ${DELEGATION_MAX_ENTRIES} entries`,
      });
    }
    const seen = new Set<string>();
    rawAgents.forEach((entry, index) => {
      const path = `delegation.agents[${index}]`;
      const name = typeof entry === 'string' ? entry.trim() : '';
      if (!name || name.length > DELEGATION_AGENT_NAME_MAX) {
        errors.push({
          path,
          code: 'DELEGATION_AGENT_INVALID',
          message: `agent name must be a non-empty string of at most ${DELEGATION_AGENT_NAME_MAX} characters`,
        });
        return;
      }
      if (seen.has(name)) {
        errors.push({ path, code: 'DELEGATION_AGENT_DUPLICATE', message: `agent "${name}" is listed twice` });
        return;
      }
      seen.add(name);
      agents.push(name);
    });
  }

  const remoteAgents: string[] = [];
  const rawRemote = raw.remoteAgents;
  if (rawRemote !== undefined && !Array.isArray(rawRemote)) {
    errors.push({ path: 'delegation.remoteAgents', code: 'CONFIG_TYPE', message: 'delegation.remoteAgents must be an array of remote agent ids' });
  } else if (Array.isArray(rawRemote)) {
    if (rawRemote.length > DELEGATION_MAX_ENTRIES) {
      errors.push({
        path: 'delegation.remoteAgents',
        code: 'CONFIG_LIMIT',
        message: `delegation.remoteAgents allows at most ${DELEGATION_MAX_ENTRIES} entries`,
      });
    }
    const seen = new Set<string>();
    rawRemote.forEach((entry, index) => {
      const path = `delegation.remoteAgents[${index}]`;
      const id = typeof entry === 'string' ? entry.trim() : '';
      if (!REMOTE_AGENT_ID.test(id)) {
        errors.push({ path, code: 'DELEGATION_REMOTE_AGENT_INVALID', message: 'remote agent id must match [A-Za-z0-9_-]{1,32}' });
        return;
      }
      if (seen.has(id)) {
        errors.push({ path, code: 'DELEGATION_AGENT_DUPLICATE', message: `remote agent "${id}" is listed twice` });
        return;
      }
      seen.add(id);
      remoteAgents.push(id);
    });
  }

  if (errors.length > 0) return { config: null, errors };
  return {
    config: Object.freeze({ agents: Object.freeze(agents), remoteAgents: Object.freeze(remoteAgents) }),
    errors,
  };
}

/** 规范化后写回配置的形状；不可委派时返回 `undefined`（键整个省略）。 */
export function normalizedDelegation(config: DelegationConfig): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (config.agents.length > 0) out.agents = [...config.agents];
  if (config.remoteAgents.length > 0) out.remoteAgents = [...config.remoteAgents];
  return Object.keys(out).length > 0 ? out : undefined;
}
