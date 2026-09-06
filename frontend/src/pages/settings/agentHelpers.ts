/**
 * Agents 管理页的纯函数部分：config 草稿的解析、格式化与"改了没有"的判定。
 *
 * 拆出来是为了能被 `test/` 直接测——页面本身要渲染 React，这里的规则不该只靠
 * 手点验证。服务端仍然会把同一份 config 再校验一遍（写入即校验），这里的解析
 * 只是让用户在按下按钮之前就看到 JSON 错在哪。
 */
import type { Agent, AgentVersion } from '../../shared/api';

export type ToolDecision = 'inherit' | 'allow' | 'require_approval' | 'deny';

export type ConfigFieldError = {
  path: string;
  code: string;
  message: string;
};

export type AgentConfigValidationState = {
  status: 'idle' | 'pending' | 'valid' | 'invalid' | 'unavailable';
  errors: ConfigFieldError[];
  warnings: ConfigFieldError[];
  normalizedConfig?: Record<string, unknown>;
  effectiveSummary?: unknown;
  capabilityRevision?: string | null;
  message?: string;
};

export type ConfigDraftResult =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; error: string };

/** 空文本 = 空配置，而不是错误：新建 Agent 时不填 config 是常见的。 */
export function parseAgentConfigDraft(text: string): ConfigDraftResult {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { ok: true, config: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: `Config must be valid JSON — ${(err as Error).message}` };
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Config must be a JSON object, not an array or scalar' };
  }
  return { ok: true, config: parsed as Record<string, unknown> };
}

/** 版本 config → 编辑框文本。稳定缩进，避免"只是换了个格式"的假 diff。 */
export function formatAgentConfig(config: Record<string, unknown> | undefined): string {
  return JSON.stringify(config ?? {}, null, 2);
}

/** Return a plain object without ever mutating the JSON editor's source value. */
export function cloneAgentConfig(config: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  } catch {
    return { ...config };
  }
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function policyOf(config: Record<string, unknown>): Record<string, unknown> {
  return plainObject(config.modelPolicy) ?? {};
}

/** Read the logical model policy while preserving absent vs explicitly blank. */
export function modelPolicyOf(config: Record<string, unknown>): Record<string, unknown> {
  return policyOf(config);
}

export function structuredEditorIssues(config: Record<string, unknown>): string[] {
  const issues: string[] = [];
  if (config.modelPolicy != null && !plainObject(config.modelPolicy)) {
    issues.push('modelPolicy must be an object');
  }
  const toolPolicy = config.toolPolicy;
  const toolPolicyObject = plainObject(toolPolicy);
  if (toolPolicy != null && !toolPolicyObject) {
    issues.push('toolPolicy must be an object');
  } else if (toolPolicyObject && toolPolicyObject.tools != null && !plainObject(toolPolicyObject.tools)) {
    issues.push('toolPolicy.tools must be an object');
  }
  if (config.mcpServers != null && !Array.isArray(config.mcpServers)) {
    issues.push('mcpServers must be an array');
  }
  return issues;
}

/** Update one supported model policy field in the shared JSON draft. */
export function setModelPolicyField(
  config: Record<string, unknown>,
  field: string,
  value: unknown,
): Record<string, unknown> {
  if (config.modelPolicy != null && !plainObject(config.modelPolicy)) return cloneAgentConfig(config);
  const next = cloneAgentConfig(config);
  const policy = { ...policyOf(next) };
  if (value === undefined || value === null || value === '') delete policy[field];
  else policy[field] = value;
  if (Object.keys(policy).length) next.modelPolicy = policy;
  else delete next.modelPolicy;
  return next;
}

export function setRootConfigField(
  config: Record<string, unknown>,
  field: string,
  value: unknown,
): Record<string, unknown> {
  const next = cloneAgentConfig(config);
  if (value === undefined || value === null || value === '') delete next[field];
  else next[field] = value;
  return next;
}

function normalizeDecision(value: unknown): ToolDecision {
  const raw = plainObject(value)?.decision ?? value;
  switch (String(raw ?? '').trim().toLowerCase()) {
    case 'allow':
      return 'allow';
    case 'require_approval':
    case 'approval':
    case 'ask':
      return 'require_approval';
    case 'deny':
      return 'deny';
    default:
      return 'inherit';
  }
}

