/**
 * Operator-facing capability projection for the production extension
 * registry. This is configured inventory, not a second runtime authority.
 */

import path from 'node:path';

import { listInstalledSkills } from '../skills/install.js';
import { validateSkillPackage } from '../skills/validator.js';
import { buildRegistry } from '../infrastructure/model-registry.js';
import {
  ENTERPRISE_DEFAULT_TOOLS,
  REQUIRED_EXTENSION_NAMES,
} from '../infrastructure/dsh/constants.js';
import {
  coerceToolRiskPolicy,
  decisionForRiskLevel,
  resolveToolRiskLevel,
} from '../infrastructure/dsh/tool-risk-policy.js';
import { loadMcpServerRegistry } from '../infrastructure/mcp/mcp-server-registry.js';

const PRODUCT_PACKAGE = 'pi-enterprise-agent';
const PRODUCT_VERSION = '4.0.0';
const DEFAULT_PROFILE_ID = 'coding-agent';

function toolCategory(name) {
  if (['read', 'write', 'edit'].includes(name)) return 'file';
  if (name.startsWith('process_')) return 'process';
  if (name === 'submit_artifact') return 'artifact';
  return 'execution';
}

/**
 * Project the skill packages one caller can load, tagging each with the tier it
 * came from. `userSkillRoot` is that caller's own `<orgId>/<userId>` directory;
 * without it there is no user tier and everything reads as bundled.
 *
 * System roots are scanned first, so a user package can never mask a bundled
 * name in the listing — the same precedence installs already enforce.
 *
 * @param skillRoots
 * @param [userSkillRoot]
 */
