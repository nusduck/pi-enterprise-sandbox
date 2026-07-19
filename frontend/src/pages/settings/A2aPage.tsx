import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  getA2aConfig,
  issueA2aCredential,
  revokeA2aCredential,
  rotateA2aCredential,
  type A2aConfig,
} from '../../shared/api/a2a';

const SCOPES = [
  'agent.invoke',
  'agent.read',
  'agent.cancel',
  'artifact.read',
] as const;

function value(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    if (row[key] != null) return String(row[key]);
  }
  return '—';
}

export function A2aPage() {
  const [config, setConfig] = useState<A2aConfig | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [clientId, setClientId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [scopes, setScopes] = useState<string[]>([...SCOPES]);
  const [oneTimeToken, setOneTimeToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);

  const refresh = useCallback(async (agentId?: string | null) => {
    setLoading(true);
    setError('');
    try {
      const next = await getA2aConfig(agentId);
      setConfig(next);
      setSelectedAgentId(next.selectedAgentId || next.agents[0]?.agentId || '');
    } catch (err) {
      setError((err as Error).message || 'Failed to load A2A configuration');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedAgent = useMemo(
    () => config?.agents.find((agent) => agent.agentId === selectedAgentId),
    [config, selectedAgentId],
  );

  async function issue(event: FormEvent) {
    event.preventDefault();
    if (!selectedAgentId || !clientId.trim()) return;
    setMutating(true);
    setError('');
    setOneTimeToken('');
    try {
      const result = await issueA2aCredential({
        agentId: selectedAgentId,
        clientId: clientId.trim(),
        scopes,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      });
      setOneTimeToken(result.token || result.bearerToken || '');
      setClientId('');
      await refresh(selectedAgentId);
    } catch (err) {
      setError((err as Error).message || 'Credential issue failed');
    } finally {
      setMutating(false);
    }
  }

  async function rotate(credentialId: string) {
    setMutating(true);
    setError('');
    setOneTimeToken('');
    try {
      const result = await rotateA2aCredential(credentialId);
      setOneTimeToken(result.token || result.bearerToken || '');
      await refresh(selectedAgentId);
    } catch (err) {
      setError((err as Error).message || 'Credential rotation failed');
    } finally {
      setMutating(false);
    }
  }

  async function revoke(credentialId: string) {
    if (!window.confirm('Revoke this A2A credential? Existing clients will stop working.')) {
      return;
    }
    setMutating(true);
    setError('');
    try {
      await revokeA2aCredential(credentialId);
      await refresh(selectedAgentId);
    } catch (err) {
      setError((err as Error).message || 'Credential revoke failed');
    } finally {
      setMutating(false);
    }
  }

  const example = selectedAgent?.endpoint
    ? `curl '${selectedAgent.endpoint}' \\\n  -H 'Authorization: Bearer <credential>' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: example-001' \\\n  --data '{"jsonrpc":"2.0","id":"1","method":"SendMessage","params":{"message":{"messageId":"example-001","parts":[{"kind":"text","text":"Analyze the latest report"}]}}}'`
    : 'A2A endpoint is not configured.';

  return (
    <div className="mgmt-page">
      <header className="mgmt-header">
        <div>
          <h2 className="mgmt-title">A2A access</h2>
          <p className="mgmt-subtitle">
            Agent endpoints, scoped API credentials, recent tasks, and caller audit.
          </p>
        </div>
        <button
          type="button"
          className="mgmt-btn secondary"
          onClick={() => void refresh(selectedAgentId)}
          disabled={loading}
        >
          Refresh
        </button>
      </header>

      {error ? <p className="mgmt-error">{error}</p> : null}
      {loading ? <div className="mgmt-empty">Loading A2A configuration…</div> : null}

      {!loading && config ? (
        <>
          <section className="mgmt-section">
            <div className="mgmt-field-row">
              <label className="mgmt-field">
                <span>Agent</span>
                <select
                  value={selectedAgentId}
                  onChange={(event) => {
                    const id = event.target.value;
                    setSelectedAgentId(id);
                    void refresh(id);
                  }}
                >
                  {config.agents.map((agent) => (
                    <option key={agent.agentId} value={agent.agentId}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {selectedAgent ? (
              <dl className="mgmt-meta-grid mgmt-a2a-summary">
                <div><dt>Agent ID</dt><dd><code>{selectedAgent.agentId}</code></dd></div>
                <div><dt>Agent version</dt><dd><code>{selectedAgent.activeVersionId || '—'}</code></dd></div>
                <div><dt>Streaming</dt><dd>{config.streaming ? 'Enabled' : 'Disabled'}</dd></div>
                <div><dt>Authentication</dt><dd>{config.authentication}</dd></div>
                <div><dt>Agent Card</dt><dd>{selectedAgent.agentCardUrl || '—'}</dd></div>
                <div><dt>Endpoint</dt><dd>{selectedAgent.endpoint || '—'}</dd></div>
              </dl>
            ) : (
              <div className="mgmt-empty">No Agent has been provisioned for this organization.</div>
            )}
          </section>

          <section className="mgmt-section">
            <h3 className="mgmt-section-title">Issue credential</h3>
            <form className="mgmt-form" onSubmit={issue}>
              <label className="mgmt-field">
                <span>Client ID</span>
                <input
                  value={clientId}
                  maxLength={128}
                  onChange={(event) => setClientId(event.target.value)}
                  placeholder="reporting-service"
                  required
                />
              </label>
              <label className="mgmt-field">
                <span>Expires at</span>
                <input
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                />
              </label>
              <fieldset className="mgmt-scope-field">
                <legend>Scopes</legend>
                {SCOPES.map((scope) => (
                  <label key={scope}>
                    <input
                      type="checkbox"
                      checked={scopes.includes(scope)}
                      onChange={(event) =>
                        setScopes((current) =>
                          event.target.checked
                            ? [...current, scope]
                            : current.filter((item) => item !== scope),
                        )
                      }
                    />
                    <span>{scope}</span>
                  </label>
                ))}
              </fieldset>
              <button
                type="submit"
                className="mgmt-btn"
                disabled={mutating || !selectedAgentId || !clientId.trim()}
              >
                Issue credential
              </button>
            </form>
            {oneTimeToken ? (
              <div className="mgmt-secret" role="status">
                <strong>One-time credential</strong>
                <code>{oneTimeToken}</code>
                <p>This value cannot be retrieved again. Rotate it if it is lost.</p>
              </div>
            ) : null}
          </section>

          <section className="mgmt-section">
            <h3 className="mgmt-section-title">Credentials</h3>
            {config.credentials.length ? (
              <div className="mgmt-table-wrap">
                <table className="mgmt-table">
                  <thead><tr><th>Client</th><th>Key</th><th>Scopes</th><th>Status</th><th>Last used</th><th>Actions</th></tr></thead>
                  <tbody>
                    {config.credentials.map((credential) => (
                      <tr key={credential.credentialId}>
                        <td>{credential.clientId}</td>
                        <td><code>{credential.keyId}</code></td>
                        <td>{credential.scopes.join(', ')}</td>
                        <td><span className={`mgmt-status status-${credential.status}`}>{credential.status}</span></td>
                        <td>{credential.lastUsedAt || 'Never'}</td>
                        <td><div className="mgmt-row-actions">
                          <button type="button" className="mgmt-btn secondary sm" disabled={mutating || credential.status !== 'active'} onClick={() => void rotate(credential.credentialId)}>Rotate</button>
                          <button type="button" className="mgmt-btn danger sm" disabled={mutating || credential.status === 'revoked'} onClick={() => void revoke(credential.credentialId)}>Revoke</button>
                        </div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="mgmt-empty">No credentials issued for this Agent.</div>}
          </section>

          <section className="mgmt-section">
            <h3 className="mgmt-section-title">Example request</h3>
            <pre className="mgmt-cmd">{example}</pre>
          </section>

          <section className="mgmt-section">
            <h3 className="mgmt-section-title">Recent tasks</h3>
            <div className="mgmt-table-wrap">
              <table className="mgmt-table">
                <thead><tr><th>Task</th><th>Client</th><th>Run</th><th>Trace</th><th>Created</th></tr></thead>
                <tbody>{config.recentTasks.map((task) => (
                  <tr key={value(task, 'a2aTaskId', 'a2a_task_id')}>
                    <td><code>{value(task, 'a2aTaskId', 'a2a_task_id')}</code></td>
                    <td>{value(task, 'clientId', 'client_id')}</td>
                    <td><code>{value(task, 'runId', 'run_id')}</code></td>
                    <td><code>{value(task, 'traceId', 'trace_id')}</code></td>
                    <td>{value(task, 'createdAt', 'created_at')}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>

          <section className="mgmt-section">
            <h3 className="mgmt-section-title">Caller audit</h3>
            <div className="mgmt-table-wrap">
              <table className="mgmt-table">
                <thead><tr><th>Event</th><th>Client</th><th>Method</th><th>Trace</th><th>Created</th></tr></thead>
                <tbody>{config.audit.map((entry) => (
                  <tr key={value(entry, 'auditId', 'audit_id')}>
                    <td>{value(entry, 'eventType', 'event_type')}</td>
                    <td>{value(entry, 'clientId', 'client_id')}</td>
                    <td>{value(entry, 'method')}</td>
                    <td><code>{value(entry, 'traceId', 'trace_id')}</code></td>
                    <td>{value(entry, 'createdAt', 'created_at')}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