/** Tool decisions explicitly set in the AgentVersion; absent means inherit. */
export function toolDecisionsOf(config: Record<string, unknown>): Record<string, ToolDecision> {
  const policy = plainObject(config.toolPolicy);
  if (!policy) return {};
  const tools = plainObject(policy.tools);
  const result: Record<string, ToolDecision> = {};
  if (tools) {
    for (const [name, value] of Object.entries(tools)) {
      const decision = normalizeDecision(value);
      if (decision !== 'inherit') result[name] = decision;
    }
  }
  // Legacy flat entries remain visible in the form and are retained in JSON.
  for (const [name, value] of Object.entries(policy)) {
    if (name === 'tools' || name === 'riskLevels' || name === 'classRiskLevels' || name === 'riskApproval') continue;
    const decision = normalizeDecision(value);
    if (decision !== 'inherit' && result[name] == null) result[name] = decision;
  }
  return result;
}

export function toolDecisionOf(config: Record<string, unknown>, name: string): ToolDecision {
  return toolDecisionsOf(config)[name] ?? 'inherit';
}

/** Set a tool's explicit decision; inherit removes only that known key. */
export function setToolDecision(
  config: Record<string, unknown>,
  name: string,
  decision: ToolDecision,
): Record<string, unknown> {
  if (config.toolPolicy != null && !plainObject(config.toolPolicy)) return cloneAgentConfig(config);
  const toolPolicyObject = plainObject(config.toolPolicy);
  if (
    toolPolicyObject &&
    toolPolicyObject.tools != null &&
    !plainObject(toolPolicyObject.tools)
  ) return cloneAgentConfig(config);
  const next = cloneAgentConfig(config);
  const rawPolicy = plainObject(next.toolPolicy);
  const policy = { ...(rawPolicy ?? {}) };
  const rawTools = plainObject(policy.tools);
  const tools = { ...(rawTools ?? {}) };
  // A key can be represented in either nested v1 or legacy flat form. Remove
  // both spellings so changing to inherit cannot leave a hidden override.
  delete policy[name];
  if (decision === 'inherit') delete tools[name];
  else tools[name] = decision;
  if (Object.keys(tools).length) policy.tools = tools;
  else if (rawTools) delete policy.tools;
  if (Object.keys(policy).length) next.toolPolicy = policy;
  else delete next.toolPolicy;
  return next;
}

export type McpConfigEntry = {
  serverId: string;
  enabledTools: string[];
  toolPolicy?: Record<string, unknown>;
  index: number;
};

function mcpServerId(value: unknown): string {
  const entry = plainObject(value);
  return String(entry?.serverId ?? entry?.server_id ?? entry?.id ?? entry?.name ?? '').trim();
}

/** Normalize only the display projection; the source JSON remains untouched. */
export function mcpEntriesOf(config: Record<string, unknown>): McpConfigEntry[] {
  if (!Array.isArray(config.mcpServers)) return [];
  return config.mcpServers.flatMap((value, index) => {
    const entry = plainObject(value);
    const serverId = mcpServerId(value);
    if (!entry || !serverId) return [];
    const enabledTools = Array.isArray(entry.enabledTools)
      ? entry.enabledTools.map(String).map((name) => name.trim()).filter(Boolean)
      : [];
    return [{
      serverId,
      enabledTools,
      toolPolicy: plainObject(entry.toolPolicy) ?? undefined,
      index,
    }];
  });
}

export function mcpEntryOf(
  config: Record<string, unknown>,
  serverId: string,
): McpConfigEntry | null {
  return mcpEntriesOf(config).find((entry) => entry.serverId === serverId) ?? null;
}

/** Select a server with an explicit, initially empty tool allowlist. */
export function setMcpServerSelected(
  config: Record<string, unknown>,
  serverId: string,
  selected: boolean,
): Record<string, unknown> {
  if (config.mcpServers != null && !Array.isArray(config.mcpServers)) return cloneAgentConfig(config);
  const next = cloneAgentConfig(config);
  const current = Array.isArray(next.mcpServers) ? next.mcpServers : [];
  const existing = current.find((value) => mcpServerId(value) === serverId);
  if (selected) {
    if (!existing) current.push({ serverId, enabledTools: [] });
  } else {
    next.mcpServers = current.filter((value) => mcpServerId(value) !== serverId);
  }
  if (selected) next.mcpServers = current;
  else if (current.length === 0) next.mcpServers = [];
  return next;
}

