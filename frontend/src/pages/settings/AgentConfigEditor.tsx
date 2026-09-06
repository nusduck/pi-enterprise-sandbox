import { useMemo, useState } from 'react';
import type {
  AgentConfigOptions,
  ConfigDiagnostic,
} from '../../shared/api/agents';
import type {
  McpServerItem,
  ModelItem,
  ToolRegistryItem,
} from '../../shared/api/capabilities';
import {
  capabilityId,
  capabilityName,
  cloneAgentConfig,
  configNeedsCapability,
  formatAgentConfig,
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
  type ToolDecision,
} from './agentHelpers';

export type CatalogState<T> = {
  items: T[];
  available: boolean;
  loading?: boolean;
  error?: string | null;
};

export type AgentConfigEditorProps = {
  value: string;
  onChange: (value: string) => void;
  models: CatalogState<ModelItem>;
  tools: CatalogState<ToolRegistryItem>;
  mcpServers: CatalogState<McpServerItem>;
  options: AgentConfigOptions | null;
  errors: ConfigDiagnostic[];
  disabled?: boolean;
};

const DECISIONS: Array<{ value: ToolDecision; label: string }> = [
  { value: 'inherit', label: 'Inherit platform' },
  { value: 'allow', label: 'Allow' },
  { value: 'require_approval', label: 'Require approval' },
  { value: 'deny', label: 'Deny' },
];

function errorFor(errors: ConfigDiagnostic[], path: string): string | null {
  return errors.find((error) => error.path === path)?.message ?? null;
}

function serverIdOf(server: McpServerItem): string {
  return String(server.server_id || server.id || server.name || '').trim();
}

function serverStatus(server: McpServerItem): string {
  return String(server.status || server.connection_status || 'unknown').toLowerCase();
}

function toolIdOf(tool: ToolRegistryItem): string {
  return String(tool.name || tool.id || '').trim();
}

