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

export const DELEGATION_KEYS = Object.freeze(['agents']);

export interface DelegationConfig {
  /** 同 org 内可委派的 Agent `name`，已 trim、去重、保序。 */
  readonly agents: readonly string[];
}

export interface DelegationDiagnostic {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export const EMPTY_DELEGATION: DelegationConfig = Object.freeze({
  agents: Object.freeze([]) as readonly string[],
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

  if (errors.length > 0) return { config: null, errors };
  return { config: Object.freeze({ agents: Object.freeze(agents) }), errors };
}

/** 规范化后写回配置的形状；不可委派时返回 `undefined`（键整个省略）。 */
export function normalizedDelegation(config: DelegationConfig): Record<string, unknown> | undefined {
  if (config.agents.length === 0) return undefined;
  return { agents: [...config.agents] };
}
