/**
 * 智能体可见范围的判定（design `docs/design/agent-visibility.md` §4）。
 *
 * 规则只有三条：
 * 1. admin 能用本 org 的全部智能体（要能配置、试用受限智能体）；
 * 2. `visibility=org` 的智能体本 org 全员可用（迁移前的行为）；
 * 3. `visibility=restricted` 只有 `tbl_agsvc_agent_user_grants` 里的成员可用。
 *
 * 不可用一律 **404**（与不存在、跨租户同形）：存在性本身不能泄漏（AGENTS.md §2）。
 * 判定在每个**使用入口**都要做——列表、显式选择、已绑定会话的后续轮次、定时任务——
 * 只过滤列表等于把「看不到」当成「用不了」，直接调 API 仍能用。
 * 撤销授予对已绑定的会话也立即生效：下一轮就 404，不等会话自然结束。
 */

import { ROLE_ADMIN, hasRole } from '../domain/identity/roles.js';
import { isUlid } from '../domain/shared/ulid.js';
import { OwnerScopedNotFoundError, ValidationError } from './errors.js';
import { DEFAULT_AGENT_DEFINITION_NAME } from '../infrastructure/mysql/repositories/agent-catalog-repository.js';
import type { AgentVisibility } from '../infrastructure/mysql/repositories/agent-access-repository.js';

/** 过渡期宽松类型：仓储工厂产物的形状由各自模块负责。 */
type Loose = any;

export interface AgentAccessActor {
  readonly userId: string;
  /** BFF 解析后写入的 `X-Acting-Role`（逗号集合）；缺失按普通成员处理。 */
  readonly role?: unknown;
}

export const AGENT_VISIBILITIES: readonly AgentVisibility[] = ['org', 'restricted'];
/** 单个智能体的授予上限：防止一次请求写入失控的名单。 */
export const MAX_AGENT_GRANTS = 500;

export function agentNotFound(agentId: unknown): OwnerScopedNotFoundError {
  return new OwnerScopedNotFoundError('Agent not found', {
    resource: 'agent_definitions',
    id: String(agentId),
  });
}

export function isRestricted(definition: { visibility?: unknown } | null | undefined): boolean {
  return definition?.visibility === 'restricted';
}

/** 这个调用者能不能用这个智能体（调用方已确认同 org）。 */
export async function canUseAgent(
  repos: Loose,
  definition: { agentId: string; visibility?: unknown },
  actor: AgentAccessActor,
): Promise<boolean> {
  if (!isRestricted(definition)) return true;
  if (hasRole({ role: actor.role }, ROLE_ADMIN)) return true;
  // 账本没接上就不能判定：fail-closed 抛错，而不是当作「有授予」放行。
  if (!repos?.agentAccess) throw new Error('agent access ledger is not wired');
  return repos.agentAccess.hasGrant(definition.agentId, actor.userId);
}

export async function assertAgentUsable(
  repos: Loose,
  definition: { agentId: string; visibility?: unknown },
  actor: AgentAccessActor,
): Promise<void> {
  if (!(await canUseAgent(repos, definition, actor))) throw agentNotFound(definition.agentId);
}

/** 列表过滤：一次查出授予集合，不逐个回表。 */
export async function filterUsableAgents<T extends { agentId: string; visibility?: unknown }>(
  repos: Loose,
  orgId: string,
  definitions: readonly T[],
  actor: AgentAccessActor,
): Promise<T[]> {
  if (hasRole({ role: actor.role }, ROLE_ADMIN)) return [...definitions];
  if (!definitions.some(isRestricted)) return [...definitions];
  const granted: Set<string> = await repos.agentAccess.listGrantedAgentIds(orgId, actor.userId);
  return definitions.filter((definition) => !isRestricted(definition) || granted.has(definition.agentId));
}

/**
 * 校验管理员提交的可见范围：`{ visibility, user_ids }`。
 * 默认智能体不能受限——它是「没选智能体」时的兜底，受限会让成员无智能体可用。
 * 名单里每个人都必须是本 org 的活跃成员；未知的人不做「忽略」，整单 422。
 */
export async function normalizeAccessInput(
  repos: Loose,
  orgId: string,
  definition: { name: string },
  body: unknown,
): Promise<{ visibility: AgentVisibility; userIds: string[] }> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Access body must be an object');
  }
  const input = body as Record<string, unknown>;
  const visibility = input.visibility;
  if (typeof visibility !== 'string' || !AGENT_VISIBILITIES.includes(visibility as AgentVisibility)) {
    throw new ValidationError('visibility must be "org" or "restricted"');
  }
  const raw = input.user_ids ?? input.userIds ?? [];
  if (!Array.isArray(raw) || raw.some((id) => !isUlid(id))) {
    throw new ValidationError('user_ids must be an array of member ids');
  }
  const userIds = [...new Set(raw as string[])];
  if (userIds.length > MAX_AGENT_GRANTS) {
    throw new ValidationError(`At most ${MAX_AGENT_GRANTS} members can be granted`);
  }
  if (visibility === 'restricted' && definition.name === DEFAULT_AGENT_DEFINITION_NAME) {
    throw new ValidationError('The default agent must stay visible to the whole organization');
  }
  if (visibility === 'org') return { visibility, userIds: [] };
  const members: Set<string> = await repos.agentAccess.activeMemberIds(orgId, userIds);
  const unknown = userIds.filter((id) => !members.has(id));
  if (unknown.length) {
    throw new ValidationError(`Not active members of this organization: ${unknown.join(', ')}`);
  }
  return { visibility: visibility as AgentVisibility, userIds };
}

export function presentAccess(
  definition: { agentId: string; visibility?: unknown },
  grants: ReadonlyArray<{ userId: string; username: string | null; displayName: string | null; grantedAt: string | null }>,
) {
  return {
    agent_id: definition.agentId,
    visibility: isRestricted(definition) ? 'restricted' : 'org',
    grants: grants.map((grant) => ({
      user_id: grant.userId,
      username: grant.username,
      display_name: grant.displayName,
      granted_at: grant.grantedAt,
    })),
  };
}
