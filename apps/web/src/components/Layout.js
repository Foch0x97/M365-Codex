import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { NavLink } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { ThemeToggle } from './ThemeToggle';
import { IconAccounts, IconAddAccount, IconApiKey, IconBackup, IconCapabilities, IconCodex, IconFiles, IconLogout, IconLogs, IconOAuth, IconOverview, IconProxies, IconRequests, IconScheduler, IconSettings, } from './icons';
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
export function Layout({ children, title, subtitle }) {
    const { logout } = useAuth();
    return (_jsxs("div", { className: "app-shell", children: [_jsxs("aside", { className: "sidebar", children: [_jsxs("div", { className: "brand", children: [_jsx("span", { className: "brand-mark", "aria-hidden": "true" }), "M365-Codex"] }), NAV.map((group) => (_jsxs("div", { children: [_jsx("div", { className: "nav-section-label", children: group.section }), group.items.map((item) => (_jsxs(NavLink, { to: item.to, className: ({ isActive }) => `nav-link${isActive ? ' active' : ''}`, children: [_jsx(item.icon, {}), item.label] }, item.to)))] }, group.section)))] }), _jsxs("main", { className: "main", children: [_jsxs("div", { className: "topbar", children: [_jsxs("div", { children: [_jsx("h1", { className: "page-title", children: title }), subtitle !== undefined && _jsx("div", { className: "page-subtitle", children: subtitle })] }), _jsxs("div", { className: "flex gap-12", style: { alignItems: 'center' }, children: [_jsx(ThemeToggle, {}), _jsxs("button", { type: "button", className: "btn btn-sm", onClick: logout, children: [_jsx(IconLogout, {}), "\u9000\u51FA\u767B\u5F55"] })] })] }), children] })] }));
}
