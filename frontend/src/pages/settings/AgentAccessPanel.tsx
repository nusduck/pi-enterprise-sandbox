import { useEffect, useRef, useState } from 'react';
import { getAgentAccess, setAgentAccess, type AgentAccess } from '../../shared/api/agents';
import { listAdminMembers } from '../../shared/api/adminMembers';
import {
  accessDraftChanged,
  accessErrorMessage,
  accessPayload,
  addGrant,
  draftFromAccess,
  memberLabel,
  removeGrant,
  type AccessDraft,
  type AccessGrant,
} from './agentAccessHelpers';
import s from './agents.module.css';

const SEARCH_DEBOUNCE_MS = 250;

/**
 * 智能体「可见范围」（design docs/design/agent-visibility.md §6）。
 *
 * 与配置版本无关：保存即生效，不生成新版本，也不影响「保存为新版本」的草稿。
 * - 加载失败显示错误与重试，**不**当成「全员可见」；
 * - 保存失败保留草稿与名单；切换智能体时丢弃迟到的响应；
 * - 选人复用成员页的搜索（按工号/姓名），只列本组织活跃成员。
 * 授权判定在服务端：这里禁用的选项（默认智能体不能受限）只是提示，不是闸门。
 */
export function AgentAccessPanel({
  agentId,
  isDefault,
  onSaved,
}: {
  agentId: string;
  isDefault: boolean;
  onSaved?: (access: AgentAccess) => void;
}) {
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [saved, setSaved] = useState<AccessDraft | null>(null);
  const [draft, setDraft] = useState<AccessDraft>({ visibility: 'org', grants: [] });
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AccessGrant[]>([]);
  const [searchError, setSearchError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const agentRef = useRef(agentId);
  agentRef.current = agentId;

  useEffect(() => {
    let alive = true;
    setStatus('loading');
    setError('');
    setNotice('');
    getAgentAccess(agentId)
      .then((access) => {
        if (!alive) return;
        const next = draftFromAccess(access);
        setSaved(next);
        setDraft(next);
        setStatus('ready');
      })
      .catch((err) => {
        if (!alive) return;
        setLoadError(accessErrorMessage(err));
        setStatus('error');
      });
    return () => { alive = false; };
  }, [agentId, reloadKey]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearchError('');
      return undefined;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      listAdminMembers({ q, limit: 20 })
        .then((page) => {
          if (!alive) return;
          setResults(page.members.map((m) => ({ user_id: m.user_id, username: m.username ?? null, display_name: m.display_name ?? null })));
          setSearchError('');
        })
        .catch((err) => {
          if (!alive) return;
          setResults([]);
          setSearchError(accessErrorMessage(err));
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [query]);

  async function save() {
    const target = agentId;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const access = await setAgentAccess(target, accessPayload(draft));
      if (agentRef.current !== target) return;
      const next = draftFromAccess(access);
      setSaved(next);
      setDraft(next);
      setNotice(next.visibility === 'org' ? '已保存：本组织全员可用。' : `已保存：仅 ${next.grants.length} 名成员与管理员可用。`);
      onSaved?.(access);
    } catch (err) {
      if (agentRef.current !== target) return;
      // 草稿与名单原样保留，修正后可直接再保存。
      setError(accessErrorMessage(err));
    } finally {
      if (agentRef.current === target) setSaving(false);
    }
  }

  if (status === 'loading') return <p className={s.hint}>正在读取可见范围…</p>;
  if (status === 'error') {
    return (
      <div className={s.accessBox}>
        <p className={s.errBox} role="alert">{loadError}</p>
        <div><button type="button" className={s.btn} onClick={() => setReloadKey((k) => k + 1)}>重试</button></div>
      </div>
    );
  }

  const changed = accessDraftChanged(saved, draft);
  const restricted = draft.visibility === 'restricted';
  const granted = new Set(draft.grants.map((g) => g.user_id));

  return (
    <div className={s.accessBox}>
      <p className={s.hint}>
        决定哪些员工能在智能体选择器里看到并使用它。保存即生效，不生成新版本；管理员始终可用。
        撤销某人后，他已有的相关会话下一轮会被拒绝。
      </p>
      <fieldset className={s.accessChoices} disabled={saving}>
        <legend className={s.visuallyHidden}>可见范围</legend>
        <label>
          <input
            type="radio"
            name={`visibility-${agentId}`}
            checked={draft.visibility === 'org'}
            onChange={() => setDraft({ ...draft, visibility: 'org' })}
          />
          <span><b>全员可用</b><small>本组织所有成员</small></span>
        </label>
        <label>
          <input
            type="radio"
            name={`visibility-${agentId}`}
            checked={restricted}
            disabled={isDefault}
            onChange={() => setDraft({ ...draft, visibility: 'restricted' })}
          />
          <span>
            <b>指定员工</b>
            <small>{isDefault ? '默认智能体必须对全员可见' : '只有名单里的员工与管理员可用'}</small>
          </span>
        </label>
      </fieldset>

      {restricted ? (
        <div className={s.accessMembers}>
          <label className={s.field}>
            <span>添加员工</span>
            <input
              type="search"
              value={query}
              placeholder="输入工号或姓名搜索"
              onChange={(event) => setQuery(event.target.value)}
              disabled={saving}
            />
          </label>
          {searchError ? <p className={s.errBox} role="alert">{searchError}</p> : null}
          {results.length ? (
            <ul className={s.accessList} aria-label="搜索结果">
              {results.map((member) => (
                <li key={member.user_id}>
                  <span>{memberLabel(member)}</span>
                  <button
                    type="button"
                    className={s.btnSm}
                    disabled={saving || granted.has(member.user_id)}
                    onClick={() => setDraft(addGrant(draft, member))}
                  >
                    {granted.has(member.user_id) ? '已添加' : '添加'}
                  </button>
                </li>
              ))}
            </ul>
          ) : query.trim() && !searchError ? <p className={s.hint}>没有匹配的成员。</p> : null}

          <b className={s.accessCount}>已授权 {draft.grants.length} 人</b>
          {draft.grants.length ? (
            <ul className={s.accessList} aria-label="已授权员工">
              {draft.grants.map((member) => (
                <li key={member.user_id}>
                  <span>{memberLabel(member)}</span>
                  <button type="button" className={s.btnSm} disabled={saving} onClick={() => setDraft(removeGrant(draft, member.user_id))}>
                    移除
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={s.hint}>名单为空时，只有管理员能用这个智能体。</p>
          )}
        </div>
      ) : null}

      {error ? <p className={s.errBox} role="alert">{error}</p> : null}
      {notice ? <p className={s.okBox} role="status">{notice}</p> : null}
      <div className={s.accessActions}>
        <button type="button" className={s.btn} disabled={saving || !changed} onClick={() => { if (saved) setDraft(saved); setError(''); }}>
          放弃修改
        </button>
        <button type="button" className={s.btnPri} disabled={saving || !changed} onClick={() => void save()}>
          {saving ? '保存中…' : '保存可见范围'}
        </button>
      </div>
    </div>
  );
}
