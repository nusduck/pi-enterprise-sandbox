import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  getA2aConfig,
  issueA2aCredential,
  revokeA2aCredential,
  rotateA2aCredential,
  type A2aConfig,
} from '../../shared/api/a2a';
import a from './adminPage.module.css';
import s from './a2a.module.css';

type Tab = 'credentials' | 'tasks' | 'audit' | 'example';

const SCOPE_ZH: Record<string, string> = {
  'agent.invoke': '调用',
  'agent.read': '读取任务',
  'agent.cancel': '取消任务',
  'artifact.read': '读取产物',
};

const CREDENTIAL_STATUS: Record<string, [string, string]> = {
  active: ['有效', a.ok],
  revoked: ['已吊销', a.mute],
  expired: ['已过期', a.mute],
  rotated: ['已轮换', a.mute],
};

function formatTime(raw: string | null | undefined): string {
  if (!raw || raw === '—') return '—';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString('zh-CN', { hour12: false });
}

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
  const [tab, setTab] = useState<Tab>('credentials');
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const refresh = useCallback(async (agentId?: string | null) => {
    setLoading(true);
    setError('');
    try {
      const next = await getA2aConfig(agentId);
      setConfig(next);
      setSelectedAgentId(next.selectedAgentId || next.agents[0]?.agentId || '');
    } catch (err) {
      setError((err as Error).message || '读取 A2A 配置失败');
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
      setError((err as Error).message || '签发凭据失败');
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
      setError((err as Error).message || '轮换凭据失败');
    } finally {
      setMutating(false);
    }
  }

  async function revoke(credentialId: string) {
    // Second click confirms: existing clients stop working immediately.
    if (confirmRevoke !== credentialId) {
      setConfirmRevoke(credentialId);
      return;
    }
    setConfirmRevoke(null);
    setMutating(true);
    setError('');
    try {
      await revokeA2aCredential(credentialId);
      await refresh(selectedAgentId);
    } catch (err) {
      setError((err as Error).message || '吊销凭据失败');
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
      setError('复制失败，请手动选中复制。');
    }
  }

  const example = selectedAgent?.endpoint
    ? `curl '${selectedAgent.endpoint}' \\\n  -H 'Authorization: Bearer <credential>' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: example-001' \\\n  --data '{"jsonrpc":"2.0","id":"1","method":"SendMessage","params":{"message":{"messageId":"example-001","parts":[{"kind":"text","text":"Analyze the latest report"}]}}}'`
    : '未配置 A2A 端点。';

  return (
    <div className={a.page}>
      <div className={a.head}>
        <div>
          <h1>A2A 接入</h1>
          <p>让外部系统以 A2A 协议调用本部署的智能体：按智能体签发带范围的凭据，查看调用记录与审计。</p>
        </div>
        <span className={a.sp} />
        {config?.agents.length ? (
          <select
            className={s.select}
            aria-label="选择智能体"
            value={selectedAgentId}
            onChange={(event) => {
              const id = event.target.value;
              setSelectedAgentId(id);
              void refresh(id);
            }}
          >
            {config.agents.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.name}</option>)}
          </select>
        ) : null}
        <button type="button" className={a.btn} onClick={() => void refresh(selectedAgentId)} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {error ? <p className={s.error} role="alert">{error}</p> : null}
      {loading && !config ? <div className={a.empty}>正在读取…</div> : null}

      {config ? (
        <>
          {selectedAgent ? (
            <dl className={s.summary}>
              <div><dt>端点</dt><dd className={a.mono}>{selectedAgent.endpoint || '—'}</dd></div>
              <div><dt>Agent Card</dt><dd className={a.mono}>{selectedAgent.agentCardUrl || '—'}</dd></div>
              <div><dt>认证</dt><dd>{config.authentication}</dd></div>
              <div><dt>流式</dt><dd>{config.streaming ? '支持' : '不支持'}</dd></div>
              <div><dt>智能体 ID</dt><dd className={a.mono}>{selectedAgent.agentId}</dd></div>
              <div><dt>启用版本</dt><dd className={a.mono}>{selectedAgent.activeVersionId || '—'}</dd></div>
            </dl>
          ) : <div className={a.empty}>这个组织还没有智能体。</div>}

          <div className={a.tabs} role="tablist" aria-label="A2A">
            {([
              ['credentials', '凭据', config.credentials.length],
              ['tasks', '调用记录', config.recentTasks.length],
              ['audit', '审计', config.audit.length],
              ['example', '接入示例', null],
            ] as Array<[Tab, string, number | null]>).map(([id, label, count]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
                {label}{count != null ? <small>{count}</small> : null}
              </button>
            ))}
          </div>

          {tab === 'credentials' ? (
            <>
              <form className={s.issue} onSubmit={issue}>
                <label className={s.field}>
                  <span>调用方（Client ID）</span>
                  <input value={clientId} maxLength={128} onChange={(event) => setClientId(event.target.value)} placeholder="reporting-service" required />
                </label>
                <label className={s.field}>
                  <span>过期时间（可选）</span>
                  <input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
                </label>
                <fieldset className={s.scopes}>
                  <legend>权限范围</legend>
                  {SCOPES.map((scope) => (
                    <label key={scope} title={scope}>
                      <input
                        type="checkbox"
                        checked={scopes.includes(scope)}
                        onChange={(event) => setScopes((current) => event.target.checked ? [...current, scope] : current.filter((item) => item !== scope))}
                      />
                      {SCOPE_ZH[scope] || scope}
                    </label>
                  ))}
                </fieldset>
                <button type="submit" className={a.btnPri} disabled={mutating || !selectedAgentId || !clientId.trim()}>签发凭据</button>
              </form>

              {oneTimeToken ? (
                <div className={s.secret} role="status">
                  <div className={s.secretHead}>
                    <b>一次性凭据</b>
                    <span className={a.sp} />
                    <button type="button" className={a.btn} onClick={handleCopyToken}>{copiedToken ? '已复制' : '复制'}</button>
                  </div>
                  <code>{oneTimeToken}</code>
                  <small>离开或刷新后无法再次查看，请立即妥善保存。</small>
                </div>
              ) : null}

              <div className={a.tableWrap}>
                {config.credentials.length ? (
                  <table className={a.table}>
                    <thead><tr><th>调用方</th><th>Key ID</th><th>权限</th><th>状态</th><th>最近使用</th><th aria-label="操作" /></tr></thead>
                    <tbody>
                      {config.credentials.map((credential) => {
                        const [label, cls] = CREDENTIAL_STATUS[credential.status] || [credential.status, a.mute];
                        return (
                          <tr key={credential.credentialId}>
                            <td><b>{credential.clientId}</b></td>
                            <td className={a.mono}>{credential.keyId}</td>
                            <td><span className={a.tags}>{credential.scopes.map((sc) => <span key={sc} className={`${a.pill} ${a.mute}`} title={sc}>{SCOPE_ZH[sc] || sc}</span>)}</span></td>
                            <td><span className={`${a.pill} ${cls}`}>{label}</span></td>
                            <td className={a.num}>{credential.lastUsedAt ? formatTime(credential.lastUsedAt) : '从未'}</td>
                            <td className={a.right}>
                              <span className={s.actions}>
                                <button type="button" className={s.link} disabled={mutating || credential.status !== 'active'} onClick={() => void rotate(credential.credentialId)}>轮换</button>
                                <button type="button" className={`${s.link} ${s.danger}`} disabled={mutating || credential.status === 'revoked'} onClick={() => void revoke(credential.credentialId)}>
                                  {confirmRevoke === credential.credentialId ? '确认吊销' : '吊销'}
                                </button>
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : <div className={a.empty}>还没有为这个智能体签发凭据。</div>}
              </div>
            </>
          ) : null}

          {tab === 'tasks' ? (
            <div className={a.tableWrap}>
              {config.recentTasks.length ? (
                <table className={a.table}>
                  <thead><tr><th>时间</th><th>调用方</th><th>任务 ID</th><th>运行</th><th>Trace</th></tr></thead>
                  <tbody>{config.recentTasks.map((task) => (
                    <tr key={value(task, 'a2aTaskId', 'a2a_task_id')}>
                      <td className={a.num}>{formatTime(value(task, 'createdAt', 'created_at'))}</td>
                      <td>{value(task, 'clientId', 'client_id')}</td>
                      <td className={a.mono}>{value(task, 'a2aTaskId', 'a2a_task_id')}</td>
                      <td className={a.mono}>{value(task, 'runId', 'run_id')}</td>
                      <td className={a.mono}>{value(task, 'traceId', 'trace_id')}</td>
                    </tr>
                  ))}</tbody>
                </table>
              ) : <div className={a.empty}>还没有外部调用。</div>}
            </div>
          ) : null}

          {tab === 'audit' ? (
            <div className={a.tableWrap}>
              {config.audit.length ? (
                <table className={a.table}>
                  <thead><tr><th>时间</th><th>事件</th><th>调用方</th><th>方法</th><th>Trace</th></tr></thead>
                  <tbody>{config.audit.map((entry) => (
                    <tr key={value(entry, 'auditId', 'audit_id')}>
                      <td className={a.num}>{formatTime(value(entry, 'createdAt', 'created_at'))}</td>
                      <td><span className={`${a.pill} ${a.mute}`}>{value(entry, 'eventType', 'event_type')}</span></td>
                      <td>{value(entry, 'clientId', 'client_id')}</td>
                      <td className={a.mono}>{value(entry, 'method')}</td>
                      <td className={a.mono}>{value(entry, 'traceId', 'trace_id')}</td>
                    </tr>
                  ))}</tbody>
                </table>
              ) : <div className={a.empty}>还没有审计记录。</div>}
            </div>
          ) : null}

          {tab === 'example' ? (
            <>
              <p className={a.muted} style={{ margin: 0, fontSize: 13 }}>用签发的凭据替换 <code>&lt;credential&gt;</code>，以 JSON-RPC 发送一条消息：</p>
              <pre className={s.code}>{example}</pre>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
