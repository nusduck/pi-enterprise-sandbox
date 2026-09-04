/**
 * Agents 管理页（admin）：org 内并列的智能体、它们的配置与版本线。
 *
 * UI 上刻意反复说明的一件事：**保存 = 建新版本**。`agent_versions` 不可变，
 * 编辑配置产生 `version_no + 1` 的新行，旧行保留；切换活跃版本只影响**新建的
 * 会话**，正在跑的 Run 与已存在的会话继续用它们钉住的版本
 * （`docs/design/multi-agent-selection.md` D4）。把它写成"保存"而不解释，用户
 * 会以为是原地修改，然后困惑于"为什么改了配置老会话没变"。
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  createAgent,
  createAgentVersion,
  listAgentVersions,
  listAgents,
  setAgentActiveVersion,
  type Agent,
  type AgentVersion,
} from '../../shared/api';
import {
  activeVersionOf,
  formatAgentConfig,
  isConfigDraftChanged,
  parseAgentConfigDraft,
  sortAgentsForDisplay,
} from './agentHelpers';
import { IconRefresh, IconSparkles } from '../../shared/ui/Icons';

const NEW_AGENT_CONFIG_PLACEHOLDER = `{
  "systemPrompt": "你是数据分析助手",
  "skills": [],
  "toolPolicy": {}
}`;

export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [configDraft, setConfigDraft] = useState('');
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newConfig, setNewConfig] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);

  const selectedAgent = agents.find((agent) => agent.agent_id === selectedAgentId) ?? null;
  const activeVersion = activeVersionOf(selectedAgent, versions);
  const configChanged = isConfigDraftChanged(configDraft, activeVersion?.config);

  const loadVersions = useCallback(async (agentId: string) => {
    if (!agentId) {
      setVersions([]);
      setConfigDraft('');
      return;
    }
    const detail = await listAgentVersions(agentId);
    setVersions(detail.versions);
    const active = activeVersionOf(detail.agent, detail.versions);
    setConfigDraft(formatAgentConfig(active?.config));
  }, []);

  const refresh = useCallback(async (preferAgentId?: string) => {
    setLoading(true);
    setError('');
    try {
      const list = sortAgentsForDisplay(await listAgents());
      setAgents(list);
      const next =
        (preferAgentId && list.some((a) => a.agent_id === preferAgentId)
          ? preferAgentId
          : null) ??
        list[0]?.agent_id ??
        '';
      setSelectedAgentId(next);
      await loadVersions(next);
    } catch (err) {
      setError((err as Error).message || 'Failed to load agents');
    } finally {
      setLoading(false);
    }
  }, [loadVersions]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function selectAgent(agentId: string) {
    setSelectedAgentId(agentId);
    setError('');
    setNotice('');
    try {
      await loadVersions(agentId);
    } catch (err) {
      setError((err as Error).message || 'Failed to load version history');
    }
  }

  async function submitNewAgent(event: FormEvent) {
    event.preventDefault();
    const parsed = parseAgentConfigDraft(newConfig);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setMutating(true);
    setError('');
    setNotice('');
    try {
      const created = await createAgent({
        name: newName.trim(),
        description: newDescription.trim() || null,
        config: parsed.config,
      });
      setNewName('');
      setNewDescription('');
      setNewConfig('');
      setNotice(`Created "${created.agent.name}" with version 1.`);
      await refresh(created.agent.agent_id);
    } catch (err) {
      setError((err as Error).message || 'Failed to create agent');
    } finally {
      setMutating(false);
    }
  }

  async function saveAsNewVersion(activate: boolean) {
    const parsed = parseAgentConfigDraft(configDraft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setMutating(true);
    setError('');
    setNotice('');
    try {
      const result = await createAgentVersion(selectedAgentId, {
        config: parsed.config,
        activate,
      });
      setNotice(
        activate
          ? `Created version ${result.version.version_no} and made it active. New conversations use it; existing ones keep their pinned version.`
          : `Created version ${result.version.version_no} without activating it.`,
      );
      await refresh(selectedAgentId);
    } catch (err) {
      setError((err as Error).message || 'Failed to create version');
    } finally {
      setMutating(false);
    }
  }

  async function activate(agentVersionId: string, versionNo: number) {
    setMutating(true);
    setError('');
    setNotice('');
    try {
      await setAgentActiveVersion(selectedAgentId, agentVersionId);
      setNotice(
        `Version ${versionNo} is now active. Only new conversations pick it up.`,
      );
      await refresh(selectedAgentId);
    } catch (err) {
      setError((err as Error).message || 'Failed to activate version');
    } finally {
      setMutating(false);
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
          onClick={() => void refresh(selectedAgentId)}
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
              <label className="mgmt-field">
                <span>Config JSON (Optional)</span>
                <textarea
                  className="mgmt-code-input"
                  rows={8}
                  value={newConfig}
                  placeholder={NEW_AGENT_CONFIG_PLACEHOLDER}
                  onChange={(event) => setNewConfig(event.target.value)}
                />
              </label>
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
                <label className="mgmt-field">
                  <span>
                    Config JSON
                    {activeVersion ? ` (from v${activeVersion.version_no})` : ''}
                  </span>
                  <textarea
                    className="mgmt-code-input"
                    rows={16}
                    value={configDraft}
                    onChange={(event) => setConfigDraft(event.target.value)}
                  />
                </label>
                <div className="mgmt-form-actions">
                  <button
                    type="button"
                    className="mgmt-btn"
                    disabled={mutating || !configChanged}
                    onClick={() => void saveAsNewVersion(true)}
                  >
                    Save as new active version
                  </button>
                  <button
                    type="button"
                    className="mgmt-btn secondary"
                    disabled={mutating || !configChanged}
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
