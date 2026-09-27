import { useMemo, useState } from 'react';
import type { Agent, AgentConfigOptions, ConfigDiagnostic } from '../../shared/api/agents';
import type { McpServerItem, ModelItem, ToolRegistryItem } from '../../shared/api/capabilities';
import {
  capabilityId,
  capabilityName,
  cloneAgentConfig,
  formatAgentConfig,
  groupToolsForPermissions,
  mcpEnabledToolsOf,
  mcpEntriesOf,
  mcpToolNames,
  modelPolicyOf,
  parseAgentConfigDraft,
  setMcpEnabledTools,
  setMcpServerSelected,
  setModelPolicyField,
  setRootConfigField,
  setToolDecision,
  structuredEditorIssues,
  toolDecisionsOf,
  type CatalogState,
  type ToolDecision,
} from './agentHelpers';
import { DelegationFields } from './DelegationFields';
import { McpArgumentFields } from './McpArgumentFields';
import { hostArgumentsFor, setToolArgument, toolArgumentsIssue, toolArgumentsOf } from './mcpArgumentHelpers';
import {
  delegationMaxItems,
  delegationOf,
  delegationStructureIssues,
  localDelegationCandidates,
  remoteDelegationCandidates,
  setDelegationList,
} from './delegationHelpers';
import s from './agents.module.css';

export type { CatalogState };

/** Which part of the configuration the editor shows (one tab at a time). */
export type EditorSection = 'basic' | 'model' | 'tools' | 'mcp' | 'delegation' | 'json';

export type AgentConfigEditorProps = {
  section: EditorSection;
  value: string;
  onChange: (value: string) => void;
  models: CatalogState<ModelItem>;
  tools: CatalogState<ToolRegistryItem>;
  mcpServers: CatalogState<McpServerItem>;
  /** Same-org agents: the delegation candidates. */
  agents: CatalogState<Agent>;
  /** Name of the agent being edited; excluded from its own delegation candidates. */
  selfName: string;
  options: AgentConfigOptions | null;
  errors: ConfigDiagnostic[];
  disabled?: boolean;
};

const DECISIONS: Array<[ToolDecision, string, string]> = [
  ['inherit', '继承', ''],
  ['allow', '允许', s.al],
  ['require_approval', '审批', s.ap],
  ['deny', '禁止', s.de],
];

const PLATFORM_ZH: Record<string, string> = {
  allow: '允许',
  auto: '允许',
  require_approval: '需审批',
  deny: '禁止',
};

function errorFor(errors: ConfigDiagnostic[], path: string): string | null {
  return errors.find((error) => error.path === path)?.message ?? null;
}

function serverIdOf(server: McpServerItem): string {
  return String(server.server_id || server.id || server.name || '').trim();
}

function toolIdOf(tool: ToolRegistryItem): string {
  return String(tool.name || tool.id || '').trim();
}

