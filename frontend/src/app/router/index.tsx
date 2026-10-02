import type { ReactElement } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { AppShell } from '../layout/AppShell';
import { AdminShell } from '../layout/AdminShell';
import { WorkbenchPage } from '../../pages/workbench/WorkbenchPage';
import { RunsPage } from '../../pages/runs/RunsPage';
import { RunDetailPage } from '../../pages/runs/RunDetailPage';
import { ApprovalsPage } from '../../pages/approvals/ApprovalsPage';
import { CapabilitiesPage } from '../../pages/settings/CapabilitiesPage';
import { A2aPage } from '../../pages/settings/A2aPage';
import { AgentsPage } from '../../pages/settings/AgentsPage';
import { SkillAdminPage } from '../../pages/settings/SkillAdminPage';
import { MembersPage } from '../../pages/settings/MembersPage';
import { SchedulesPage } from '../../pages/schedules/SchedulesPage';
import { ArtifactsPage } from '../../pages/artifact-library/ArtifactsPage';
import { ReviewsPage } from '../../pages/reviews/ReviewsPage';
import { LoginPage } from '../../pages/login/LoginPage';
import { useChat } from '../../features/chat/ChatContext';

/** /settings/<tab> moved to /admin/<tab>; keep old links and bookmarks working. */
function LegacySettingsRedirect() {
  const { tab } = useParams();
  const known = ['runs', 'approvals', 'agents', 'capabilities', 'skills', 'a2a'];
  return <Navigate to={`/admin/${known.includes(String(tab)) ? tab : 'runs'}`} replace />;
}

function RequireAuth({ children }: { children: ReactElement }) {
  const { state } = useChat();
  const location = useLocation();

  if (!state.authReady) {
    return (
      <div id="app" className="app-shell session-bootstrap" role="status" aria-live="polite">
        正在恢复会话…
      </div>
    );
  }

  if (!state.authUser?.username) {
    const returnTo = location.pathname + location.search + location.hash;
    return <Navigate to={`/login?return_to=${encodeURIComponent(returnTo)}`} replace />;
  }

  return children;
}

const admin = (page: ReactElement) => <AdminShell>{page}</AdminShell>;
const protect = (page: ReactElement) => <RequireAuth>{page}</RequireAuth>;

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        {/* 独立登录路由：未登录访问其他页面跳此处，已登录访问跳回 return_to */}
        <Route path="/login" element={<LoginPage />} />

        {/* 用户端工作台页面 */}
        <Route path="/" element={protect(<AppShell><WorkbenchPage /></AppShell>)} />
        <Route path="/c/:conversationId" element={protect(<AppShell><WorkbenchPage /></AppShell>)} />
        <Route path="/schedules" element={protect(<AppShell><SchedulesPage /></AppShell>)} />
        <Route path="/artifacts" element={protect(<AppShell><ArtifactsPage /></AppShell>)} />
        {/* 审核工作台放在 AppShell 里：reviewer 不一定是 admin（design §8）。 */}
        <Route path="/reviews" element={protect(<AppShell><ReviewsPage /></AppShell>)} />

        {/* 管理控制台页面 */}
        <Route path="/admin" element={protect(<Navigate to="/admin/runs" replace />)} />
        <Route path="/admin/runs" element={protect(admin(<RunsPage />))} />
        <Route path="/admin/runs/:runId" element={protect(admin(<RunDetailPage />))} />
        <Route path="/admin/approvals" element={protect(admin(<ApprovalsPage />))} />
        <Route path="/admin/agents" element={protect(admin(<AgentsPage />))} />
        <Route path="/admin/capabilities" element={protect(admin(<CapabilitiesPage />))} />
        <Route path="/admin/skills" element={protect(admin(<SkillAdminPage />))} />
        <Route path="/admin/a2a" element={protect(admin(<A2aPage />))} />
        <Route path="/admin/members" element={protect(admin(<MembersPage />))} />

        {/* Backward-compatible redirects */}
        <Route path="/settings/:tab" element={protect(<LegacySettingsRedirect />)} />
        <Route path="/settings" element={protect(<Navigate to="/admin/runs" replace />)} />
        <Route path="/runs" element={protect(<Navigate to="/admin/runs" replace />)} />
        <Route path="/approvals" element={protect(<Navigate to="/admin/approvals" replace />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
