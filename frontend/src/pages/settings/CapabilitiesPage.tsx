import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  listMcpServers,
  listModels,
  listSkills,
  listTools,
  type McpServerItem,
  type ModelItem,
  type SkillItem,
  type SoftListResult,
  type ToolRegistryItem,
} from '../../shared/api/capabilities';
import { mcpStatus, toolStatus } from './capabilityFormat';
import s from './adminPage.module.css';

type Tab = 'skills' | 'mcp' | 'tools' | 'models';

const EMPTY: SoftListResult<never> = { items: [], available: true };

const STATUS_ZH: Record<string, [string, string]> = {
  connected: ['已连接', s.ok],
  configured: ['已配置', s.ok],
  enabled: ['可用', s.ok],
  ready: ['可用', s.ok],
  disabled: ['已停用', s.mute],
  error: ['异常', s.err],
  failed: ['异常', s.err],
  disconnected: ['未连接', s.warn],
};

function Status({ value }: { value: string }) {
  const [label, cls] = STATUS_ZH[value.toLowerCase()] || [value, s.mute];
  return <span className={`${s.pill} ${cls}`}>{label}</span>;
}

function skillSource(item: SkillItem): [string, string] {
  if (item.source === 'user-skill-root') return ['用户', s.info];
  if (item.source === 'draft-skill-root') return ['草稿', s.mute];
  return ['系统', s.mute];
}

const RISK_ZH: Record<string, [string, string]> = {
  low: ['低', s.ok],
  medium: ['中', s.warn],
  high: ['高', s.err],
  critical: ['极高', s.err],
};

const APPROVAL_ZH: Record<string, string> = {
  allow: '直接执行',
  auto: '直接执行',
  require_approval: '需要审批',
  deny: '禁止',
};

function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

function Unavailable({ result, noun, loading }: { result: SoftListResult<unknown>; noun: string; loading: boolean }) {
  const text = loading
    ? '正在读取…'
    : result.available === false
      ? `${noun}目录接口暂不可用。`
      : result.error
        ? `读取${noun}失败：${result.error}`
        : `当前部署没有${noun}。`;
  return <div className={s.empty}>{text}</div>;
}

function matches(query: string, ...fields: Array<string | null | undefined>): boolean {
  const q = query.trim().toLowerCase();
  return !q || fields.some((f) => String(f || '').toLowerCase().includes(q));
}

/**
 * Deployment capabilities, read-only: Skills, MCP servers, tools and models.
 * A user's own Skills are managed in the settings dialog; which of these an
 * agent may use is configured per agent version.
 */
