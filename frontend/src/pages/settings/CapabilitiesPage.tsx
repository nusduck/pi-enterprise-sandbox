/**
 * Capability management — /settings/capabilities (F5 / ADR 0003 §11).
 * Tabs: Skills · MCP Servers · Tools · Models
 * Soft-fails when registry BFF endpoints are incomplete.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  listMcpServers,
  listModels,
  listSkills,
  listTools,
  getExtensionDiagnostics,
  type ExtensionDiagnostics,
  type McpServerItem,
  type ModelItem,
  type SkillItem,
  type SoftListResult,
  type ToolRegistryItem,
} from '../../shared/api/capabilities';

const TABS = [
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'tools', label: 'Tools' },
  { id: 'models', label: 'Models' },
  { id: 'diagnostics', label: 'Extension diagnostics' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function EmptyRegistry({
  label,
  available,
  error,
}: {
  label: string;
  available: boolean | null;
  error?: string | null;
}) {
  return (
    <div className="mgmt-empty">
      <p className="mgmt-empty-title">No {label} registered</p>
      <p className="mgmt-empty-body">
        {available === false
          ? `The ${label} registry API is not exposed on the BFF yet. When backend MCP/model registry routes are proxied under /api, they will appear here automatically.`
          : available === null
            ? 'Loading…'
            : error
              ? `Registry returned an error: ${error}`
              : `Registry is reachable but returned no ${label}.`}
      </p>
    </div>
  );
}

function statusLabel(item: {
  status?: string | null;
  enabled?: boolean;
  connection_status?: string | null;
}): string {
  if (item.status) return item.status;
  if (item.connection_status) return item.connection_status;
  return item.enabled === false ? 'disabled' : 'configured';
}

function SkillCards({ items }: { items: SkillItem[] }) {
  return (
    <ul className="mgmt-card-list">
      {items.map((s, i) => {
        const name = s.name || s.id || `skill-${i}`;
        const status = statusLabel(s);
        return (
          <li key={name} className="mgmt-card">
            <header className="mgmt-card-head">
              <h3 className="mgmt-card-title">{name}</h3>
              <span className={`mgmt-status status-${status}`}>{status}</span>
            </header>
            {s.description ? (
              <p className="mgmt-card-reason">{s.description}</p>
            ) : null}
            <dl className="mgmt-meta-grid">
              <div>
                <dt>Source</dt>
                <dd>{s.source || s.path || '—'}</dd>
              </div>
              <div>
                <dt>Enabled</dt>
                <dd>{s.enabled === false ? 'No' : 'Yes'}</dd>
              </div>
              <div>
                <dt>Dynamic</dt>
                <dd>{s.dynamic ? 'Yes' : 'No'}</dd>
              </div>
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

function McpCards({ items }: { items: McpServerItem[] }) {
  return (
    <ul className="mgmt-card-list">
      {items.map((s, i) => {
        const id = s.server_id || s.id || s.name || `mcp-${i}`;
        const status =
          s.status ||
          (s.enabled === false ? 'disabled' : s.connection_status || 'configured');
        const toolsCount = s.tools_count ?? s.tool_count ?? null;
        return (
          <li key={id} className="mgmt-card">
            <header className="mgmt-card-head">
              <h3 className="mgmt-card-title">{s.name || id}</h3>
              <span className={`mgmt-status status-${status}`}>{status}</span>
            </header>
            <dl className="mgmt-meta-grid">
              <div>
                <dt>Server ID</dt>
                <dd>
                  <code>{id}</code>
                </dd>
              </div>
              <div>
                <dt>Tools</dt>
                <dd>{toolsCount != null ? toolsCount : '—'}</dd>
              </div>
              <div>
                <dt>Authorization</dt>
                <dd>{s.authorization || '—'}</dd>
              </div>
              <div>
                <dt>Last refresh</dt>
                <dd>{s.last_refresh || s.last_refreshed_at || '—'}</dd>
              </div>
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

function ToolCards({ items }: { items: ToolRegistryItem[] }) {
  return (
    <ul className="mgmt-card-list">
      {items.map((t, i) => {
        const name = t.name || t.id || `tool-${i}`;
        const status = statusLabel(t);
        return (
          <li key={name} className="mgmt-card">
            <header className="mgmt-card-head">
              <h3 className="mgmt-card-title">{name}</h3>
              <span className={`mgmt-status status-${status}`}>{status}</span>
              {t.risk_level ? (
                <span className="mgmt-risk">risk: {t.risk_level}</span>
              ) : null}
            </header>
            {t.description ? (
              <p className="mgmt-card-reason">{t.description}</p>
            ) : null}
            <dl className="mgmt-meta-grid">
              <div>
                <dt>Category</dt>
                <dd>{t.category || '—'}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{t.source || '—'}</dd>
              </div>
              <div>
                <dt>Approval</dt>
                <dd>{t.approval_policy || '—'}</dd>
              </div>
              <div>
                <dt>Timeout</dt>
                <dd>{t.timeout != null ? String(t.timeout) : '—'}</dd>
              </div>
              <div>
                <dt>Enabled</dt>
                <dd>{t.enabled === false ? 'No' : 'Yes'}</dd>
              </div>
              <div>
                <dt>Dynamic</dt>
                <dd>{t.dynamic ? 'Yes' : 'No'}</dd>
              </div>
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

function ModelCards({ items }: { items: ModelItem[] }) {
  return (
    <ul className="mgmt-card-list">
      {items.map((m, i) => {
        const id = m.model_id || m.id || `model-${i}`;
        return (
          <li key={id} className="mgmt-card">
            <header className="mgmt-card-head">
              <h3 className="mgmt-card-title">{id}</h3>
              <span
                className={`mgmt-status status-${m.enabled === false ? 'disabled' : 'enabled'}`}
              >
                {m.enabled === false ? 'disabled' : 'enabled'}
              </span>
            </header>
            <dl className="mgmt-meta-grid">
              <div>
                <dt>Provider</dt>
                <dd>{m.provider || '—'}</dd>
              </div>
              <div>
                <dt>Protocol</dt>
                <dd>{m.api_protocol || '—'}</dd>
              </div>
              <div>
                <dt>Context window</dt>
                <dd>{m.context_window ?? '—'}</dd>
              </div>
              <div>
                <dt>Max output</dt>
                <dd>{m.max_output_tokens ?? '—'}</dd>
              </div>
              <div>
                <dt>Tool call</dt>
                <dd>{m.supports_tool_call ? 'Yes' : m.supports_tool_call === false ? 'No' : '—'}</dd>
              </div>
              <div>
                <dt>Reasoning</dt>
                <dd>
                  {m.supports_reasoning
                    ? 'Yes'
                    : m.supports_reasoning === false
                      ? 'No'
                      : '—'}
                </dd>
              </div>
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

export function CapabilitiesPage() {
  const [tab, setTab] = useState<TabId>('skills');
  const [loading, setLoading] = useState(true);
  const [skills, setSkills] = useState<SoftListResult<SkillItem>>({
    items: [],
    available: false,
  });
  const [mcp, setMcp] = useState<SoftListResult<McpServerItem>>({
    items: [],
    available: false,
  });
  const [tools, setTools] = useState<SoftListResult<ToolRegistryItem>>({
    items: [],
    available: false,
  });
  const [models, setModels] = useState<SoftListResult<ModelItem>>({
    items: [],
    available: false,
  });
  const [diagnostics, setDiagnostics] = useState<ExtensionDiagnostics | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, m, t, mod, diag] = await Promise.all([
        listSkills(),
        listMcpServers(),
        listTools(),
        listModels(),
        getExtensionDiagnostics(),
      ]);
      setSkills(s);
      setMcp(m);
      setTools(t);
      setModels(mod);
      setDiagnostics(diag);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  let body: ReactNode = null;
  if (loading) {
    body = <div className="mgmt-empty">Loading registry…</div>;
  } else if (tab === 'skills') {
    body =
      skills.items.length === 0 ? (
        <EmptyRegistry
          label="skills"
          available={skills.available}
          error={skills.error}
        />
      ) : (
        <SkillCards items={skills.items} />
      );
  } else if (tab === 'mcp') {
    body =
      mcp.items.length === 0 ? (
        <EmptyRegistry
          label="MCP servers"
          available={mcp.available}
          error={mcp.error}
        />
      ) : (
        <McpCards items={mcp.items} />
      );
  } else if (tab === 'tools') {
    body =
      tools.items.length === 0 ? (
        <EmptyRegistry
          label="tools"
          available={tools.available}
          error={tools.error}
        />
      ) : (
        <ToolCards items={tools.items} />
      );
  } else if (tab === 'models') {
    body =
      models.items.length === 0 ? (
        <EmptyRegistry
          label="models"
          available={models.available}
          error={models.error}
        />
      ) : (
        <ModelCards items={models.items} />
      );
  } else {
    body = diagnostics ? (
      <div className="mgmt-diagnostics">
        <div className="mgmt-card">
          <h3 className="mgmt-card-title">
            {diagnostics.package.package}@{diagnostics.package.version}
          </h3>
          <dl className="mgmt-meta-grid">
            <div>
              <dt>Profile</dt>
              <dd>
                {diagnostics.profile.id}@{diagnostics.profile.version}
              </dd>
            </div>
            <div>
              <dt>View</dt>
              <dd>
                {diagnostics.view || (diagnostics.registry?.live ? 'live' : 'configured')}
              </dd>
            </div>
            <div>
              <dt>Registry version</dt>
              <dd>{diagnostics.registry?.registry_version ?? '—'}</dd>
            </div>
            <div>
              <dt>Run</dt>
              <dd>{diagnostics.registry?.run_id || '—'}</dd>
            </div>
            <div>
              <dt>Conversation</dt>
              <dd>{diagnostics.registry?.conversation_id || '—'}</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>{diagnostics.registry?.session_id || '—'}</dd>
            </div>
            <div>
              <dt>Audit</dt>
              <dd>{diagnostics.package.audit?.status || '—'}</dd>
            </div>
            <div>
              <dt>Allowed tools</dt>
              <dd>{diagnostics.profile.allowed_tools.length}</dd>
            </div>
            <div>
              <dt>Shared skills policy</dt>
              <dd>{diagnostics.profile.shared_skills?.mode || '—'}</dd>
            </div>
            <div>
              <dt>Generated</dt>
              <dd>{diagnostics.generated_at}</dd>
            </div>
          </dl>
          {!diagnostics.registry?.live && diagnostics.registry?.note ? (
            <p className="mgmt-card-reason">{diagnostics.registry.note}</p>
          ) : null}
        </div>

        <section className="mgmt-section">
          <h3 className="mgmt-section-title">Extensions</h3>
          <ul className="mgmt-card-list">
            {(diagnostics.extensions ?? []).map((ext) => (
              <li key={ext.name} className="mgmt-card">
                <header className="mgmt-card-head">
                  <h4 className="mgmt-card-title">{ext.name}</h4>
                  <span className={`mgmt-status status-${statusLabel(ext)}`}>
                    {statusLabel(ext)}
                  </span>
                </header>
                {ext.reason ? <p className="mgmt-card-reason">{ext.reason}</p> : null}
                <dl className="mgmt-meta-grid">
                  <div>
                    <dt>Source</dt>
                    <dd>{ext.source || '—'}</dd>
                  </div>
                  <div>
                    <dt>Dynamic</dt>
                    <dd>{ext.dynamic ? 'Yes' : 'No'}</dd>
                  </div>
                  {ext.registry_id ? (
                    <div>
                      <dt>Registry ID</dt>
                      <dd>
                        <code>{ext.registry_id}</code>
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </li>
            ))}
          </ul>
        </section>
      </div>
    ) : (
      <EmptyRegistry label="extension diagnostics" available={false} />
    );
  }

  return (
    <div className="mgmt-page">
      <header className="mgmt-header">
        <div>
          <h2 className="mgmt-title">Capabilities</h2>
          <p className="mgmt-subtitle">
            Skills, MCP servers, tools, and models from the enterprise registry.
            Ordinary users see available tools; admin edit requires backend
            support.
          </p>
        </div>
        <button
          type="button"
          className="mgmt-btn"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      <div className="mgmt-filters" role="tablist" aria-label="Capability sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`mgmt-chip${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {body}
    </div>
  );
}
