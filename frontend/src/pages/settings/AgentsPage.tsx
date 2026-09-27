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
  catalogFromResult,
  configDiff,
  formatDiffValue,
  mcpEntriesOf,
  toolDecisionsOf,
  configNeedsCapability,
  formatAgentConfig,
  isConfigDraftChanged,
  parseAgentConfigDraft,
  sortAgentsForDisplay,
  type AgentConfigValidationState,
  type CatalogState,
} from './agentHelpers';
import { AgentConfigEditor, type EditorSection } from './AgentConfigEditor';
import { delegationOf } from './delegationHelpers';
import { dataSourcesOf } from './dataSourceHelpers';
import { AgentValidationPanel, validationSummary } from './AgentValidationPanel';
import { IconRefresh } from '../../shared/ui/Icons';
import { agentTone } from '../../widgets/conversation-sidebar/sidebarModel';
import s from './agents.module.css';

type AgentTab = EditorSection | 'versions';

const EMPTY_VALIDATION: AgentConfigValidationState = {
  status: 'idle',
  errors: [],
  warnings: [],
};

function loadingCatalog<T>(): CatalogState<T> {
  return { items: [], available: false, loading: true, error: null };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
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

export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [configDraft, setConfigDraft] = useState('');
  // The agent list doubles as the delegation candidate directory.
  const [agentsLoaded, setAgentsLoaded] = useState(false);
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
  const [mode, setMode] = useState<'edit' | 'new'>('edit');
  const [tab, setTab] = useState<AgentTab>('basic');
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
      setAgentsLoaded(true);
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
        setError(errorMessage(err) || '读取智能体失败');
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
      setError(errorMessage(err) || '读取版本历史失败');
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
      if (mountedRef.current) setError(`无法校验这份配置：${errorMessage(err)}`);
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
        setNewValidation({ status: 'unavailable', errors: [], warnings: [], message: '配置选项暂不可用' });
        return;
      }
      if (hasUnavailableDependency(parsed.config)) {
        setNewValidation({ status: 'unavailable', errors: [], warnings: [], message: '引用的能力目录暂不可用' });
        return;
      }
      const checked = await validateForWrite(parsed.config);
      if (!checked) {
        setNewValidation({ status: 'unavailable', errors: [], warnings: [], message: '校验请求失败' });
        return;
      }
      const checkedState = validationState(checked);
      if (!mountedRef.current || mutationRef.current !== operationId) return;
      if (newConfigRef.current !== draftSnapshot) {
        setNewValidation({ status: 'unavailable', errors: [], warnings: [], message: '校验期间草稿有变动，请核对新草稿后再发布。' });
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
      setMode('edit');
      setTab('basic');
      setNotice(`已创建「${created.agent.name}」（v1）。`);
      if (mountedRef.current) await refresh(created.agent.agent_id);
    } catch (err) {
      if (mountedRef.current) setError(errorMessage(err) || '创建智能体失败');
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
        setValidation({ status: 'unavailable', errors: [], warnings: [], message: '配置选项暂不可用' });
        return;
      }
      if (hasUnavailableDependency(parsed.config)) {
        setValidation({ status: 'unavailable', errors: [], warnings: [], message: '引用的能力目录暂不可用' });
        return;
      }
      const checked = await validateForWrite(parsed.config, agentSnapshot);
      if (!checked) {
        setValidation({ status: 'unavailable', errors: [], warnings: [], message: '校验请求失败' });
        return;
      }
      const checkedState = validationState(checked);
      if (!mountedRef.current || mutationRef.current !== operationId) return;
      if (
        configDraftRef.current !== draftSnapshot ||
        selectedAgentIdRef.current !== agentSnapshot ||
        selectedAgentRef.current?.active_version_id !== expectedActiveVersionId
      ) {
        setValidation({ status: 'unavailable', errors: [], warnings: [], message: '校验期间智能体或草稿有变动，请核对当前草稿后再发布。' });
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
            ? `已生成 v${result.version.version_no} 并启用。新会话使用它，已有会话继续用原版本。`
            : `已生成 v${result.version.version_no}，未启用。`,
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
            setError('另一个智能体发生版本冲突，它的草稿已保留。');
          }
        } else {
          const preserved = configDraftRef.current === draftSnapshot ? draftSnapshot : configDraftRef.current;
          await refresh(agentSnapshot, true, agentSnapshot);
          if (mountedRef.current && selectedAgentIdRef.current === agentSnapshot) setConfigDraft(preserved);
          if (mountedRef.current && selectedAgentIdRef.current === agentSnapshot) {
            setValidation({ status: 'unavailable', errors: [], warnings: [], message: '启用版本已被改动，请核对刷新后的版本线再发布这份草稿。' });
            setError('启用冲突：其他管理员改动了启用版本，你的草稿已保留。');
          }
        }
      } else {
        if (mountedRef.current) setError(errorMessage(err) || '保存新版本失败');
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
          `v${versionNo} 已启用，只有新会话会使用它。`,
        );
        await refresh(agentSnapshot, true, agentSnapshot);
      }
    } catch (err) {
      if (conflictError(err)) {
        if (selectedAgentIdRef.current !== agentSnapshot) {
          draftByAgentRef.current.set(agentSnapshot, draftSnapshot);
          if (mountedRef.current) {
            setError('另一个智能体发生版本冲突，它的草稿已保留。');
          }
        } else {
          const preserved = configDraftRef.current === draftSnapshot ? draftSnapshot : configDraftRef.current;
          await refresh(agentSnapshot, true, agentSnapshot);
          if (mountedRef.current && selectedAgentIdRef.current === agentSnapshot) setConfigDraft(preserved);
          if (mountedRef.current && selectedAgentIdRef.current === agentSnapshot) {
            setValidation({ status: 'unavailable', errors: [], warnings: [], message: '启用版本已被改动，请核对刷新后的版本线再启用。' });
            setError('启用冲突：其他管理员改动了启用版本，你的草稿已保留。');
          }
        }
      } else {
        if (mountedRef.current) setError(errorMessage(err) || '启用版本失败');
      }
    } finally {
      if (mutationRef.current === operationId) mutationRef.current = 0;
      if (mountedRef.current) setMutating(false);
    }
  }

  function discardDraft() {
    draftByAgentRef.current.delete(selectedAgentId);
    setConfigDraft(formatAgentConfig(activeVersion?.config));
    setViewVersionId(activeVersion?.agent_version_id ?? null);
    setNotice('');
  }

  function copyToDraft(version: AgentVersion) {
    setConfigDraft(formatAgentConfig(version.config));
    setViewVersionId(version.agent_version_id);
    setTab('basic');
    setNotice(`已把 v${version.version_no} 复制到草稿；保存后会成为新版本。`);
  }

  const creating = mode === 'new';
  const canPublish = !mutating && configChanged && parsedDraft.ok && validation.status === 'valid';
  const [statusText, statusCls] = validationSummary(creating ? newValidation : validation);
  // What the draft changes relative to the active version (or the new-agent draft itself).
  const draftConfig = creating ? parseAgentConfigDraft(newConfig) : parsedDraft;
  const draftChanges = !creating && configChanged && parsedDraft.ok ? configDiff(activeVersion?.config ?? {}, parsedDraft.config) : [];
  const nextVersionNo = Math.max(0, ...versions.map((v) => v.version_no)) + 1;
  const overrideCount = draftConfig.ok ? Object.keys(toolDecisionsOf(draftConfig.config)).length : 0;
  const mcpCount = draftConfig.ok ? mcpEntriesOf(draftConfig.config).length : 0;
  const delegation = draftConfig.ok ? delegationOf(draftConfig.config) : null;
  const delegationCount = delegation ? delegation.agents.length + delegation.remoteAgents.length : 0;
  const dataSourceCount = draftConfig.ok ? dataSourcesOf(draftConfig.config).length : 0;
  const tabs: Array<[AgentTab, string, number?]> = [
    ['basic', '基本信息'],
    ['model', '模型'],
    ['tools', '工具权限', overrideCount],
    ['mcp', 'MCP', mcpCount],
    ['delegation', '协作', delegationCount],
    ['dataSources', '数据源', dataSourceCount],
    ...(creating ? [] : [['versions', '版本历史'] as [AgentTab, string]]),
    ['json', 'JSON'],
  ];
  const section: EditorSection = tab === 'versions' ? 'basic' : tab;
  const editorProps = {
    section,
    models: catalogs.models,
    tools: catalogs.tools,
    mcpServers: catalogs.mcpServers,
    agents: { items: agents, available: agentsLoaded, loading: loading && !agentsLoaded },
    selfName: creating ? newName : selectedAgent?.name ?? '',
    options: configOptions,
    disabled: mutating,
  };

  return (
    <div className={s.page}>
      <aside className={s.list} aria-label="智能体列表">
        <div className={s.listHead}>
          <b>智能体</b>
          <span className={s.sp} />
          <button
            type="button"
            className={s.iconBtn}
            title="刷新"
            aria-label="刷新"
            onClick={() => void refresh(selectedAgentId, configChanged, selectedAgentId)}
            disabled={loading}
          >
            <IconRefresh size={14} className={loading ? 'icon-spin' : ''} />
          </button>
        </div>
        <button
          type="button"
          className={`${s.newBtn}${creating ? ` ${s.on}` : ''}`}
          onClick={() => { setMode('new'); setTab('basic'); setNotice(''); setError(''); }}
        >
          ＋ 新建智能体
        </button>
        {loading && !agents.length ? <p className={s.hint}>正在读取…</p> : null}
        {!loading && !agents.length ? <p className={s.hint}>这个组织还没有智能体。</p> : null}
        {agents.map((agent) => {
          const on = !creating && agent.agent_id === selectedAgentId;
          const dirty = agent.agent_id === selectedAgentId ? configChanged : draftByAgentRef.current.has(agent.agent_id);
          return (
            <button
              key={agent.agent_id}
              type="button"
              className={`${s.item}${on ? ` ${s.on}` : ''}`}
              aria-current={on ? 'true' : undefined}
              onClick={() => {
                setMode('edit');
                if (agent.agent_id !== selectedAgentId) {
                  setTab('basic');
                  void selectAgent(agent.agent_id);
                }
              }}
            >
              <span className={s.dot} style={{ background: `var(--agent-tone-${agentTone(agent.agent_id)})` }} aria-hidden="true" />
              <span className={s.itemText}>
                <b>{agent.name}{dirty ? <i className={s.dirty} title="有未保存的修改" /> : null}</b>
                <small>{agent.description || '—'}</small>
              </span>
              <span className={s.ver}>{agent.active_version_no != null ? `v${agent.active_version_no}` : '—'}</span>
            </button>
          );
        })}
      </aside>

      <section className={s.editor} aria-label={creating ? '新建智能体' : '智能体配置'}>
        {creating || selectedAgent ? (
          <div className={s.bar}>
            <div className={s.barTitle}>
              <h1>{creating ? '新建智能体' : selectedAgent?.name}</h1>
              <small>
                {creating
                  ? '新智能体是用户选择器里的新选项，从 v1 开始'
                  : `编辑基于 v${activeVersion?.version_no ?? '—'} · 保存会生成新版本，已有会话继续用原版本`}
              </small>
            </div>
            <span className={s.sp} />
            {!creating && configChanged ? (
              <span className={s.unsaved}>{draftChanges.length ? `${draftChanges.length} 处未保存修改` : '未保存修改'}</span>
            ) : null}
            {statusText && (creating || configChanged) ? <span className={`${s.status} ${statusCls}`}>{statusText}</span> : null}
            {creating ? (
              <button type="submit" form="new-agent-form" className={s.btnPri} disabled={mutating || !newName.trim()}>
                创建智能体
              </button>
            ) : (
              <>
                <button type="button" className={s.btn} disabled={mutating || !configChanged} onClick={discardDraft}>放弃修改</button>
                <button type="button" className={s.btn} disabled={!canPublish} onClick={() => void saveAsNewVersion(false)}>仅保存为 v{nextVersionNo}</button>
                <button type="button" className={s.btnPri} disabled={!canPublish} onClick={() => void saveAsNewVersion(true)}>保存并启用 v{nextVersionNo}</button>
              </>
            )}
          </div>
        ) : null}

        {error ? <p className={s.errBox} role="alert">{error}</p> : null}
        {notice ? <p className={s.okBox} role="status">{notice}</p> : null}

        {creating || selectedAgent ? (
          <div className={s.tabs} role="tablist" aria-label="配置分类">
            {tabs.map(([id, label, count]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
                {label}{count ? <span className={s.tabCount} title={id === 'tools' ? '已覆盖的工具数' : '已选的 MCP 服务数'}>{count}</span> : null}
              </button>
            ))}
          </div>
        ) : null}

        {creating ? (
          <form id="new-agent-form" className={s.body} onSubmit={submitNewAgent}>
            {tab === 'basic' ? (
              <div className={s.grid2}>
                <label className={s.field}>
                  <span>名称</span>
                  <input value={newName} maxLength={255} required placeholder="数据分析助手" onChange={(event) => setNewName(event.target.value)} />
                </label>
                <label className={s.field}>
                  <span>简介（可选）</span>
                  <input value={newDescription} maxLength={2000} placeholder="SQL 查询与图表" onChange={(event) => setNewDescription(event.target.value)} />
                </label>
              </div>
            ) : null}
            <AgentConfigEditor {...editorProps} value={newConfig} onChange={setNewConfig} errors={newValidation.errors} />
            <AgentValidationPanel state={newValidation} draft={newConfig} />
          </form>
        ) : selectedAgent ? (
          <div className={s.body}>
            {tab === 'versions' ? (
              <>
                <p className={s.hint}>回滚就是启用旧版本：不修复数据，也不影响正在进行的会话。只有新会话会用新启用的版本。</p>
                {draftChanges.length ? (
                  <div className={s.diff} aria-label="草稿与启用版本的差异">
                    <div className={s.diffHead}>
                      <b>v{activeVersion?.version_no ?? '—'} → 草稿（将保存为 v{nextVersionNo}）</b>
                      <span className={s.hint}>{draftChanges.length} 处修改</span>
                    </div>
                    {draftChanges.map((c) => (
                      <div key={c.path} className={s.diffRow}>
                        <code className={s.diffDel}>- {c.path}: {formatDiffValue(c.before)}</code>
                        <code className={s.diffAdd}>+ {c.path}: {formatDiffValue(c.after)}</code>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className={s.versions}>
                  {versions.map((version) => {
                    const isActive = version.agent_version_id === selectedAgent.active_version_id;
                    const open = version.agent_version_id === viewVersionId;
                    return (
                      <div key={version.agent_version_id} className={`${s.version}${open ? ` ${s.on}` : ''}`}>
                        <div className={s.versionHead}>
                          <b>v{version.version_no}</b>
                          {isActive ? <span className={`${s.status} ${s.stOk}`}>当前启用</span> : null}
                          <code className={s.hint}>{String(version.config_hash || '').slice(0, 12) || '—'}</code>
                          <span className={s.hint}>{formatTime(version.created_at)}</span>
                          <span className={s.sp} />
                          <button type="button" className={s.btnSm} onClick={() => setViewVersionId(open ? null : version.agent_version_id)}>{open ? '收起' : '查看'}</button>
                          <button type="button" className={s.btnSm} disabled={mutating} onClick={() => copyToDraft(version)}>复制到草稿</button>
                          <button type="button" className={s.btnSm} disabled={mutating || isActive} onClick={() => void activate(version.agent_version_id, version.version_no)}>
                            {isActive ? '已启用' : '启用'}
                          </button>
                        </div>
                        {open ? <pre className={s.pre}>{formatAgentConfig(version.config)}</pre> : null}
                      </div>
                    );
                  })}
                  {!versions.length ? <p className={s.hint}>没有版本记录。</p> : null}
                </div>
              </>
            ) : (
              <>
                {tab === 'basic' ? (
                  <div className={s.meta}>
                    <span>名称<b>{selectedAgent.name}</b></span>
                    <span>简介<b>{selectedAgent.description || '—'}</b></span>
                    <span>状态<b>{selectedAgent.status === 'active' ? '启用' : selectedAgent.status}</b></span>
                    {viewedVersion && viewedVersion.agent_version_id !== activeVersion?.agent_version_id
                      ? <span>草稿来源<b>v{viewedVersion.version_no}</b></span>
                      : null}
                  </div>
                ) : null}
                <AgentConfigEditor {...editorProps} value={configDraft} onChange={setConfigDraft} errors={validation.errors} />
                <AgentValidationPanel state={validation} draft={configDraft} />
              </>
            )}
          </div>
        ) : !loading ? (
          <div className={s.empty}>从左侧选择一个智能体，或新建一个。</div>
        ) : null}
      </section>
    </div>
  );
}
