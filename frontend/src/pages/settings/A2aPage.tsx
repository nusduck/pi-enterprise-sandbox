import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  getA2aConfig,
  issueA2aCredential,
  revokeA2aCredential,
  rotateA2aCredential,
  type A2aConfig,
} from '../../shared/api/a2a';
import {
  IconRefresh,
  IconSparkles,
  IconCopy,
  IconCheck,
} from '../../shared/ui/Icons';

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
  const [copiedToken, setCopiedToken] = useState(false);
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
      setOneTimeToken(result.token || '');
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
      setOneTimeToken(result.token || '');
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

  async function handleCopyToken() {
    if (!oneTimeToken) return;
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard not supported');
      }
      await navigator.clipboard.writeText(oneTimeToken);
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 1500);
    } catch {
      setCopiedToken(false);
      setError('Failed to copy token to clipboard. Please copy it manually.');
    }
  }

  const example = selectedAgent?.endpoint
    ? `curl '${selectedAgent.endpoint}' \\\n  -H 'Authorization: Bearer <credential>' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: example-001' \\\n  --data '{"jsonrpc":"2.0","id":"1","method":"SendMessage","params":{"message":{"messageId":"example-001","parts":[{"kind":"text","text":"Analyze the latest report"}]}}}'`
    : 'A2A endpoint is not configured.';

  return (
    <div className="mgmt-page">
      <header className="mgmt-header">
        <div>
          <h2 className="mgmt-title">A2A Access</h2>
          <p className="mgmt-subtitle">
            Agent-to-Agent endpoints, scoped API credentials, caller audit, and inter-agent communication.
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
      {loading ? <div className="mgmt-empty"><IconSparkles size={24} className="icon-pulse" /><p>Loading A2A configuration…</p></div> : null}

      {!loading && config ? (
        <>
          <section className="mgmt-section">
            <div className="mgmt-field-row">
              <label className="mgmt-field">
                <span>Select Agent</span>
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
                <div><dt>Agent Version</dt><dd><code>{selectedAgent.activeVersionId || '—'}</code></dd></div>
                <div><dt>Streaming</dt><dd>{config.streaming ? 'Enabled' : 'Disabled'}</dd></div>
                <div><dt>Authentication</dt><dd>{config.authentication}</dd></div>
                <div><dt>Agent Card</dt><dd>{selectedAgent.agentCardUrl || '—'}</dd></div>
                <div><dt>Endpoint</dt><dd>{selectedAgent.endpoint || '—'}</dd></div>
              </dl>
            ) : (
              <div className="mgmt-empty">No Agent provisioned for this organization.</div>
            )}
          </section>

          <section className="mgmt-section">
            <h3 className="mgmt-section-title">Issue Scoped Credential</h3>
            <form className="mgmt-form" onSubmit={issue}>
              <div className="mgmt-field-row">
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
                  <span>Expires At (Optional)</span>
                  <input
                    type="datetime-local"
                    value={expiresAt}
                    onChange={(event) => setExpiresAt(event.target.value)}
                  />
                </label>
              </div>
              <fieldset className="mgmt-scope-field">
                <legend>Permissions / Scopes</legend>
                <div className="mgmt-scopes-grid">
                  {SCOPES.map((scope) => (
                    <label key={scope} className="mgmt-scope-checkbox-label">
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
                </div>
              </fieldset>
              <div className="mgmt-form-actions">
                <button
                  type="submit"
                  className="mgmt-btn"
                  disabled={mutating || !selectedAgentId || !clientId.trim()}
                >
                  Issue Credential
                </button>
              </div>
            </form>
            {oneTimeToken ? (
              <div className="mgmt-secret" role="status">
                <div className="mgmt-secret-head">
                  <strong>One-Time Bearer Credential</strong>
                  <button
                    type="button"
                    className="mgmt-secret-copy"
                    onClick={handleCopyToken}
                  >
                    {copiedToken ? <IconCheck size={13} /> : <IconCopy size={13} />}
                    <span>{copiedToken ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
                <code className="mgmt-secret-token">{oneTimeToken}</code>
                <p>This secret cannot be viewed again. Please copy and store it securely.</p>
              </div>
            ) : null}
          </section>

          <section className="mgmt-section">
            <h3 className="mgmt-section-title">Active Credentials</h3>
            {config.credentials.length ? (
              <div className="mgmt-table-wrap">
                <table className="mgmt-table">
                  <thead><tr><th>Client</th><th>Key ID</th><th>Scopes</th><th>Status</th><th>Last Used</th><th>Actions</th></tr></thead>
                  <tbody>
                    {config.credentials.map((credential) => (
                      <tr key={credential.credentialId}>
                        <td><strong>{credential.clientId}</strong></td>
                        <td><code className="mgmt-id-code">{credential.keyId}</code></td>
                        <td><span className="mgmt-scope-tags">{credential.scopes.join(', ')}</span></td>
                        <td><span className={`mgmt-status status-${credential.status}`}><span className="mgmt-status-dot" />{credential.status}</span></td>
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
            <h3 className="mgmt-section-title">Example JSON-RPC Request</h3>
            <pre className="mgmt-cmd">{example}</pre>
          </section>

          <section className="mgmt-section">
            <h3 className="mgmt-section-title">Recent Inter-Agent Tasks</h3>
            <div className="mgmt-table-wrap">
              <table className="mgmt-table">
                <thead><tr><th>Task ID</th><th>Client</th><th>Run ID</th><th>Trace ID</th><th>Created At</th></tr></thead>
                <tbody>{config.recentTasks.map((task) => (
                  <tr key={value(task, 'a2aTaskId', 'a2a_task_id')}>
                    <td><code className="mgmt-id-code">{value(task, 'a2aTaskId', 'a2a_task_id')}</code></td>
                    <td>{value(task, 'clientId', 'client_id')}</td>
                    <td><code className="mgmt-id-code">{value(task, 'runId', 'run_id')}</code></td>
                    <td><code className="mgmt-id-code">{value(task, 'traceId', 'trace_id')}</code></td>
                    <td>{value(task, 'createdAt', 'created_at')}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>

          <section className="mgmt-section">
            <h3 className="mgmt-section-title">Caller Audit Log</h3>
            <div className="mgmt-table-wrap">
              <table className="mgmt-table">
                <thead><tr><th>Event</th><th>Client</th><th>Method</th><th>Trace ID</th><th>Timestamp</th></tr></thead>
                <tbody>{config.audit.map((entry) => (
                  <tr key={value(entry, 'auditId', 'audit_id')}>
                    <td><span className="mgmt-audit-event">{value(entry, 'eventType', 'event_type')}</span></td>
                    <td>{value(entry, 'clientId', 'client_id')}</td>
                    <td><code>{value(entry, 'method')}</code></td>
                    <td><code className="mgmt-id-code">{value(entry, 'traceId', 'trace_id')}</code></td>
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
