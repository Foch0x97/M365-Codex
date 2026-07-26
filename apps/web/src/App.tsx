import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { RequireAuth } from './auth/RequireAuth';
import { AccountsPage } from './pages/AccountsPage';
import { AddAccountPage } from './pages/AddAccountPage';
import { ApiKeysPage } from './pages/ApiKeysPage';
import { BackupPage } from './pages/BackupPage';
import { CapabilitiesPage } from './pages/CapabilitiesPage';
import { CodexConfigPage } from './pages/CodexConfigPage';
import { FilesPage } from './pages/FilesPage';
import { LoggingSettingsPage } from './pages/LoggingSettingsPage';
import { LoginPage } from './pages/LoginPage';
import { OAuthSettingsPage } from './pages/OAuthSettingsPage';
import { OverviewPage } from './pages/OverviewPage';
import { ProxiesPage } from './pages/ProxiesPage';
import { RequestDetailPage } from './pages/RequestDetailPage';
import { RequestsPage } from './pages/RequestsPage';
import { SchedulerSettingsPage } from './pages/SchedulerSettingsPage';
import { SystemSettingsPage } from './pages/SystemSettingsPage';

function protect(element: ReactNode) {
  return <RequireAuth>{element}</RequireAuth>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<Navigate to="/overview" replace />} />
      <Route path="/overview" element={protect(<OverviewPage />)} />
      <Route path="/accounts" element={protect(<AccountsPage />)} />
      <Route path="/accounts/add" element={protect(<AddAccountPage />)} />
      <Route path="/requests" element={protect(<RequestsPage />)} />
      <Route path="/requests/:id" element={protect(<RequestDetailPage />)} />
      <Route path="/api-keys" element={protect(<ApiKeysPage />)} />
      <Route path="/capabilities" element={protect(<CapabilitiesPage />)} />
      <Route path="/files" element={protect(<FilesPage />)} />
      <Route path="/proxies" element={protect(<ProxiesPage />)} />
      <Route path="/settings/oauth" element={protect(<OAuthSettingsPage />)} />
      <Route path="/settings/scheduler" element={protect(<SchedulerSettingsPage />)} />
      <Route path="/settings/logging" element={protect(<LoggingSettingsPage />)} />
      <Route path="/settings/system" element={protect(<SystemSettingsPage />)} />
      <Route path="/codex-config" element={protect(<CodexConfigPage />)} />
      <Route path="/backup" element={protect(<BackupPage />)} />
      <Route path="*" element={<Navigate to="/overview" replace />} />
    </Routes>
  );
}
