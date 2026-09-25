import type { ReactElement } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { AppShell } from '../layout/AppShell';
import { AdminShell } from '../layout/AdminShell';
import { WorkbenchPage } from '../../pages/workbench/WorkbenchPage';
import { RunsPage } from '../../pages/runs/RunsPage';
import { RunDetailPage } from '../../pages/runs/RunDetailPage';
import { ApprovalsPage } from '../../pages/approvals/ApprovalsPage';
import { CapabilitiesPage } from '../../pages/settings/CapabilitiesPage';
import { A2aPage } from '../../pages/settings/A2aPage';
import { AgentsPage } from '../../pages/settings/AgentsPage';
import { SchedulesPage } from '../../pages/schedules/SchedulesPage';

/** /settings/<tab> moved to /admin/<tab>; keep old links and bookmarks working. */
function LegacySettingsRedirect() {
  const { tab } = useParams();
  const known = ['runs', 'approvals', 'agents', 'capabilities', 'a2a'];
  return <Navigate to={`/admin/${known.includes(String(tab)) ? tab : 'runs'}`} replace />;
}

const admin = (page: ReactElement) => <AdminShell>{page}</AdminShell>;

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AppShell><WorkbenchPage /></AppShell>} />
        <Route path="/c/:conversationId" element={<AppShell><WorkbenchPage /></AppShell>} />
        <Route path="/schedules" element={<AppShell><SchedulesPage /></AppShell>} />

        <Route path="/admin" element={<Navigate to="/admin/runs" replace />} />
        <Route path="/admin/runs" element={admin(<RunsPage />)} />
        <Route path="/admin/runs/:runId" element={admin(<RunDetailPage />)} />
        <Route path="/admin/approvals" element={admin(<ApprovalsPage />)} />
        <Route path="/admin/agents" element={admin(<AgentsPage />)} />
        <Route path="/admin/capabilities" element={admin(<CapabilitiesPage />)} />
        <Route path="/admin/a2a" element={admin(<A2aPage />)} />

        {/* Backward-compatible redirects */}
        <Route path="/settings/:tab" element={<LegacySettingsRedirect />} />
        <Route path="/settings" element={<Navigate to="/admin/runs" replace />} />
        <Route path="/runs" element={<Navigate to="/admin/runs" replace />} />
        <Route path="/approvals" element={<Navigate to="/admin/approvals" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