/** Change only the selected server's concrete bare-tool allowlist. */
export function setMcpEnabledTools(
  config: Record<string, unknown>,
  serverId: string,
  enabledTools: string[],
): Record<string, unknown> {
  if (config.mcpServers != null && !Array.isArray(config.mcpServers)) return cloneAgentConfig(config);
  const next = cloneAgentConfig(config);
  const entries = Array.isArray(next.mcpServers) ? next.mcpServers : [];
  next.mcpServers = entries.map((value) => {
    if (mcpServerId(value) !== serverId) return value;
    const entry = plainObject(value) ?? { serverId };
    return { ...entry, enabledTools: [...new Set(enabledTools.map(String).map((x) => x.trim()).filter(Boolean))] };
  });
  return next;
}

export function mcpEnabledToolsOf(config: Record<string, unknown>, serverId: string): string[] {
  return mcpEntryOf(config, serverId)?.enabledTools ?? [];
}

/** Models and tools are catalog projections; these helpers only read fields. */
export function capabilityId(item: { model_id?: string; id?: string; name?: string | null }): string {
  return String(item.model_id || item.id || item.name || '').trim();
}

export function capabilityName(item: { name?: string | null; model_id?: string; id?: string }): string {
  return String(item.name || item.model_id || item.id || 'Unknown').trim();
}

export function mcpToolNames(item: { tools?: unknown[]; tool_names?: string[] }): string[] {
  const raw = Array.isArray(item.tools) ? item.tools : item.tool_names;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.flatMap((tool) => {
    if (typeof tool === 'string') return [tool.trim()];
    const record = plainObject(tool);
    return [String(record?.name ?? record?.tool_name ?? record?.id ?? '').trim()];
  }).filter(Boolean))];
}

export function normalizedConfigChanged(
  config: Record<string, unknown>,
  normalized: Record<string, unknown> | undefined,
): boolean {
  if (!normalized) return false;
  return !jsonSemanticallyEqual(config, normalized);
}

/** Object key order is formatting; array order is configuration semantics. */
export function jsonSemanticallyEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a == null || b == null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => jsonSemanticallyEqual(value, b[index]));
  }
  if (typeof a === 'object') {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && jsonSemanticallyEqual(left[key], right[key]));
  }
  return false;
}

export function configNeedsCapability(
  config: Record<string, unknown>,
  capability: 'models' | 'tools' | 'mcp',
): boolean {
  if (capability === 'models') {
    const policy = policyOf(config);
    return typeof policy.modelId === 'string' && Boolean(policy.modelId.trim());
  }
  if (capability === 'tools') return Object.keys(toolDecisionsOf(config)).length > 0;
  return mcpEntriesOf(config).length > 0;
}

export function warningMessage(warning: ConfigFieldError): string {
  return `${warning.path || '<root>'}: ${warning.message}`;
}

/**
 * 草稿与当前活跃版本是否真的不同。
 *
 * 比较**解析后**再重新序列化的结果，而不是编辑框里的原文：只改了缩进或空白
 * 不该被当成"改了配置"，否则每次打开页面都会诱导用户建一个内容完全相同的新
 * 版本。对象键顺序属于格式，数组顺序仍保留为语义差异。
 */
export function isConfigDraftChanged(
  draft: string,
  active: Record<string, unknown> | undefined,
): boolean {
  const parsed = parseAgentConfigDraft(draft);
  if (!parsed.ok) return true;
  return !jsonSemanticallyEqual(parsed.config, active ?? {});
}

/** 版本线里当前活跃的那一条。找不到时返回 null（指针悬空是异常但不该崩页面）。 */
export function activeVersionOf(
  agent: Agent | null | undefined,
  versions: AgentVersion[],
): AgentVersion | null {
  if (!agent?.active_version_id) return null;
  return versions.find((v) => v.agent_version_id === agent.active_version_id) ?? null;
}

/** 列表排序：默认 Agent 置顶，其余按名字。UI 稳定比"最近创建优先"更重要。 */
export function sortAgentsForDisplay(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    if (a.name === 'default' && b.name !== 'default') return -1;
    if (b.name === 'default' && a.name !== 'default') return 1;
    return a.name.localeCompare(b.name);
  });
}
