/**
 * Agent 目录 API（`/api/agents`）。
 *
 * 前端只认 **agentId**，不认 agentVersionId：Agent 是稳定的产品概念，Version 是
 * 不可变的实现快照，哪个版本活跃由服务端在建会话的事务内解析
 * （`docs/design/multi-agent-selection.md` D1）。所以这里不缓存 active version，
 * 也不做任何"这个 Agent 属于我吗"的判断——那是 agent/ 的权威事实。
 */
import { z } from 'zod';
import { parseApi, parseApiStrict } from '../schemas/api';
import { ApiError, authHeaders } from './client';

const AgentSchema = z
  .object({
    agent_id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    status: z.string(),
    active_version_id: z.string().nullable().optional(),
    active_version_no: z.number().nullable().optional(),
    created_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
  })
  .passthrough();

const AgentListSchema = z
  .object({ agents: z.array(AgentSchema) })
  .passthrough();

const AgentVersionSchema = z
  .object({
    agent_version_id: z.string(),
    agent_id: z.string(),
    version_no: z.number(),
    config: z.record(z.string(), z.unknown()).optional(),
    config_hash: z.string().optional(),
    pi_sdk_version: z.string().optional(),
    status: z.string().optional(),
    created_at: z.string().nullable().optional(),
  })
  .passthrough();

const AgentVersionListSchema = z
  .object({ agent: AgentSchema, versions: z.array(AgentVersionSchema) })
  .passthrough();

const AgentMutationSchema = z
  .object({ agent: AgentSchema, version: AgentVersionSchema })
  .passthrough();

const ConfigDiagnosticSchema = z
  .object({
    path: z.string(),
    code: z.string(),
    message: z.string(),
  })
  .passthrough();

const ConfigOptionsSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    fieldSupport: z.record(z.string(), z.unknown()),
    platformConstraints: z.record(z.string(), z.unknown()),
    capabilityRevision: z.string().min(1),
  })
  .passthrough();

const ConfigValidationSchema = z
  .object({
    valid: z.boolean(),
    errors: z.array(ConfigDiagnosticSchema),
    warnings: z.array(ConfigDiagnosticSchema),
    normalizedConfig: z.record(z.string(), z.unknown()).optional(),
    effectiveSummary: z.unknown(),
    capabilityRevision: z.string().min(1),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.valid) {
      if (value.errors.length > 0) {
        context.addIssue({
          code: 'custom',
          path: ['errors'],
          message: 'valid=true responses must not contain errors',
        });
      }
      if (value.normalizedConfig === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['normalizedConfig'],
          message: 'valid=true responses must include normalizedConfig',
        });
      }
    } else if (value.normalizedConfig !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['normalizedConfig'],
        message: 'valid=false responses must not include normalizedConfig',
      });
    }
  });

export type Agent = z.infer<typeof AgentSchema>;
export type AgentVersion = z.infer<typeof AgentVersionSchema>;
export type AgentVersionList = z.infer<typeof AgentVersionListSchema>;
export type AgentMutation = z.infer<typeof AgentMutationSchema>;

export type ConfigDiagnostic = z.infer<typeof ConfigDiagnosticSchema>;
export type AgentConfigOptions = {
  schemaVersion: number;
  fieldSupport: Record<string, unknown>;
  platformConstraints: Record<string, unknown>;
  capabilityRevision: string;
  [key: string]: unknown;
};
export type AgentConfigValidation = {
  valid: boolean;
  errors: ConfigDiagnostic[];
  warnings: ConfigDiagnostic[];
  normalizedConfig?: Record<string, unknown>;
  effectiveSummary: unknown;
  capabilityRevision: string;
};

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`/api/agents${path}`, {
    ...init,
    headers: authHeaders(
      init?.body ? { 'Content-Type': 'application/json' } : {},
    ),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const body = payload as { error?: unknown; code?: unknown };
    throw new ApiError(
      typeof body.error === 'string' ? body.error : `Agent request failed (${response.status})`,
      {
        status: response.status,
        ...(typeof body.code === 'string' ? { code: body.code } : {}),
        detail: payload,
      },
    );
  }
  return payload;
}

/** org 内可选的智能体。任何成员都可读。 */
export async function listAgents(): Promise<Agent[]> {
  const parsed = parseApi(AgentListSchema, await request(''), 'agents');
  return parsed.agents;
}

/** 新建一个智能体（admin）。自带 v1 并指向它。 */
export async function createAgent(body: {
  name: string;
  description?: string | null;
  config?: Record<string, unknown>;
}): Promise<AgentMutation> {
  return parseApi(
    AgentMutationSchema,
    await request('', { method: 'POST', body: JSON.stringify(body) }),
    'createAgent',
  );
}

/** 某个智能体的版本线（admin）。 */
export async function listAgentVersions(agentId: string): Promise<AgentVersionList> {
  return parseApi(
    AgentVersionListSchema,
    await request(`/${encodeURIComponent(agentId)}/versions`),
    'agentVersions',
  );
}

/** 改配置 = 建新版本（admin）。`activate` 默认为真。 */
export async function createAgentVersion(
  agentId: string,
  body: {
    config: Record<string, unknown>;
    activate?: boolean;
    expected_active_version_id?: string | null;
  },
): Promise<AgentMutation> {
  return parseApi(
    AgentMutationSchema,
    await request(`/${encodeURIComponent(agentId)}/versions`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    'createAgentVersion',
  );
}

/** 切活跃版本，也是回滚（admin）。只影响**新建**的会话。 */
/**
 * 切活跃版本（也是回滚）。
 *
 * `expectedActiveVersionId` 显式传 `null` 表示「我读到的是还没有活跃版本」，
 * 与**不传**（`undefined`，跳过乐观并发检查的旧客户端兼容窗口）不是一回事，
 * 所以这里按 `undefined` 判断，不能用 `?? null` 把两者抹平。
 */
export async function setAgentActiveVersion(
  agentId: string,
  agentVersionId: string,
  expectedActiveVersionId?: string | null,
): Promise<AgentMutation> {
  return parseApi(
    AgentMutationSchema,
    await request(`/${encodeURIComponent(agentId)}/active-version`, {
      method: 'POST',
      body: JSON.stringify({
        agent_version_id: agentVersionId,
        ...(expectedActiveVersionId !== undefined
          ? { expected_active_version_id: expectedActiveVersionId }
          : {}),
      }),
    }),
    'setAgentActiveVersion',
  );
}

/** GET /api/agents/config/options — admin-scoped schema and platform limits. */
export async function getAgentConfigOptions(): Promise<AgentConfigOptions> {
  return parseApiStrict(
    ConfigOptionsSchema,
    await request('/config/options'),
    'agent config options',
  );
}

/**
 * POST /api/agents/config/validate — semantic validation without creating a
 * version, a run, a model request, or an MCP connection.
 */
export async function validateAgentConfig(
  config: Record<string, unknown>,
  options: {
    agentId?: string | null;
    signal?: AbortSignal;
  } = {},
): Promise<AgentConfigValidation> {
  const raw = parseApiStrict(
    ConfigValidationSchema,
    await request('/config/validate', {
      method: 'POST',
      signal: options.signal,
      body: JSON.stringify({
        config,
        ...(options.agentId ? { agent_id: options.agentId } : {}),
      }),
    }),
    'agent config validation',
  );
  return {
    ...raw,
    capabilityRevision: raw.capabilityRevision,
  };
}
