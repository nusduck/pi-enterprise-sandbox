import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '../layout/AppShell';
import { WorkbenchPage } from '../../pages/workbench/WorkbenchPage';
import { RunsPage } from '../../pages/runs/RunsPage';
import { ApprovalsPage } from '../../pages/approvals/ApprovalsPage';
import { CapabilitiesPage } from '../../pages/settings/CapabilitiesPage';
import { A2aPage } from '../../pages/settings/A2aPage';

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <AppShell>
              <WorkbenchPage />
            </AppShell>
          }
        />
        <Route
          path="/runs"
          element={
            <AppShell>
              <RunsPage />
            </AppShell>
          }
        />
        <Route
          path="/approvals"
          element={
            <AppShell>
              <ApprovalsPage />
            </AppShell>
          }
        />
        <Route
          path="/settings/capabilities"
          element={
            <AppShell>
              <CapabilitiesPage />
            </AppShell>
          }
        />
        <Route
          path="/settings/a2a"
          element={
            <AppShell>
              <A2aPage />
            </AppShell>
          }
        />
        {/* Aliases for ADR wording */}
        <Route
          path="/settings"
          element={<Navigate to="/settings/capabilities" replace />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