function asNumber(value: unknown): number | undefined {
  if (value === '' || value == null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function CatalogNotice({ label, catalog }: { label: string; catalog: CatalogState<unknown> }) {
  if (catalog.loading) return <p className={s.hint}>正在读取{label}…</p>;
  if (catalog.available) return null;
  return (
    <p className={s.warnBox} role="status">
      {label}暂不可用{catalog.error ? `（${catalog.error}）` : ''}。草稿里已有的值会保留；依赖它的修改在目录恢复前不能发布。
    </p>
  );
}

function FieldError({ message }: { message: string | null }) {
  return message ? <small className={s.fieldError}>{message}</small> : null;
}

function commitConfig(
  value: string,
  onChange: (next: string) => void,
  update: (config: Record<string, unknown>) => Record<string, unknown>,
): boolean {
  const parsed = parseAgentConfigDraft(value);
  if (!parsed.ok) return false;
  onChange(formatAgentConfig(update(cloneAgentConfig(parsed.config))));
  return true;
}

type SectionProps = {
  config: Record<string, unknown>;
  value: string;
  onChange: (value: string) => void;
  errors: ConfigDiagnostic[];
  disabled?: boolean;
};

function BasicFields({ config, value, onChange, errors, disabled }: SectionProps) {
  return (
    <label className={s.field}>
      <span>角色与任务说明</span>
      <textarea
        rows={10}
        value={typeof config.systemPrompt === 'string' ? config.systemPrompt : ''}
        disabled={disabled}
        placeholder="这个智能体负责什么、怎么做、输出有什么要求…"
        onChange={(event) => commitConfig(value, onChange, (current) => setRootConfigField(current, 'systemPrompt', event.target.value || undefined))}
      />
      <small>企业安全规则由平台追加，不在这段文字里。</small>
      <FieldError message={errorFor(errors, 'systemPrompt')} />
    </label>
  );
}

function ModelFields({ config, value, onChange, errors, disabled, models }: SectionProps & { models: CatalogState<ModelItem> }) {
  const policy = modelPolicyOf(config);
  const configuredModelId = typeof policy.modelId === 'string' ? policy.modelId : '';
  const selectedModel = models.items.find((model) => capabilityId(model) === configuredModelId);
  const configuredThinking = typeof policy.thinkingLevel === 'string' ? policy.thinkingLevel : '';
  const thinkingLevels = selectedModel?.thinking_levels?.map(String).filter(Boolean) ?? [];
  const maxOutput = selectedModel?.max_output_tokens ?? null;
  const hasUnsupportedThinking = Boolean(configuredThinking && !thinkingLevels.includes(configuredThinking));
  const configuredTemperature = policy.temperature;
  const temperatureSupported = selectedModel?.supports_temperature === true;
  const defaultModel = models.items.find((m) => m.default === true);

  const update = (field: string, next: unknown) => {
    commitConfig(value, onChange, (current) => setModelPolicyField(current, field, next));
  };

  return (
    <>
      <div className={s.grid2}>
        <label className={s.field}>
          <span>模型</span>
          <select value={configuredModelId} disabled={disabled || !models.available} onChange={(event) => update('modelId', event.target.value || undefined)}>
            <option value="">继承平台默认{defaultModel ? `（${capabilityName(defaultModel)}）` : ''}</option>
            {configuredModelId && !selectedModel ? <option value={configuredModelId}>{configuredModelId}（当前不可用）</option> : null}
            {models.items.map((model) => {
              const id = capabilityId(model);
              return id ? <option key={id} value={id}>{capabilityName(model)}</option> : null;
            })}
          </select>
          <small>{selectedModel ? `${selectedModel.provider || '平台'} · 上下文 ${selectedModel.context_window || '—'}` : '不选择时使用平台默认模型。'}</small>
          <FieldError message={errorFor(errors, 'modelPolicy.modelId')} />
        </label>
        <label className={s.field}>
          <span>思考强度</span>
          <select value={configuredThinking} disabled={disabled || !selectedModel || !thinkingLevels.length} onChange={(event) => update('thinkingLevel', event.target.value || undefined)}>
            <option value="">由模型决定</option>
            {hasUnsupportedThinking ? <option value={configuredThinking}>{configuredThinking}（不支持）</option> : null}
            {thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
          <small>
            {hasUnsupportedThinking
              ? '保存的值当前模型不支持：保留供核对，发布前需要改掉。'
              : selectedModel ? '只列出该模型支持的档位。' : '先选择模型才能设置。'}
          </small>
          <FieldError message={errorFor(errors, 'modelPolicy.thinkingLevel')} />
        </label>
        <label className={s.field}>
          <span>最大输出 tokens</span>
          <input
            type="number"
            min={1}
            max={maxOutput ?? undefined}
            value={policy.maxOutputTokens == null ? '' : String(policy.maxOutputTokens)}
            disabled={disabled}
            placeholder="继承平台设置"
            onChange={(event) => update('maxOutputTokens', asNumber(event.target.value))}
          />
          <small>{maxOutput ? `模型上限 ${maxOutput}` : '留空则继承。'}</small>
          <FieldError message={errorFor(errors, 'modelPolicy.maxOutputTokens')} />
        </label>
        <label className={s.field}>
          <span>温度</span>
          <input
            type="number"
            min={selectedModel?.temperature_min ?? 0}
            max={selectedModel?.temperature_max ?? 2}
            step="0.1"
            value={configuredTemperature == null ? '' : String(configuredTemperature)}
            disabled={disabled || !temperatureSupported}
            placeholder={temperatureSupported ? '' : '当前模型不支持'}
            onChange={(event) => update('temperature', asNumber(event.target.value))}
          />
          <small>
            {temperatureSupported
              ? `可用范围 ${selectedModel?.temperature_min ?? 0}–${selectedModel?.temperature_max ?? 2}`
              : configuredTemperature != null ? 'JSON 里有这个值，但该模型不声明支持温度。' : '所选模型支持时才可设置。'}
          </small>
          <FieldError message={errorFor(errors, 'modelPolicy.temperature')} />
        </label>
      </div>
      <CatalogNotice label="模型目录" catalog={models} />
    </>
  );
}

function ToolPolicyFields({ config, value, onChange, errors, disabled, tools }: SectionProps & { tools: CatalogState<ToolRegistryItem> }) {
  const [query, setQuery] = useState('');
  const [onlyOverrides, setOnlyOverrides] = useState(false);
  const decisions = useMemo(() => toolDecisionsOf(config), [config]);
  const overrideCount = Object.keys(decisions).length;
  const q = query.trim().toLowerCase();
  const visible = tools.items.filter((tool) => {
    const name = toolIdOf(tool);
    return name && (!q || name.toLowerCase().includes(q)) && (!onlyOverrides || decisions[name]);
  });
  const unknownTools = Object.keys(decisions).filter((name) => !tools.items.some((tool) => toolIdOf(tool) === name));

  return (
    <>
      <div className={s.toolbar}>
        <input className={s.search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索工具，例如 bash、mcp__" aria-label="搜索工具" />
        <label className={s.check}>
          <input type="checkbox" checked={onlyOverrides} onChange={(e) => setOnlyOverrides(e.target.checked)} />
          只看已覆盖的 {overrideCount} 项
        </label>
      </div>
      <p className={s.hint}>「继承」跟随平台默认（写在工具名下方）。版本可以收紧平台规则，但不能放开平台已禁用的工具。</p>
      <CatalogNotice label="工具目录" catalog={tools} />
      {tools.available ? (
        <div className={s.perms}>
          {groupToolsForPermissions(visible).map(({ group, tools: rows }) => (
            <div key={group} className={s.permGroup}>
              <h4>{group}</h4>
              {rows.map((tool) => {
                const name = toolIdOf(tool);
                const platformDisabled = tool.enabled === false || String(tool.status || '').toLowerCase() === 'disabled';
                const current = decisions[name] || 'inherit';
                return (
                  <div key={name} className={`${s.perm}${current !== 'inherit' ? ` ${s.permOverridden}` : ''}`}>
                    <span className={s.permName}>
                      <code>{name}</code>
                      <small>
                        平台默认：{platformDisabled ? '已禁用' : PLATFORM_ZH[String(tool.approval_policy || '')] || tool.approval_policy || '平台决定'}
                      </small>
                      <FieldError message={errorFor(errors, `toolPolicy.tools.${name}`)} />
                    </span>
                    <div className={s.seg} role="radiogroup" aria-label={`${name} 的权限`}>
                      {DECISIONS.map(([decision, label, cls]) => (
                        <button
                          key={decision}
                          type="button"
                          role="radio"
                          aria-checked={current === decision}
                          className={current === decision ? cls : undefined}
                          disabled={disabled || platformDisabled}
                          onClick={() => commitConfig(value, onChange, (c) => setToolDecision(c, name, decision))}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          {unknownTools.map((name) => (
            <div key={name} className={`${s.perm} ${s.permStale}`}>
              <span className={s.permName}><code>{name}</code><small>这个版本里有设置，但当前平台目录已没有该工具，设置不生效。</small></span>
              <span className={s.tag}>已保留 · 不生效</span>
            </div>
          ))}
          {!visible.length && !unknownTools.length ? <p className={s.hint}>没有匹配的工具。</p> : null}
        </div>
      ) : null}
    </>
  );
}

function McpFields({ config, value, onChange, errors, disabled, mcpServers, platformConstraints }: SectionProps & { mcpServers: CatalogState<McpServerItem>; platformConstraints?: Record<string, unknown> }) {
  const entries = mcpEntriesOf(config);
  const knownIds = new Set(mcpServers.items.map(serverIdOf));
  const stale = entries.filter((entry) => !knownIds.has(entry.serverId));
  return (
    <>
      <p className={s.hint}>选中服务本身不授予任何工具：需要逐个勾选要开放的工具；空列表表示明确不开放任何工具。</p>
      <CatalogNotice label="MCP 目录" catalog={mcpServers} />
      {mcpServers.available ? (
        <div className={s.mcpList}>
          {mcpServers.items.map((server) => {
            const id = serverIdOf(server);
            if (!id) return null;
            const selected = entries.some((entry) => entry.serverId === id);
            const tools = mcpToolNames(server);
            const status = String(server.status || server.connection_status || 'unknown').toLowerCase();
            const platformDisabled = server.enabled === false || status === 'disabled';
            const selectedTools = mcpEnabledToolsOf(config, id);
            // A draft may enable a tool the live directory no longer lists; keep
            // its row so the server's MCP_TOOL_UNAVAILABLE error has a home.
            const rows = [...tools, ...selectedTools.filter((tool) => !tools.includes(tool))];
            const entry = entries.find((item) => item.serverId === id);
            return (
              <fieldset key={id} className={s.mcpCard}>
                <label className={s.mcpHead}>
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={disabled || platformDisabled}
                    onChange={(event) => commitConfig(value, onChange, (current) => setMcpServerSelected(current, id, event.target.checked))}
                  />
                  <b>{server.name || id}</b>
                  <span className={s.hint}>{id} · {status}</span>
                  <span className={s.sp} />
                  <span className={s.tag}>{platformDisabled ? '平台已禁用' : selected ? `已开放 ${selectedTools.length} 个工具` : '未选中'}</span>
                </label>
                {selected ? (
                  <div className={s.mcpTools}>
                    {rows.length ? rows.map((tool) => {
                      const toolIndex = entry?.enabledTools.indexOf(tool) ?? -1;
                      return (
                        <label key={tool} className={s.mcpTool}>
                          <input
                            type="checkbox"
                            checked={selectedTools.includes(tool)}
                            disabled={disabled}
                            onChange={(event) => {
                              const next = event.target.checked ? [...selectedTools, tool] : selectedTools.filter((n) => n !== tool);
                              commitConfig(value, onChange, (current) => setMcpEnabledTools(current, id, next));
                            }}
                          />
                          <code>{tool}</code>
                          {tools.includes(tool) ? null : <small className={s.hint}>当前目录中已没有</small>}
                          <FieldError message={toolIndex >= 0 ? errorFor(errors, `mcpServers[${entry?.index ?? 0}].enabledTools[${toolIndex}]`) : null} />
                        </label>
                      );
                    }) : <p className={s.hint}>拿不到实时工具列表：已开放的工具保留在 JSON 里，但无法开放新工具。</p>}
                  </div>
                ) : null}
                {selected ? (
                  <McpArgumentFields
                    serverId={id}
                    entryIndex={entry?.index ?? 0}
                    declared={hostArgumentsFor(platformConstraints, id)}
                    current={toolArgumentsOf(config, id)}
                    issue={toolArgumentsIssue(config, id)}
                    errors={errors}
                    disabled={disabled}
                    onChange={(name, next) => commitConfig(value, onChange, (current) => setToolArgument(current, id, name, next))}
                  />
                ) : null}
                <FieldError message={errorFor(errors, `mcpServers[${entry?.index ?? 0}]`)} />
              </fieldset>
            );
          })}
          {stale.map((entry) => (
            <div key={`${entry.serverId}-${entry.index}`} className={`${s.mcpCard} ${s.permStale}`}>
              <b>{entry.serverId}</b> <span className={s.tag}>已保留 · 目录中不可见</span>
              <p className={s.hint}>在服务重新可见之前，这个引用不会被授予新工具。</p>
            </div>
          ))}
          {!mcpServers.items.length && !stale.length ? <p className={s.hint}>这个组织没有可用的 MCP 服务。</p> : null}
        </div>
      ) : null}
      <FieldError message={errorFor(errors, 'mcpServers')} />
    </>
  );
}

/**
 * Structured editor for one section of an agent version's configuration.
 * Every section writes into the same JSON draft; a section only touches the
 * fields it owns, so unknown and legacy fields survive in the JSON tab.
 */
export function AgentConfigEditor({ section, value, onChange, models, tools, mcpServers, agents, selfName, options, errors, disabled = false }: AgentConfigEditorProps) {
  const parsed = parseAgentConfigDraft(value);
  const config = parsed.ok ? parsed.config : null;
  const issues = config ? [...structuredEditorIssues(config), ...delegationStructureIssues(config)] : [];
  const paused = (prefix: string) => disabled || issues.some((issue) => issue.startsWith(prefix));

  if (section === 'json') {
    return (
      <div className={s.section}>
        <label className={s.field}>
          <span>配置 JSON（与其他分类共用同一份草稿）</span>
          <textarea
            className={s.code}
            rows={20}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            aria-label="智能体配置 JSON"
          />
          <small>未知字段和旧字段会保留在草稿里并由服务端校验报告；切换分类不会丢弃它们。</small>
        </label>
        <p className={s.hint}>
          平台管理的 skills、extensions、sandboxPolicy、a2a 只能继承，不提供保存后不生效的开关。
          Schema v{options?.schemaVersion ?? '—'} · 能力版本 {options?.capabilityRevision || '未知'}
        </p>
      </div>
    );
  }

  if (!config) {
    return <p className={s.warnBox} role="status">JSON 语法有误，请先在「JSON」里修正；原文会保留。</p>;
  }

  return (
    <div className={s.section}>
      {issues.length ? (
        <div className={s.warnBox} role="alert">
          <b>JSON 结构有问题，相关分类暂停编辑：</b>
          <ul>{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
        </div>
      ) : null}
      {section === 'basic' ? <BasicFields config={config} value={value} onChange={onChange} errors={errors} disabled={disabled} /> : null}
      {section === 'model' ? <ModelFields config={config} value={value} onChange={onChange} errors={errors} disabled={paused('modelPolicy')} models={models} /> : null}
      {section === 'tools' ? <ToolPolicyFields config={config} value={value} onChange={onChange} errors={errors} disabled={paused('toolPolicy')} tools={tools} /> : null}
      {section === 'mcp' ? <McpFields config={config} value={value} onChange={onChange} errors={errors} disabled={paused('mcpServers')} mcpServers={mcpServers} platformConstraints={options?.platformConstraints} /> : null}
      {section === 'delegation' ? (
        <DelegationFields
          {...delegationOf(config)}
          localCandidates={{ ...agents, items: localDelegationCandidates(agents.items, selfName) }}
          remoteCandidates={{
            items: remoteDelegationCandidates(options?.platformConstraints),
            available: options != null,
            error: options ? null : '配置能力读取失败',
          }}
          maxAgents={delegationMaxItems(options?.fieldSupport, 'agents')}
          maxRemoteAgents={delegationMaxItems(options?.fieldSupport, 'remoteAgents')}
          selfName={selfName}
          errors={errors}
          disabled={paused('delegation')}
          onChange={(field, next) => commitConfig(value, onChange, (current) => setDelegationList(current, field, next))}
        />
      ) : null}
    </div>
  );
}