export function CapabilitiesPage() {
  const [tab, setTab] = useState<Tab>('skills');
  const [query, setQuery] = useState('');
  const [skillScope, setSkillScope] = useState<'all' | 'system' | 'user'>('all');
  const [skills, setSkills] = useState<SoftListResult<SkillItem>>(EMPTY);
  const [mcp, setMcp] = useState<SoftListResult<McpServerItem>>(EMPTY);
  const [tools, setTools] = useState<SoftListResult<ToolRegistryItem>>(EMPTY);
  const [models, setModels] = useState<SoftListResult<ModelItem>>(EMPTY);

  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [sk, m, t, mod] = await Promise.all([listSkills(), listMcpServers(), listTools(), listModels()]);
      setSkills(sk);
      setMcp(m);
      setTools(t);
      setModels(mod);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const skillRows = useMemo(
    () =>
      skills.items.filter((item) => {
        const src = item.source === 'user-skill-root' || item.source === 'draft-skill-root' ? 'user' : 'system';
        return (skillScope === 'all' || skillScope === src) && matches(query, item.name, item.description);
      }),
    [skills.items, skillScope, query],
  );

  const tabs: Array<[Tab, string, number]> = [
    ['skills', 'Skills', skills.items.length],
    ['mcp', 'MCP 服务', mcp.items.length],
    ['tools', '工具', tools.items.length],
    ['models', '模型', models.items.length],
  ];

  let body: ReactNode;
  if (tab === 'skills') {
    body = skills.items.length === 0 ? <Unavailable result={skills} noun=" Skill " loading={loading} /> : (
      <table className={s.table}>
        <thead><tr><th>名称</th><th>说明</th><th>来源</th><th>状态</th></tr></thead>
        <tbody>
          {skillRows.map((item, i) => {
            const [label, cls] = skillSource(item);
            return (
              <tr key={`${item.source}-${item.name || i}`}>
                <td className={s.mono}>{item.name || item.id || '—'}</td>
                <td className={s.desc}><span className={s.clamp}>{item.description || '—'}</span></td>
                <td><span className={`${s.pill} ${cls}`}>{label}</span></td>
                <td>
                  {item.source === 'draft-skill-root'
                    ? <span className={`${s.pill} ${s.mute}`}>{item.published ? '已发布' : '草稿'}</span>
                    : <span className={`${s.pill} ${item.enabled === false ? s.mute : s.ok}`}>{item.enabled === false ? '已停用' : '可用'}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  } else if (tab === 'mcp') {
    body = mcp.items.length === 0 ? <Unavailable result={mcp} noun=" MCP 服务" loading={loading} /> : (
      <table className={s.table}>
        <thead><tr><th>服务</th><th>状态</th><th className={s.right}>工具数</th><th>授权方式</th><th>最近刷新</th></tr></thead>
        <tbody>
          {mcp.items.filter((m) => matches(query, m.name, m.server_id, m.id)).map((m, i) => {
            const id = m.server_id || m.id || m.name || `mcp-${i}`;
            const count = m.tools_count ?? m.tool_count ?? null;
            return (
              <tr key={id}>
                <td><b>{m.name || id}</b>{m.name && m.name !== id ? <div className={`${s.mono} ${s.muted}`}>{id}</div> : null}</td>
                <td><Status value={mcpStatus(m)} /></td>
                <td className={`${s.right} ${s.num}`}>{count ?? '—'}</td>
                <td>{m.authorization || '—'}</td>
                <td className={s.num}>{m.last_refresh || m.last_refreshed_at || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  } else if (tab === 'tools') {
    // The registry often carries no descriptions; an all-dash column is noise.
    const described = tools.items.some((t) => t.description);
    body = tools.items.length === 0 ? <Unavailable result={tools} noun="工具" loading={loading} /> : (
      <table className={s.table}>
        <thead><tr><th>工具</th>{described ? <th>说明</th> : null}<th>类别</th><th>风险</th><th>默认审批</th><th>状态</th></tr></thead>
        <tbody>
          {tools.items.filter((t) => matches(query, t.name, t.id, t.description, t.category)).map((t, i) => {
            const name = t.name || t.id || `tool-${i}`;
            const [risk, riskCls] = RISK_ZH[String(t.risk_level || '').toLowerCase()] || [t.risk_level || '—', s.mute];
            return (
              <tr key={name}>
                <td className={s.mono}>{name}</td>
                {described ? <td className={s.desc}><span className={s.clamp}>{t.description || '—'}</span></td> : null}
                <td>{t.category || '—'}</td>
                <td>{t.risk_level ? <span className={`${s.pill} ${riskCls}`} title={t.risk_source || undefined}>{risk}</span> : '—'}</td>
                <td>{APPROVAL_ZH[String(t.approval_policy || '')] || t.approval_policy || '—'}</td>
                <td><Status value={toolStatus(t)} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  } else {
    body = models.items.length === 0 ? <Unavailable result={models} noun="模型" loading={loading} /> : (
      <table className={s.table}>
        <thead><tr><th>模型</th><th>提供方</th><th className={s.right}>上下文</th><th className={s.right}>最大输出</th><th>能力</th><th>状态</th></tr></thead>
        <tbody>
          {models.items.filter((m) => matches(query, m.name, m.model_id, m.id, m.provider)).map((m, i) => {
            const id = m.model_id || m.id || `model-${i}`;
            const vision = Array.isArray(m.input_modalities) && m.input_modalities.map(String).includes('image');
            return (
              <tr key={id}>
                <td>
                  <b>{m.name || id}</b>
                  {m.default ? <span className={`${s.pill} ${s.info}`} style={{ marginLeft: 6 }}>默认</span> : null}
                  <div className={`${s.mono} ${s.muted}`}>{id}</div>
                </td>
                <td>{m.provider || '—'}<div className={s.muted}>{m.api_protocol || ''}</div></td>
                <td className={`${s.right} ${s.num}`}>{formatTokens(m.context_window)}</td>
                <td className={`${s.right} ${s.num}`}>{formatTokens(m.max_output_tokens)}</td>
                <td>
                  <span className={s.tags}>
                    {vision ? <span className={`${s.pill} ${s.mute}`}>看图</span> : null}
                    {m.supports_reasoning ? <span className={`${s.pill} ${s.mute}`}>思考</span> : null}
                    {m.supports_tool_call ? <span className={`${s.pill} ${s.mute}`}>工具调用</span> : null}
                  </span>
                </td>
                <td><span className={`${s.pill} ${m.enabled === false ? s.mute : s.ok}`}>{m.enabled === false ? '已停用' : '可用'}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  return (
    <div className={s.page}>
      <div className={s.head}>
        <div>
          <h1>能力</h1>
          <p>当前部署提供的 Skills、MCP 服务、工具和模型。智能体可以使用哪些，在各自的版本配置里设置；个人 Skill 在「设置」里管理。</p>
        </div>
        <span className={s.sp} />
        <button type="button" className={s.btn} onClick={() => void refresh()}>刷新</button>
      </div>
      <div className={s.tabs} role="tablist" aria-label="能力分类">
        {tabs.map(([id, label, count]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}<small>{count}</small>
          </button>
        ))}
      </div>
      <div className={s.toolbar}>
        <input className={s.search} id="cap-search" placeholder="搜索名称或说明" aria-label="搜索" value={query} onChange={(e) => setQuery(e.target.value)} />
        {tab === 'skills' ? (
          <div className={s.seg} role="group" aria-label="Skill 来源">
            {([['all', '全部'], ['system', '系统'], ['user', '用户']] as const).map(([v, label]) => (
              <button key={v} type="button" aria-pressed={skillScope === v} onClick={() => setSkillScope(v)}>{label}</button>
            ))}
          </div>
        ) : null}
      </div>
      <div className={s.tableWrap}>{body}</div>
    </div>
  );
}
