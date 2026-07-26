import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Layout } from '../components/Layout';
import { AsyncSection } from '../components/StateBlock';
import { AccountStatusBadge, BoolBadge } from '../components/StatusBadge';
import { useAsync } from '../hooks/useAsync';
import { formatDateTime, formatRelative } from '../util/format';
const NEXT_STATUS = {
    disabled: { label: '启用', next: 'probing' },
    online: { label: '停用', next: 'disabled' },
    busy: { label: '停用', next: 'disabled' },
    cooldown: { label: '停用', next: 'disabled' },
    error: { label: '停用', next: 'disabled' },
};
export function AccountsPage() {
    const { data, error, loading, reload } = useAsync(() => api.listAccounts());
    const [busyId, setBusyId] = useState(null);
    const [rowError, setRowError] = useState(null);
    const runAction = (id, action) => {
        setBusyId(id);
        setRowError(null);
        action()
            .then(() => reload())
            .catch((err) => setRowError({ id, error: err }))
            .finally(() => setBusyId(null));
    };
    const handleDelete = (account) => {
        if (!window.confirm(`确认删除账号「${account.display_name ?? account.email ?? account.id}」？此操作不可撤销。`)) {
            return;
        }
        setBusyId(account.id);
        api
            .deleteAccount(account.id)
            .then(() => reload())
            .catch((err) => setRowError({ id: account.id, error: err }))
            .finally(() => setBusyId(null));
    };
    return (_jsxs(Layout, { title: "Microsoft \u8D26\u53F7", subtitle: "\u8D26\u53F7\u6C60\u72B6\u6001\u4E0E\u751F\u547D\u5468\u671F\u7BA1\u7406", children: [_jsxs("div", { className: "flex-between", style: { marginBottom: 12 }, children: [_jsxs("span", { className: "text-muted", children: ["\u5171 ", data?.length ?? 0, " \u4E2A\u8D26\u53F7\u3002\u65B0\u589E\u8D26\u53F7\u8BF7\u524D\u5F80", ' ', _jsx(Link, { to: "/accounts/add", children: "\u6DFB\u52A0\u8D26\u53F7" }), "\u3002"] }), _jsx("button", { type: "button", className: "btn btn-sm", onClick: reload, children: "\u5237\u65B0" })] }), _jsx(AsyncSection, { loading: loading, error: error, data: data, onRetry: reload, isEmpty: (list) => list.length === 0, emptyTitle: "\u8FD8\u6CA1\u6709\u4EFB\u4F55\u8D26\u53F7", emptyHint: "\u524D\u5F80\u300C\u6DFB\u52A0\u8D26\u53F7\u300D\u53D1\u8D77 PKCE \u6388\u6743\u6D41\u7A0B\u3002", children: (accounts) => (_jsx("div", { className: "card table-wrap", children: _jsxs("table", { children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u8D26\u53F7" }), _jsx("th", { children: "\u72B6\u6001" }), _jsx("th", { children: "\u5237\u65B0\u51ED\u636E" }), _jsx("th", { children: "\u6700\u8FD1\u6210\u529F" }), _jsx("th", { children: "\u8FDE\u7EED\u5931\u8D25" }), _jsx("th", { children: "Token \u8FC7\u671F" }), _jsx("th", { children: "\u4EE3\u7406\u7ED1\u5B9A" }), _jsx("th", { children: "\u64CD\u4F5C" })] }) }), _jsx("tbody", { children: accounts.map((account) => {
                                    const action = NEXT_STATUS[account.status];
                                    return (_jsxs("tr", { children: [_jsxs("td", { children: [_jsx("div", { children: account.display_name ?? '（未命名）' }), _jsx("div", { className: "text-faint mono", children: account.email ?? account.id })] }), _jsx("td", { children: _jsx(AccountStatusBadge, { status: account.status }) }), _jsx("td", { children: _jsx(BoolBadge, { value: account.has_refresh_token, trueLabel: "\u6709\u6548", falseLabel: "\u7F3A\u5931" }) }), _jsx("td", { children: formatRelative(account.last_ok_at) }), _jsx("td", { children: account.consecutive_failures }), _jsx("td", { title: formatDateTime(account.token_expires_at), children: formatRelative(account.token_expires_at) }), _jsx("td", { children: account.proxy_id ?? _jsx("span", { className: "text-faint", children: "\u672A\u7ED1\u5B9A" }) }), _jsxs("td", { children: [_jsxs("div", { className: "flex gap-8", children: [_jsx("button", { type: "button", className: "btn btn-sm", disabled: busyId === account.id, onClick: () => runAction(account.id, () => api.refreshAccount(account.id)), children: "\u5237\u65B0 Token" }), action !== undefined && (_jsx("button", { type: "button", className: "btn btn-sm", disabled: busyId === account.id, onClick: () => runAction(account.id, () => api.setAccountStatus(account.id, action.next)), children: action.label })), _jsx("button", { type: "button", className: "btn btn-sm btn-danger", disabled: busyId === account.id, onClick: () => handleDelete(account), children: "\u5220\u9664" })] }), rowError?.id === account.id && (_jsx("div", { style: { marginTop: 8, maxWidth: 320 }, children: _jsx(ErrorBanner, { error: rowError.error }) }))] })] }, account.id));
                                }) })] }) })) })] }));
}
