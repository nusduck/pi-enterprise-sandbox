import { useMemo, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useChat } from '../../features/chat/ChatContext';
import { listActiveRuns } from '../../entities';
import { IconArrowLeft } from '../../shared/ui/Icons';
import s from './adminShell.module.css';

const SECTIONS: Array<{ title: string; items: Array<{ to: string; label: string; badge?: 'runs' | 'approvals' }> }> = [
  {
    title: '运维',
    items: [
      { to: '/admin/runs', label: '运行', badge: 'runs' },
      { to: '/admin/approvals', label: '审批', badge: 'approvals' },
    ],
  },
  {
    title: '配置',
    items: [
      { to: '/admin/agents', label: '智能体' },
      { to: '/admin/capabilities', label: '能力' },
      { to: '/admin/a2a', label: 'A2A 接入' },
    ],
  },
];

/**
 * Admin console: its own full-screen layout, separate from the conversation
 * workbench. Only admins see the pages; the Agent and BFF enforce the same
 * role on every admin endpoint, so this gate only avoids showing dead ends.
 */
export function AdminShell({ children }: { children: ReactNode }) {
  const { state, entityStore } = useChat();
  const isAdmin = String(state.authUser?.role || '').toLowerCase() === 'admin';
  const activeRuns = useMemo(() => listActiveRuns(entityStore).length, [entityStore]);
  const pending = useMemo(
    () => Object.values(entityStore.approvalsById || {}).filter((a) => a.status === 'pending').length,
    [entityStore],
  );

  if (!state.authReady) {
    return <div id="app" className="app-shell session-bootstrap" role="status" aria-live="polite">正在恢复会话…</div>;
  }

  return (
    <div id="app" className={s.shell}>
      <nav className={s.nav} aria-label="管理控制台">
        <div className={s.brand}>
          <img src="/brand/uprc-icon.png" alt="" width={22} height={22} />
          管理控制台
        </div>
        <Link to="/" className={s.back}>
          <IconArrowLeft size={14} /> 返回对话
        </Link>
        {SECTIONS.map((section) => (
          <div key={section.title} className={s.section}>
            <h2>{section.title}</h2>
            {section.items.map((item) => {
              const count = item.badge === 'runs' ? activeRuns : item.badge === 'approvals' ? pending : 0;
              return (
                <NavLink key={item.to} to={item.to} className={({ isActive }) => `${s.item}${isActive ? ` ${s.active}` : ''}`}>
                  {item.label}
                  {count ? <span className={item.badge === 'approvals' ? s.warn : s.count}>{count}</span> : null}
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>
      <main className={s.main}>
        {isAdmin ? children : (
          <div className={s.denied} role="status">
            <b>需要管理员权限</b>
            <span>管理控制台只对管理员开放。</span>
            <Link to="/">返回对话</Link>
          </div>
        )}
      </main>
    </div>
  );
}