function discoverSkills(skillRoots: string[], userSkillRoot: string | null = null) {
  const userRoot = userSkillRoot ? path.resolve(String(userSkillRoot)) : null;
  const discovered = new Map();
  for (const rawRoot of skillRoots || []) {
    const root = path.resolve(String(rawRoot));
    const source = userRoot && root === userRoot ? 'user-skill-root' : 'shared-skill-root';
    let names = [];
    try {
      names = listInstalledSkills(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (discovered.has(name)) continue;
      try {
        const metadata = validateSkillPackage(path.join(root, name));
        discovered.set(name, {
          name: metadata.name,
          description: metadata.description,
          enabled: true,
          status: 'configured',
          source,
          path: null,
          dynamic: true,
        });
      } catch {
        // Invalid packages are not executable and must not be advertised.
      }
    }
  }
  return [...discovered.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/**
 * 草稿包。**草稿在启用之后不会消失**——`enableDraftPackage()` 复制字节到已发布
 * 根，草稿留在原地当可编辑的源（停用只删副本，不删草稿，见 skills/enablement.ts）。
 *
 * 所以这里要把「已经发布过的草稿」标出来：否则同一个名字会在 UI 上出现两次，
 * 草稿那张卡还带着一个按了也没有新效果的「Enable」。
 *
 * @param draftSkillRoot 调用者自己的草稿根
 * @param publishedNames 已经挂载生效的包名（系统 + 用户两层）
 */
function discoverDraftSkills(
  draftSkillRoot: string | null = null,
  publishedNames: Iterable<string> = [],
) {
  if (!draftSkillRoot) return [];
  const published = new Set(publishedNames);
  return discoverSkills([draftSkillRoot]).map((skill) => ({
    ...skill,
    enabled: false,
    status: published.has(skill.name) ? 'published' : 'draft',
    source: 'draft-skill-root',
    // 已发布 = 这份草稿有一个同名的已启用副本在跑。两者可能已经不是同一份
    // 字节（模型可以继续改草稿），所以这只说明"发布过"，不说明"内容一致"。
    published: published.has(skill.name),
  }));
}

/** 单个 MCP server 的发现结果。/ready 与诊断端点都按这几个字段展开。 */
interface McpServerDiscovery {
  serverId?: string;
  status?: string;
  toolCount?: number;
  toolNames?: string[];
}

function projectMcpServers(
  rawServers: unknown,
  discovery: { servers?: McpServerDiscovery[] } | null = null,
) {
  const registry = loadMcpServerRegistry(rawServers || []);
  // Constructing a map from `any` would infer Map<unknown, unknown>; spell out
  // the element types instead.
  const discovered = new Map<string | undefined, McpServerDiscovery>(
    Array.isArray(discovery?.servers)
      ? discovery.servers.map((server) => [server.serverId, server])
      : [],
  );
  return [...registry.values()]
    .map((server) => {
      const enabled = server.enabled !== false;
      const result = discovered.get(server.serverId);
      const hasCredentialReference = Boolean(
        server.authTokenRef ||
          Object.keys(server.envRefs || {}).length > 0 ||
          Object.keys(server.headerRefs || {}).length > 0,
      );
      return {
        server_id: server.serverId,
        id: server.serverId,
        name: server.serverId,
        enabled,
        status: enabled ? result?.status ?? 'configured' : 'disabled',
        connection_status: enabled ? result?.status ?? 'configured' : 'disabled',
        transport: server.command ? 'stdio' : 'streamable-http',
        authorization: hasCredentialReference ? 'host-injected' : 'none',
        tool_count: result?.toolCount ?? null,
        tools: result?.toolNames ?? [],
        dynamic: false,
      };
    })
    .sort((a, b) => a.server_id.localeCompare(b.server_id));
}

/**
 * Preserve the existing capabilities UI response contract while projecting
 * only current production configuration. Per-Run live truth remains in the
 * immutable AgentVersion, DSH runtime, and durable tool ledger.
 *
 * @param {{
 *   profileId?: string,
 *   skillRoots?: string[],
 *   userSkillRoot?: string | null,
 *   draftSkillRoot?: string | null,
 *   mcpServers?: object[] | string,
 *   mcpDiscovery?: { servers?: object[], ready?: boolean, toolCount?: number },
 *   models?: Iterable<object>,
 *   toolRiskPolicy?: object,
 *   now?: () => Date,
 * }} [options]
 */
export function getExtensionDiagnostics(options: { profileId?: string, skillRoots?: string[], userSkillRoot?: string | null, draftSkillRoot?: string | null, mcpServers?: Record<string, any>[] | string, mcpDiscovery?: { servers?: Record<string, any>[], ready?: boolean, toolCount?: number }, models?: Iterable<Record<string, any>>, toolRiskPolicy?: Record<string, any>, now?: () => Date, } = {}) {
  const profileId = String(
    options.profileId || DEFAULT_PROFILE_ID,
  ).trim();
  if (profileId !== DEFAULT_PROFILE_ID) {
    throw new Error(`Unknown diagnostics profile: ${profileId}`);
  }

  const skills = discoverSkills(
    options.skillRoots || [],
    options.userSkillRoot ?? null,
  );
  const skillDrafts = discoverDraftSkills(
    options.draftSkillRoot ?? null,
    skills.map((skill) => skill.name),
  );
  const mcpServers = projectMcpServers(
    options.mcpServers || [],
    options.mcpDiscovery,
  );
  const models = options.models
    ? [...options.models]
    : [...buildRegistry().values()];
  // Report the risk level and approval outcome the policy engine will actually
  // produce, so the capabilities view is a readback of the configured risk
  // table rather than a second hardcoded opinion.
  const riskPolicy = coerceToolRiskPolicy(options.toolRiskPolicy);
  const describeRisk = (name, cls) => {
    const { riskLevel, source } = resolveToolRiskLevel(name, cls, riskPolicy);
    return {
      risk_level: riskLevel,
      risk_source: source,
      approval_policy: decisionForRiskLevel(riskLevel, riskPolicy),
    };
  };

  const tools = ENTERPRISE_DEFAULT_TOOLS.map((name) => ({
    name,
    enabled: true,
    status: 'configured',
    category: toolCategory(name),
    // 2026-08-31（计划 H8.5）：来源不再是那批已删除的 Pi Extension。
    // 这批名字来自 `runtime/policy/tool-names.ts` 的唯一事实源，
    // 与 boot 之后 `ctx.tools.schemas()` 的集合由 boot.test.ts 断言恰好相等。
    source: 'dsh-host-tools',
    ...describeRisk(name, { class: 'local_low' }),
    dynamic: false,
  })).concat(
    mcpServers.flatMap((server) =>
      (server.tools || []).map((toolName) => ({
        name: `mcp__${server.server_id}__${toolName}`,
        enabled: server.connection_status === 'connected',
        status: server.connection_status,
        category: 'execution',
        source: 'mcp',
        ...describeRisk(`mcp__${server.server_id}__${toolName}`, {
          class: 'external_high',
          serverId: server.server_id,
          tool: toolName,
        }),
        dynamic: false,
      })),
    ),
  );
  // Compatibility field retained for existing clients. The legacy Pi
  // Extension registry was deleted; DSH host tools are reported in `tools`.
  const extensions = [];

  return {
    status: 'ok',
    generated_at: (options.now || (() => new Date()))().toISOString(),
    view: 'configured',
    registry: {
      live: false,
      registry_version: null,
      run_id: null,
      conversation_id: null,
      session_id: null,
      profile_id: profileId,
      note:
        'Configured platform inventory. Per-Run live authority is the immutable AgentVersion and durable runtime ledger.',
      mcp_tools: tools.filter((tool) => tool.name.startsWith('mcp__')),
    },
    profile: {
      id: profileId,
      version: PRODUCT_VERSION,
      extensions: [...REQUIRED_EXTENSION_NAMES],
      allowed_tools: [...ENTERPRISE_DEFAULT_TOOLS],
      allowed_mcp_servers: mcpServers
        .filter((server) => server.enabled)
        .map((server) => server.server_id),
      allowed_mcp_tools: tools
        .filter((tool) => tool.name.startsWith('mcp__'))
        .map((tool) => tool.name),
      skills: skills.map((skill) => skill.name),
      shared_skills: { mode: 'all', names: [] },
      context_policy: { authority: 'agent-version' },
    },
    package: {
      package: PRODUCT_PACKAGE,
      version: PRODUCT_VERSION,
      profile_id: profileId,
      extensions: [...REQUIRED_EXTENSION_NAMES],
      audit: { status: 'built-in' },
    },
    extensions,
    tools,
    skills,
    skill_drafts: skillDrafts,
    mcp_servers: mcpServers,
    models,
  };
}