function asNumber(value: unknown): number | undefined {
  if (value === '' || value == null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function CatalogNotice({
  label,
  catalog,
}: {
  label: string;
  catalog: CatalogState<unknown>;
}) {
  if (catalog.loading) return <p className="mgmt-hint">Loading {label}…</p>;
  if (catalog.available) return null;
  return (
    <p className="agent-catalog-warning" role="status">
      {label} are unavailable{catalog.error ? ` (${catalog.error})` : ''}. Existing
      draft values are preserved; saving changes that depend on this directory is
      blocked until it is reachable.
    </p>
  );
}

function FieldError({ message }: { message: string | null }) {
  return message ? <small className="agent-field-error">{message}</small> : null;
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

function ModelFields({
  config,
  value,
  onChange,
  models,
  errors,
  disabled,
}: {
  config: Record<string, unknown>;
  value: string;
  onChange: (value: string) => void;
  models: CatalogState<ModelItem>;
  errors: ConfigDiagnostic[];
  disabled?: boolean;
}) {
  const policy = modelPolicyOf(config);
  const configuredModelId = typeof policy.modelId === 'string' ? policy.modelId : '';
  const selectedModel = models.items.find((model) => capabilityId(model) === configuredModelId);
  const configuredThinking = typeof policy.thinkingLevel === 'string' ? policy.thinkingLevel : '';
  const thinkingLevels = selectedModel?.thinking_levels?.map(String).filter(Boolean) ?? [];
  const maxOutput = selectedModel?.max_output_tokens ?? null;
  const hasUnsupportedThinking = Boolean(configuredThinking && !thinkingLevels.includes(configuredThinking));
  const configuredTemperature = policy.temperature;
  const temperatureSupported = selectedModel?.supports_temperature === true;

  const update = (field: string, next: unknown) => {
    commitConfig(value, onChange, (current) => setModelPolicyField(current, field, next));
  };

  return (
    <div className="agent-config-block">
      <div className="agent-config-block-head">
        <h4>Model policy</h4>
        <span className="mgmt-tag">Platform constrained</span>
      </div>
      <div className="mgmt-field-row">
        <label className="mgmt-field">
          <span>Model</span>
          <select
            value={configuredModelId}
            disabled={disabled || !models.available}
            onChange={(event) => update('modelId', event.target.value || undefined)}
          >
            <option value="">Inherit platform default</option>
            {configuredModelId && !selectedModel ? (
              <option value={configuredModelId}>{configuredModelId} (unavailable)</option>
            ) : null}
            {models.items.map((model) => {
              const id = capabilityId(model);
              return id ? <option key={id} value={id}>{capabilityName(model)}</option> : null;
            })}
          </select>
          <small>
            {selectedModel
              ? `${selectedModel.provider || 'platform'} · ${selectedModel.context_window || '—'} context`
              : 'Leave unset to use the platform default.'}
          </small>
          <FieldError message={errorFor(errors, 'modelPolicy.modelId')} />
        </label>

        <label className="mgmt-field">
          <span>Max output tokens</span>
          <input
            type="number"
            min={1}
            max={maxOutput ?? undefined}
            value={policy.maxOutputTokens == null ? '' : String(policy.maxOutputTokens)}
            disabled={disabled}
            onChange={(event) => update('maxOutputTokens', asNumber(event.target.value))}
          />
          <small>{maxOutput ? `Model/platform ceiling: ${maxOutput}` : 'Inherited when blank.'}</small>
          <FieldError message={errorFor(errors, 'modelPolicy.maxOutputTokens')} />
        </label>

        <label className="mgmt-field">
          <span>Thinking level</span>
          <select
            value={configuredThinking}
            disabled={disabled || !selectedModel || !thinkingLevels.length}
            onChange={(event) => update('thinkingLevel', event.target.value || undefined)}
          >
            <option value="">Unset (model decides)</option>
            {hasUnsupportedThinking ? (
              <option value={configuredThinking}>{configuredThinking} (unsupported)</option>
            ) : null}
            {thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
          <small>
            {hasUnsupportedThinking
              ? 'The saved value is preserved for review and must be fixed before publishing.'
              : selectedModel
                ? 'Only levels advertised by this model are selectable.'
                : 'Choose a model to see its supported levels.'}
          </small>
          <FieldError message={errorFor(errors, 'modelPolicy.thinkingLevel')} />
        </label>

        <label className="mgmt-field">
          <span>Temperature</span>
          <input
            type="number"
            min={selectedModel?.temperature_min ?? 0}
            max={selectedModel?.temperature_max ?? 2}
            step="0.1"
            value={configuredTemperature == null ? '' : String(configuredTemperature)}
            disabled={disabled || !temperatureSupported}
            onChange={(event) => update('temperature', asNumber(event.target.value))}
          />
          <small>
            {temperatureSupported
              ? `Supported range ${selectedModel?.temperature_min ?? 0}–${selectedModel?.temperature_max ?? 2}.`
              : configuredTemperature != null
                ? 'Stored in JSON but this model does not advertise temperature support.'
                : 'Disabled until the selected model and runtime support it.'}
          </small>
          <FieldError message={errorFor(errors, 'modelPolicy.temperature')} />
        </label>
      </div>
      <CatalogNotice label="Model directory" catalog={models} />
    </div>
  );
}

function ToolPolicyFields({
  config,
  value,
  onChange,
  tools,
  errors,
  disabled,
}: {
  config: Record<string, unknown>;
  value: string;
  onChange: (value: string) => void;
  tools: CatalogState<ToolRegistryItem>;
  errors: ConfigDiagnostic[];
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const decisions = useMemo(() => toolDecisionsOf(config), [config]);
  const visibleTools = tools.items.filter((tool) => {
    const name = toolIdOf(tool);
    return !query.trim() || name.toLowerCase().includes(query.trim().toLowerCase());
  });
  const unknownTools = Object.keys(decisions).filter(
    (name) => !tools.items.some((tool) => toolIdOf(tool) === name),
  );

  return (
    <div className="agent-config-block">
      <div className="agent-config-block-head">
        <h4>Tool permissions</h4>
        <span className="mgmt-tag">Allowlist and guard</span>
      </div>
      <p className="mgmt-hint">
        Inherit follows the platform decision. A version can tighten a platform rule,
        but cannot enable a disabled tool.
      </p>
      <label className="mgmt-field agent-search-field">
        <span>Search tools</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="bash, mcp__…" />
      </label>
      <CatalogNotice label="Tool directory" catalog={tools} />
      {tools.available ? (
        <div className="agent-permission-list">
          {visibleTools.map((tool) => {
            const name = toolIdOf(tool);
            if (!name) return null;
            const platformDisabled = tool.enabled === false || String(tool.status || '').toLowerCase() === 'disabled';
            const platformLabel = platformDisabled ? 'Platform disabled' : String(tool.approval_policy || 'platform default');
            return (
              <label className="agent-permission-row" key={name}>
                <span>
                  <strong>{name}</strong>
                  <small>{platformLabel}{tool.description ? ` · ${tool.description}` : ''}</small>
                </span>
                <select
                  aria-label={`Permission for ${name}`}
                  value={decisions[name] || 'inherit'}
                  disabled={disabled || platformDisabled}
                  onChange={(event) => {
                    const decision = event.target.value as ToolDecision;
                    commitConfig(value, onChange, (current) => setToolDecision(current, name, decision));
                  }}
                >
                  {DECISIONS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
                </select>
                <FieldError message={errorFor(errors, `toolPolicy.tools.${name}`)} />
              </label>
            );
          })}
          {unknownTools.map((name) => (
            <div className="agent-permission-row agent-permission-row-unknown" key={name}>
              <span><strong>{name}</strong><small>Stored in this version but absent from the current platform directory.</small></span>
              <span className="mgmt-tag">Preserved · not effective</span>
            </div>
          ))}
          {!visibleTools.length && !unknownTools.length ? <p className="mgmt-hint">No matching tools.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function McpFields({
  config,
  value,
  onChange,
  mcpServers,
  errors,
  disabled,
}: {
  config: Record<string, unknown>;
  value: string;
  onChange: (value: string) => void;
  mcpServers: CatalogState<McpServerItem>;
  errors: ConfigDiagnostic[];
  disabled?: boolean;
}) {
  const entries = mcpEntriesOf(config);
  const knownIds = new Set(mcpServers.items.map(serverIdOf));
  const stale = entries.filter((entry) => !knownIds.has(entry.serverId));
  return (
    <div className="agent-config-block">
      <div className="agent-config-block-head">
        <h4>External MCP services</h4>
        <span className="mgmt-tag">Explicit server + tools</span>
      </div>
      <p className="mgmt-hint">
        Selecting a server grants no tools by itself. Select each concrete tool; an
        empty list remains an explicit zero-tool allowlist.
      </p>
      <CatalogNotice label="MCP directory" catalog={mcpServers} />
      {mcpServers.available ? (
        <div className="agent-mcp-list">
          {mcpServers.items.map((server) => {
            const id = serverIdOf(server);
            if (!id) return null;
            const selected = entries.some((entry) => entry.serverId === id);
            const tools = mcpToolNames(server);
            const status = serverStatus(server);
            const platformDisabled = server.enabled === false || status === 'disabled';
            const selectedTools = mcpEnabledToolsOf(config, id);
            // A draft may enable a tool the live directory no longer lists.
            // Rendering only the directory would hide the server's
            // MCP_TOOL_UNAVAILABLE error on exactly the row that caused it.
            const rows = [...tools, ...selectedTools.filter((tool) => !tools.includes(tool))];
            return (
              <fieldset className="agent-mcp-card" key={id}>
                <label className="agent-mcp-server-row">
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={disabled || platformDisabled}
                    onChange={(event) => commitConfig(value, onChange, (current) => setMcpServerSelected(current, id, event.target.checked))}
                  />
                  <span><strong>{server.name || id}</strong><small>{id} · {status}</small></span>
                  <span className="mgmt-tag">{platformDisabled ? 'Platform disabled' : selected ? `${selectedTools.length} selected` : 'Not selected'}</span>
                </label>
                {selected ? (
                  <div className="agent-mcp-tools">
                    {rows.length ? rows.map((tool) => {
                      const entry = entries.find((item) => item.serverId === id);
                      const path = `mcpServers[${entry?.index ?? 0}].enabledTools`;
                      const toolIndex = entry?.enabledTools.indexOf(tool) ?? -1;
                      return (
                        <label key={tool} className="agent-mcp-tool-row">
                          <input
                            type="checkbox"
                            checked={selectedTools.includes(tool)}
                            disabled={disabled}
                            onChange={(event) => {
                              const next = event.target.checked
                                ? [...selectedTools, tool]
                                : selectedTools.filter((name) => name !== tool);
                              commitConfig(value, onChange, (current) => setMcpEnabledTools(current, id, next));
                            }}
                          />
                          <span>
                            {tool}
                            {tools.includes(tool) ? null : <small> · not in the current directory</small>}
                          </span>
                          <FieldError message={toolIndex >= 0 ? errorFor(errors, `${path}[${toolIndex}]`) : null} />
                        </label>
                      );
                    }) : (
                      <p className="mgmt-hint">
                        No live tool list is available. Existing enabled tools are preserved
                        in JSON, but their current availability is unknown and no new tool can be granted.
                      </p>
                    )}
                  </div>
                ) : null}
                <FieldError message={errorFor(errors, `mcpServers[${entries.find((entry) => entry.serverId === id)?.index ?? 0}]`)} />
              </fieldset>
            );
          })}
          {stale.map((entry) => (
            <div className="agent-mcp-card agent-mcp-card-stale" key={`${entry.serverId}-${entry.index}`}>
              <strong>{entry.serverId}</strong>
              <span className="mgmt-tag">Preserved · directory unavailable</span>
              <small>This reference is not granted any new tools until the server is visible again.</small>
            </div>
          ))}
          {!mcpServers.items.length && !stale.length ? <p className="mgmt-hint">No MCP servers are available to this organization.</p> : null}
        </div>
      ) : null}
      <FieldError message={errorFor(errors, 'mcpServers')} />
    </div>
  );
}

function ManagedFields({ options }: { options: AgentConfigOptions | null }) {
  const managed = ['skills', 'extensions', 'sandboxPolicy', 'a2a'];
  return (
    <div className="agent-config-block agent-managed-block">
      <div className="agent-config-block-head">
        <h4>Inherited and platform-managed settings</h4>
        <span className="mgmt-tag">No version toggles</span>
      </div>
      <p className="mgmt-hint">
        These settings are resolved from the platform and the current user. This page
        does not offer controls that would save successfully without changing runtime behavior.
      </p>
      <ul className="agent-managed-list">
        {managed.map((field) => (
          <li key={field}><strong>{field}</strong><span>Inherited / platform managed</span></li>
        ))}
      </ul>
      <small className="mgmt-hint">
        Manage user skill enablement in Capabilities. Schema v{options?.schemaVersion ?? '—'};
        runtime capability revision {options?.capabilityRevision || 'unknown'}.
      </small>
    </div>
  );
}

export function AgentConfigEditor({
  value,
  onChange,
  models,
  tools,
  mcpServers,
  options,
  errors,
  disabled = false,
}: AgentConfigEditorProps) {
  const parsed = parseAgentConfigDraft(value);
  const config = parsed.ok ? parsed.config : null;
  const structuredIssues = config ? structuredEditorIssues(config) : [];
  const hasModel = config ? configNeedsCapability(config, 'models') : false;
  const hasTools = config ? configNeedsCapability(config, 'tools') : false;
  const hasMcp = config ? configNeedsCapability(config, 'mcp') : false;

  return (
    <div className="agent-config-editor">
      {!config ? (
        <p className="agent-editor-locked" role="status">
          Fix the JSON syntax below to enable structured fields. The original text is preserved.
        </p>
      ) : (
        <>
          {structuredIssues.length ? (
            <div className="agent-editor-locked" role="alert">
              <strong>Structured fields are paused until the JSON shape is fixed.</strong>
              <ul>{structuredIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
              <span>The advanced editor keeps the original values so no legacy field is lost.</span>
            </div>
          ) : null}
          <label className="mgmt-field">
            <span>Persona and task instructions</span>
            <textarea
              rows={6}
              value={typeof config.systemPrompt === 'string' ? config.systemPrompt : ''}
              disabled={disabled}
              placeholder="Instructions for this Agent's persona and task…"
              onChange={(event) => commitConfig(value, onChange, (current) => setRootConfigField(current, 'systemPrompt', event.target.value || undefined))}
            />
            <small>Enterprise safety rules are added by the platform and remain outside this text.</small>
            <FieldError message={errorFor(errors, 'systemPrompt')} />
          </label>
          <ModelFields config={config} value={value} onChange={onChange} models={models} errors={errors} disabled={disabled || structuredIssues.some((issue) => issue.startsWith('modelPolicy'))} />
          <ToolPolicyFields config={config} value={value} onChange={onChange} tools={tools} errors={errors} disabled={disabled || structuredIssues.some((issue) => issue.startsWith('toolPolicy'))} />
          <McpFields config={config} value={value} onChange={onChange} mcpServers={mcpServers} errors={errors} disabled={disabled || structuredIssues.some((issue) => issue.startsWith('mcpServers'))} />
          <ManagedFields options={options} />
          {(hasModel && !models.available) || (hasTools && !tools.available) || (hasMcp && !mcpServers.available) ? (
            <p className="agent-editor-locked" role="status">
              A required capability directory is unavailable. Publishing is disabled until
              the server confirms the referenced capabilities.
            </p>
          ) : null}
        </>
      )}
      <label className="mgmt-field">
        <span>Advanced JSON (shared with the fields above)</span>
        <textarea
          className="mgmt-code-input"
          rows={16}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          aria-label="Advanced Agent configuration JSON"
        />
        <small>Unknown or legacy fields stay in this draft and are reported by server validation; switching views never drops them.</small>
      </label>
    </div>
  );
}
