import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { ThemeToggle } from './ThemeToggle';
import {
  IconAccounts,
  IconAddAccount,
  IconApiKey,
  IconBackup,
  IconCapabilities,
  IconCodex,
  IconFiles,
  IconLogout,
  IconLogs,
  IconOAuth,
  IconOverview,
  IconProxies,
  IconRequests,
  IconScheduler,
  IconSettings,
} from './icons';

const NAV = [
  {
    section: '监控与管理',
    items: [
      { to: '/overview', label: '概览', icon: IconOverview },
      { to: '/accounts', label: 'Microsoft 账号', icon: IconAccounts },
      { to: '/accounts/add', label: '添加账号', icon: IconAddAccount },
      { to: '/requests', label: '请求', icon: IconRequests },
      { to: '/api-keys', label: 'API Key', icon: IconApiKey },
      { to: '/capabilities', label: '模型与能力', icon: IconCapabilities },
      { to: '/files', label: '文件', icon: IconFiles },
      { to: '/proxies', label: '代理池', icon: IconProxies },
    ],
  },
  {
    section: '配置',
    items: [
      { to: '/settings/oauth', label: 'OAuth', icon: IconOAuth },
      { to: '/settings/scheduler', label: '调度', icon: IconScheduler },
      { to: '/settings/logging', label: '日志', icon: IconLogs },
      { to: '/settings/system', label: '系统设置', icon: IconSettings },
      { to: '/codex-config', label: 'Codex 配置', icon: IconCodex },
    ],
  },
  {
    section: '运维',
    items: [{ to: '/backup', label: '备份与恢复', icon: IconBackup }],
  },
];

export function Layout({ children, title, subtitle }: { children: ReactNode; title: string; subtitle?: string }) {
  const { logout } = useAuth();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          M365-Codex
        </div>
        {NAV.map((group) => (
          <div key={group.section}>
            <div className="nav-section-label">{group.section}</div>
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              >
                <item.icon />
                {item.label}
              </NavLink>
            ))}
          </div>
        ))}
      </aside>
      <main className="main">
        <div className="topbar">
          <div>
            <h1 className="page-title">{title}</h1>
            {subtitle !== undefined && <div className="page-subtitle">{subtitle}</div>}
          </div>
          <div className="flex gap-12" style={{ alignItems: 'center' }}>
            <ThemeToggle />
            <button type="button" className="btn btn-sm" onClick={logout}>
              <IconLogout />
              退出登录
            </button>
          </div>
        </div>
        {children}
      </main>
    </div>
  );
}
