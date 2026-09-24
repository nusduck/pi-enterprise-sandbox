/**
 * Agents 管理页（admin）：org 内并列的智能体、它们的配置与版本线。
 *
 * UI 上刻意反复说明的一件事：**保存 = 建新版本**。`agent_versions` 不可变，
 * 编辑配置产生 `version_no + 1` 的新行，旧行保留；切换活跃版本只影响**新建的
 * 会话**，正在跑的 Run 与已存在的会话继续用它们钉住的版本
 * （`docs/design/multi-agent-selection.md` D4）。把它写成"保存"而不解释，用户
 * 会以为是原地修改，然后困惑于"为什么改了配置老会话没变"。
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  createAgent,
  createAgentVersion,
  getAgentConfigOptions,
  listAgentVersions,
  listAgents,
  validateAgentConfig,
  setAgentActiveVersion,
  type Agent,
  type AgentConfigOptions,
  type AgentConfigValidation,
  type AgentVersion,
  type ConfigDiagnostic,
} from '../../shared/api';
import {
  listMcpServers,
  listModels,
  listTools,
  type McpServerItem,
  type ModelItem,
  type SoftListResult,
  type ToolRegistryItem,
} from '../../shared/api/capabilities';
import {
  activeVersionOf,
  configNeedsCapability,
  formatAgentConfig,
  isConfigDraftChanged,
  parseAgentConfigDraft,
  sortAgentsForDisplay,
  type AgentConfigValidationState,
} from './agentHelpers';
import { AgentConfigEditor, type CatalogState } from './AgentConfigEditor';
import { AgentValidationPanel } from './AgentValidationPanel';
import { IconRefresh, IconSparkles } from '../../shared/ui/Icons';

const EMPTY_VALIDATION: AgentConfigValidationState = {
  status: 'idle',
  errors: [],
  warnings: [],
};

function loadingCatalog<T>(): CatalogState<T> {
  return { items: [], available: false, loading: true, error: null };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}

function conflictError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'status' in error && (error as { status?: number }).status === 409);
}

function validationState(result: AgentConfigValidation): AgentConfigValidationState {
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  return {
    status: result.valid && errors.length === 0 ? 'valid' : 'invalid',
    errors,
    warnings,
    normalizedConfig: result.normalizedConfig,
    effectiveSummary: result.effectiveSummary,
    capabilityRevision: result.capabilityRevision,
  };
}

export function catalogFromResult<T>(result: SoftListResult<T>, previous: CatalogState<T>): CatalogState<T> {
  // `softGet` marks a non-404 endpoint as available so older capability pages
  // can distinguish "not implemented" from "temporarily failed". For an
  // editor, an HTTP failure is still unusable: never turn it into an empty
  // directory that could make a referenced capability look safe to publish.
  const usable = result.available && !result.error;
  if (usable) {
    return { items: result.items, available: true, loading: false, error: result.error || null };
  }
  // A failed refresh must never replace a previously known directory with an
  // empty list. Empty is a valid response only when the endpoint was reachable.
  return { ...previous, loading: false, available: false, error: result.error || null };
}

export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [configDraft, setConfigDraft] = useState('');
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newConfig, setNewConfig] = useState(() => formatAgentConfig({ schemaVersion: 1 }));
  const [newValidation, setNewValidation] = useState<AgentConfigValidationState>(EMPTY_VALIDATION);
  const [validation, setValidation] = useState<AgentConfigValidationState>(EMPTY_VALIDATION);
  const [configOptions, setConfigOptions] = useState<AgentConfigOptions | null>(null);
  const [catalogs, setCatalogs] = useState<{
    models: CatalogState<ModelItem>;
    tools: CatalogState<ToolRegistryItem>;
    mcpServers: CatalogState<McpServerItem>;
  }>({ models: loadingCatalog(), tools: loadingCatalog(), mcpServers: loadingCatalog() });
  const [viewVersionId, setViewVersionId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const versionsRequestRef = useRef(0);
  const refreshRequestRef = useRef(0);
  const catalogsRequestRef = useRef(0);
  const validationRequestRef = useRef(0);
  const validationAbortRef = useRef<AbortController | null>(null);
  const draftByAgentRef = useRef(new Map<string, string>());
  const mutationRef = useRef(0);
  const configDraftRef = useRef(configDraft);
  const newConfigRef = useRef(newConfig);
  const selectedAgentRef = useRef<Agent | null>(null);
  const selectedAgentIdRef = useRef(selectedAgentId);
  const mountedRef = useRef(true);
  configDraftRef.current = configDraft;
  newConfigRef.current = newConfig;
  selectedAgentIdRef.current = selectedAgentId;

  const selectedAgent = agents.find((agent) => agent.agent_id === selectedAgentId) ?? null;
  selectedAgentRef.current = selectedAgent;
  const activeVersion = activeVersionOf(selectedAgent, versions);
  const viewedVersion = versions.find((version) => version.agent_version_id === viewVersionId) ?? null;
  const configChanged = isConfigDraftChanged(configDraft, activeVersion?.config);
  const parsedDraft = parseAgentConfigDraft(configDraft);

  const loadCatalogs = useCallback(async () => {
    const requestId = ++catalogsRequestRef.current;
    const results = await Promise.allSettled([
      getAgentConfigOptions(),
      listModels(),
      listTools(),
      listMcpServers(),
    ]);
    if (requestId !== catalogsRequestRef.current) return;
    const [optionsResult, modelsResult, toolsResult, mcpResult] = results;
    if (optionsResult.status === 'fulfilled') setConfigOptions(optionsResult.value);
    else setConfigOptions(null);
    setCatalogs((previous) => ({
      models: modelsResult.status === 'fulfilled'
        ? catalogFromResult(modelsResult.value, previous.models)
        : { ...previous.models, loading: false, available: false, error: errorMessage(modelsResult.reason) },
      tools: toolsResult.status === 'fulfilled'
        ? catalogFromResult(toolsResult.value, previous.tools)
        : { ...previous.tools, loading: false, available: false, error: errorMessage(toolsResult.reason) },
      mcpServers: mcpResult.status === 'fulfilled'
        ? catalogFromResult(mcpResult.value, previous.mcpServers)
        : { ...previous.mcpServers, loading: false, available: false, error: errorMessage(mcpResult.reason) },
    }));
  }, []);

  const loadVersions = useCallback(async (
    agentId: string,
    preserveDraft = false,
    expectedSelectedAgentId?: string,
  ): Promise<boolean> => {
    const requestId = ++versionsRequestRef.current;
    if (!agentId) {
      setVersions([]);
      if (!preserveDraft) setConfigDraft('');
      return true;
    }
    const detail = await listAgentVersions(agentId);
    if (
      requestId !== versionsRequestRef.current ||
      (expectedSelectedAgentId && selectedAgentIdRef.current !== expectedSelectedAgentId)
    ) return false;
    setVersions(detail.versions);
    setAgents((current) => current.map((agent) =>
      agent.agent_id === agentId ? { ...agent, ...detail.agent } : agent,
    ));
    const active = activeVersionOf(detail.agent, detail.versions);
    if (!preserveDraft) {
      setConfigDraft(formatAgentConfig(active?.config));
      setViewVersionId(active?.agent_version_id ?? null);
      setValidation(EMPTY_VALIDATION);
    }
    return true;
  }, []);

  const refresh = useCallback(async (
    preferAgentId?: string,
    preserveDraft = false,
    expectedSelectedAgentId?: string,
  ) => {
    const requestId = ++refreshRequestRef.current;
    setLoading(true);
    setError('');
    try {
      const [agentList] = await Promise.all([listAgents(), loadCatalogs()]);
      if (requestId !== refreshRequestRef.current) return;
      const list = sortAgentsForDisplay(agentList);
      setAgents(list);
      if (
        expectedSelectedAgentId &&
        selectedAgentIdRef.current !== expectedSelectedAgentId
      ) return;
      const next =
        (preferAgentId && list.some((a) => a.agent_id === preferAgentId)
          ? preferAgentId
          : null) ??
        list[0]?.agent_id ??
        '';
      setSelectedAgentId(next);
      await loadVersions(next, preserveDraft, expectedSelectedAgentId);
    } catch (err) {
      if (requestId === refreshRequestRef.current && mountedRef.current) {
        setError(errorMessage(err) || 'Failed to load agents');
      }
    } finally {
      if (requestId === refreshRequestRef.current && mountedRef.current) setLoading(false);
    }
  }, [loadCatalogs, loadVersions]);

  useEffect(() => {
    // StrictMode runs effect setup → cleanup → setup in development. Reset the
    // liveness flag during setup so the second (real) setup can still publish
    // refresh/validation results; the final cleanup marks the component dead.
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
      validationAbortRef.current?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    const requestId = ++validationRequestRef.current;
    validationAbortRef.current?.abort();
    const parsed = parseAgentConfigDraft(configDraft);
    if (!selectedAgentId) {
      setValidation(EMPTY_VALIDATION);
      return;
    }
    if (!parsed.ok) {
      setValidation({ status: 'invalid', errors: [{ path: '', code: 'JSON_INVALID', message: parsed.error }], warnings: [] });
      return;
    }
    const controller = new AbortController();
    validationAbortRef.current = controller;
    setValidation({ ...EMPTY_VALIDATION, status: 'pending' });
    const timer = window.setTimeout(() => {
      void validateAgentConfig(parsed.config, {
        agentId: selectedAgentId,
        signal: controller.signal,
      }).then((result) => {
        if (requestId !== validationRequestRef.current) return;
        setValidation(validationState(result));
      }).catch((err: unknown) => {
        if (controller.signal.aborted || requestId !== validationRequestRef.current) return;
        setValidation({ status: 'unavailable', errors: [], warnings: [], message: errorMessage(err) });
      });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [configDraft, configOptions?.capabilityRevision, selectedAgentId]);

  async function selectAgent(agentId: string) {
    const previousAgentId = selectedAgentId;
    if (previousAgentId && configChanged) draftByAgentRef.current.set(previousAgentId, configDraft);
    setSelectedAgentId(agentId);
    setError('');
    setNotice('');
    try {
      const savedDraft = draftByAgentRef.current.get(agentId);
      const loaded = await loadVersions(agentId, Boolean(savedDraft));
      // The user may have selected another Agent while this request was in
      // flight. A late response must not move that newer page back to A.
      if (loaded && selectedAgentIdRef.current === agentId && savedDraft) {
        setConfigDraft(savedDraft);
        setValidation(EMPTY_VALIDATION);
      }
    } catch (err) {
      setError(errorMessage(err) || 'Failed to load version history');
    }
  }

  async function validateForWrite(
    config: Record<string, unknown>,
    agentId?: string,
  ): Promise<AgentConfigValidation | null> {
    try {
      const result = await validateAgentConfig(config, {
        agentId: agentId || null,
      });
      return result;
    } catch (err) {
      if (mountedRef.current) setError(`Could not validate this configuration: ${errorMessage(err)}`);
      return null;
    }
  }

  function hasUnavailableDependency(config: Record<string, unknown>): boolean {
    return (
      (configNeedsCapability(config, 'models') && !catalogs.models.available) ||
      (configNeedsCapability(config, 'tools') && !catalogs.tools.available) ||
      (configNeedsCapability(config, 'mcp') && !catalogs.mcpServers.available)
    );
  }

  async function submitNewAgent(event: FormEvent) {
    event.preventDefault();
    if (mutationRef.current) return;
    const operationId = mutationRef.current + 1;
    mutationRef.current = operationId;
    setMutating(true);
    const draftSnapshot = newConfig;
    const nameSnapshot = newName.trim();
    const descriptionSnapshot = newDescription.trim() || null;
    const parsed = parseAgentConfigDraft(newConfig);
    if (!parsed.ok) {
      setNewValidation({ status: 'invalid', errors: [{ path: '', code: 'JSON_INVALID', message: parsed.error }], warnings: [] });
      mutationRef.current = 0;
      setMutating(false);
      return;
    }
    setError('');
    setNotice('');
    try {
      if (!configOptions) {
        setNewValidation({ status: 'unavailable', errors: [], warnings: [], message: 'Configuration options are unavailable' });
        return;
      }
      if (hasUnavailableDependency(parsed.config)) {
        setNewValidation({ status: 'unavailable', errors: [], warnings: [], message: 'A referenced capability directory is unavailable' });
        return;
      }
      const checked = await validateForWrite(parsed.config);
      if (!checked) {
        setNewValidation({ status: 'unavailable', errors: [], warnings: [], message: 'Validation request failed' });
        return;
      }
      const checkedState = validationState(checked);
      if (!mountedRef.current || mutationRef.current !== operationId) return;
      if (newConfigRef.current !== draftSnapshot) {
        setNewValidation({ status: 'unavailable', errors: [], warnings: [], message: 'The draft changed while validation was running. Review the new draft before publishing.' });
        return;
      }
      setNewValidation(checkedState);
      if (checkedState.status !== 'valid') return;
      const created = await createAgent({
        name: nameSnapshot,
        description: descriptionSnapshot,
        config: parsed.config,
      });
      if (!mountedRef.current || mutationRef.current !== operationId) return;
      setNewName('');
      setNewDescription('');
      setNewConfig(formatAgentConfig({ schemaVersion: 1 }));
      setNewValidation(EMPTY_VALIDATION);
      setNotice(`Created "${created.agent.name}" with version 1.`);
      if (mountedRef.current) await refresh(created.agent.agent_id);
    } catch (err) {
      if (mountedRef.current) setError(errorMessage(err) || 'Failed to create agent');
    } finally {
      if (mutationRef.current === operationId) mutationRef.current = 0;
      if (mountedRef.current) setMutating(false);
    }
  }

  async function saveAsNewVersion(activate: boolean) {
    if (mutationRef.current) return;
    const operationId = mutationRef.current + 1;
    mutationRef.current = operationId;
    setMutating(true);
    const draftSnapshot = configDraft;
    const agentSnapshot = selectedAgentId;
    const expectedActiveVersionId = selectedAgent?.active_version_id ?? null;
    const parsed = parseAgentConfigDraft(configDraft);
    if (!parsed.ok) {
      setValidation({ status: 'invalid', errors: [{ path: '', code: 'JSON_INVALID', message: parsed.error }], warnings: [] });
      mutationRef.current = 0;
      setMutating(false);
      return;
    }
    setError('');
    setNotice('');
    try {
      if (!configOptions) {
        setValidation({ status: 'unavailable', errors: [], warnings: [], message: 'Configuration options are unavailable' });
        return;
      }
      if (hasUnavailableDependency(parsed.config)) {
        setValidation({ status: 'unavailable', errors: [], warnings: [], message: 'A referenced capability directory is unavailable' });
        return;
      }
      const checked = await validateForWrite(parsed.config, agentSnapshot);
      if (!checked) {
        setValidation({ status: 'unavailable', errors: [], warnings: [], message: 'Validation request failed' });
        return;
      }
      const checkedState = validationState(checked);
      if (!mountedRef.current || mutationRef.current !== operationId) return;
      if (
        configDraftRef.current !== draftSnapshot ||
        selectedAgentIdRef.current !== agentSnapshot ||
        selectedAgentRef.current?.active_version_id !== expectedActiveVersionId
      ) {
        setValidation({ status: 'unavailable', errors: [], warnings: [], message: 'The Agent or draft changed while validation was running. Review the current draft before publishing.' });
        return;
      }
      setValidation(checkedState);
      if (checkedState.status !== 'valid') return;
      const result = await createAgentVersion(selectedAgentId, {
        config: parsed.config,
        activate,
        expected_active_version_id: expectedActiveVersionId,
      });
      if (!mountedRef.current || mutationRef.current !== operationId) return;
      if (configDraftRef.current === draftSnapshot && selectedAgentIdRef.current === agentSnapshot) {
        draftByAgentRef.current.delete(selectedAgentId);
        setConfigDraft(formatAgentConfig(result.version.config || parsed.config));
        setViewVersionId(result.version.agent_version_id);
      }
      if (mountedRef.current && selectedAgentIdRef.current === agentSnapshot) {
        setNotice(
          activate
            ? `Created version ${result.version.version_no} and made it active. New conversations use it; existing ones keep their pinned version.`
            : `Created version ${result.version.version_no} without activating it.`,
        );
        await refresh(agentSnapshot, true, agentSnapshot);
      }
    } catch (err) {
      if (conflictError(err)) {
        if (selectedAgentIdRef.current !== agentSnapshot) {
          // A late response for Agent A must not navigate away from the Agent B
          // the user selected while the write was in flight. Keep A's draft in
          // its per-agent cache; selecting A later will reload its version line.
          draftByAgentRef.current.set(agentSnapshot, draftSnapshot);
          if (mountedRef.current) {
            setError('A version conflict occurred for another Agent. Its draft was preserved.');
          }
        } else {
          const preserved = configDraftRef.current === draftSnapshot ? draftSnapshot : configDraftRef.current;
          await refresh(agentSnapshot, true, agentSnapshot);
          if (mountedRef.current && selectedAgentIdRef.current === agentSnapshot) setConfigDraft(preserved);
          if (mountedRef.current && selectedAgentIdRef.current === agentSnapshot) {
            setValidation({ status: 'unavailable', errors: [], warnings: [], message: 'The active version changed. Review the refreshed version line before publishing this draft again.' });
            setError('Activation conflict: another administrator changed the active version. Your draft was preserved.');
          }
        }
      } else {
        if (mountedRef.current) setError(errorMessage(err) || 'Failed to create version');
      }
    } finally {
      if (mutationRef.current === operationId) mutationRef.current = 0;
      if (mountedRef.current) setMutating(false);
    }
  }

  async function activate(agentVersionId: string, versionNo: number) {
    if (mutationRef.current) return;
    const operationId = mutationRef.current + 1;
    mutationRef.current = operationId;
    setMutating(true);
    const agentSnapshot = selectedAgentId;
    const draftSnapshot = configDraftRef.current;
    const expectedActiveVersionId = selectedAgent?.active_version_id ?? null;
    setError('');
    setNotice('');
    try {
      await setAgentActiveVersion(agentSnapshot, agentVersionId, expectedActiveVersionId);
      if (!mountedRef.current || mutationRef.current !== operationId) return;
      if (mountedRef.current && selectedAgentIdRef.current === agentSnapshot) {
        setNotice(
          `Version ${versionNo} is now active. Only new conversations pick it up.`,
        );
        await refresh(agentSnapshot, true, agentSnapshot);
      }
    } catch (err) {
      if (conflictError(err)) {
        if (selectedAgentIdRef.current !== agentSnapshot) {
          draftByAgentRef.current.set(agentSnapshot, draftSnapshot);
          if (mountedRef.current) {
            setError('A version conflict occurred for another Agent. Its draft was preserved.');
          }
        } else {
          const preserved = configDraftRef.current === draftSnapshot ? draftSnapshot : configDraftRef.current;
          await refresh(agentSnapshot, true, agentSnapshot);
          if (mountedRef.current && selectedAgentIdRef.current === agentSnapshot) setConfigDraft(preserved);
          if (mountedRef.current && selectedAgentIdRef.current === agentSnapshot) {
            setValidation({ status: 'unavailable', errors: [], warnings: [], message: 'The active version changed. Review the refreshed version line before activating again.' });
            setError('Activation conflict: another administrator changed the active version. Your draft was preserved.');
          }
        }
      } else {
        if (mountedRef.current) setError(errorMessage(err) || 'Failed to activate version');
      }
    } finally {
      if (mutationRef.current === operationId) mutationRef.current = 0;
      if (mountedRef.current) setMutating(false);
    }
  }

  return (
    <div className="mgmt-page">
      <header className="mgmt-header">
        <div>
          <h2 className="mgmt-title">Agents</h2>
          <p className="mgmt-subtitle">
            Agents available to this organization. Users pick one when they start a
            conversation; the choice is fixed for that conversation's lifetime.
          </p>
        </div>
          <button
            type="button"
            className="mgmt-btn"
          onClick={() => void refresh(selectedAgentId, configChanged, selectedAgentId)}
          disabled={loading}
        >
          <IconRefresh size={14} className={loading ? 'icon-spin' : ''} />
          <span>{loading ? 'Refreshing…' : 'Refresh'}</span>
        </button>
      </header>

      {error ? <p className="mgmt-error">{error}</p> : null}
      {notice ? <p className="mgmt-notice" role="status">{notice}</p> : null}
      {loading ? (
        <div className="mgmt-empty">
          <IconSparkles size={24} className="icon-pulse" />
          <p>Loading agents…</p>
        </div>
      ) : null}

      {!loading ? (
        <>
          <section className="mgmt-section">
            <h3 className="mgmt-section-title">Organization Agents</h3>
            <div className="mgmt-table-wrap">
              <table className="mgmt-table">
                <thead>
                  <tr>
                    <th>Name</th><th>Description</th><th>Status</th>
                    <th>Active Version</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((agent) => (
                    <tr
                      key={agent.agent_id}
                      className={agent.agent_id === selectedAgentId ? 'is-selected' : ''}
                    >
                      <td><strong>{agent.name}</strong></td>
                      <td>{agent.description || '—'}</td>
                      <td>
                        <span className={`mgmt-status status-${agent.status}`}>
                          <span className="mgmt-status-dot" />{agent.status}
                        </span>
                      </td>
                      <td>
                        {agent.active_version_no != null
                          ? `v${agent.active_version_no}`
                          : '—'}
                      </td>
                      <td>
                        <div className="mgmt-row-actions">
                          <button
                            type="button"
                            className="mgmt-btn secondary sm"
                            disabled={agent.agent_id === selectedAgentId}
                            onClick={() => void selectAgent(agent.agent_id)}
                          >
                            {agent.agent_id === selectedAgentId ? 'Editing' : 'Edit'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {agents.length === 0 ? (
              <div className="mgmt-empty">No agents in this organization yet.</div>
            ) : null}
          </section>

          <section className="mgmt-section">
            <h3 className="mgmt-section-title">New Agent</h3>
            <p className="mgmt-hint">
              A new agent is a new option in the user's picker — not a new version of
              an existing one. It starts at version 1.
            </p>
            <form className="mgmt-form" onSubmit={submitNewAgent}>
              <div className="mgmt-field-row">
                <label className="mgmt-field">
                  <span>Name</span>
                  <input
                    value={newName}
                    maxLength={255}
                    required
                    placeholder="数据分析助手"
                    onChange={(event) => setNewName(event.target.value)}
                  />
                </label>
                <label className="mgmt-field">
                  <span>Description (Optional)</span>
                  <input
                    value={newDescription}
                    maxLength={2000}
                    placeholder="SQL + charts"
                    onChange={(event) => setNewDescription(event.target.value)}
                  />
                </label>
              </div>
              <AgentConfigEditor
                value={newConfig}
                onChange={setNewConfig}
                models={catalogs.models}
                tools={catalogs.tools}
                mcpServers={catalogs.mcpServers}
                options={configOptions}
                errors={newValidation.errors}
                disabled={mutating}
              />
              <AgentValidationPanel state={newValidation} draft={newConfig} />
              <div className="mgmt-form-actions">
                <button
                  type="submit"
                  className="mgmt-btn"
                  disabled={mutating || !newName.trim()}
                >
                  Create Agent
                </button>
              </div>
            </form>
          </section>

          {selectedAgent ? (
            <>
              <section className="mgmt-section">
                <h3 className="mgmt-section-title">
                  Configuration — {selectedAgent.name}
                </h3>
                <p className="mgmt-hint">
                  Saving does <strong>not</strong> edit the current version. It creates
                  the next version and (unless you say otherwise) makes it active.
                  Existing conversations keep the version they were created with;
                  only new conversations pick up the change.
                </p>
                <AgentConfigEditor
                  value={configDraft}
                  onChange={setConfigDraft}
                  models={catalogs.models}
                  tools={catalogs.tools}
                  mcpServers={catalogs.mcpServers}
                  options={configOptions}
                  errors={validation.errors}
                  disabled={mutating}
                />
                <AgentValidationPanel state={validation} draft={configDraft} />
                {viewedVersion ? (
                  <div className="agent-version-preview">
                    <div className="agent-config-block-head">
                      <h4>Viewing v{viewedVersion.version_no}</h4>
                      <div className="mgmt-row-actions">
                        <button
                          type="button"
                          className="mgmt-btn secondary sm"
                          onClick={() => {
                            setConfigDraft(formatAgentConfig(viewedVersion.config));
                            setViewVersionId(viewedVersion.agent_version_id);
                            setNotice(`Copied v${viewedVersion.version_no} into the draft. Publish it as a new version when ready.`);
                          }}
                        >
                          Copy to draft
                        </button>
                      </div>
                    </div>
                    <pre>{formatAgentConfig(viewedVersion.config)}</pre>
                  </div>
                ) : null}
                <div className="mgmt-form-actions">
                  <button
                    type="button"
                    className="mgmt-btn"
                    disabled={mutating || !configChanged || !parsedDraft.ok || validation.status !== 'valid'}
                    onClick={() => void saveAsNewVersion(true)}
                  >
                    Save and activate new version
                  </button>
                  <button
                    type="button"
                    className="mgmt-btn secondary"
                    disabled={mutating || !configChanged || !parsedDraft.ok || validation.status !== 'valid'}
                    onClick={() => void saveAsNewVersion(false)}
                  >
                    Save without activating
                  </button>
                </div>
              </section>

              <section className="mgmt-section">
                <h3 className="mgmt-section-title">Version History</h3>
                <p className="mgmt-hint">
                  Rolling back is just activating an older version — no data repair,
                  and no effect on conversations already running.
                </p>
                <div className="mgmt-table-wrap">
                  <table className="mgmt-table">
                    <thead>
                      <tr>
                        <th>Version</th><th>Config Hash</th>
                        <th>Created</th><th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {versions.map((version) => {
                        const isActive =
                          version.agent_version_id === selectedAgent.active_version_id;
                        return (
                          <tr key={version.agent_version_id}>
                            <td>
                              <strong>v{version.version_no}</strong>
                              {isActive ? (
                                <span className="mgmt-status status-active">
                                  <span className="mgmt-status-dot" />active
                                </span>
                              ) : null}
                            </td>
                            <td>
                              <code className="mgmt-id-code">
                                {String(version.config_hash || '').slice(0, 12) || '—'}
                              </code>
                            </td>
                            <td>{version.created_at || '—'}</td>
                            <td>
                              <div className="mgmt-row-actions">
                                <button
                                  type="button"
                                  className="mgmt-btn secondary sm"
                                  disabled={mutating}
                                  onClick={() => setViewVersionId(version.agent_version_id)}
                                >
                                  View
                                </button>
                                <button
                                  type="button"
                                  className="mgmt-btn secondary sm"
                                  disabled={mutating}
                                  onClick={() => {
                                    setConfigDraft(formatAgentConfig(version.config));
                                    setViewVersionId(version.agent_version_id);
                                    setNotice(`Copied v${version.version_no} into the draft. Publish it as a new version when ready.`);
                                  }}
                                >
                                  Copy
                                </button>
                                <button
                                  type="button"
                                  className="mgmt-btn secondary sm"
                                  disabled={mutating || isActive}
                                  onClick={() => void activate(
                                    version.agent_version_id, version.version_no,
                                  )}
                                >
                                  {isActive ? 'Active' : 'Activate'}
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
