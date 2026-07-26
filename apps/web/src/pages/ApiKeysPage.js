import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { api } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Layout } from '../components/Layout';
import { RevealApiKeyModal } from '../components/RevealApiKeyModal';
import { AsyncSection } from '../components/StateBlock';
import { BoolBadge } from '../components/StatusBadge';
import { useAsync } from '../hooks/useAsync';
import { formatDateTime } from '../util/format';
function CreateApiKeyForm({ onCreated }) {
    const [name, setName] = useState('');
    const [rpmLimit, setRpmLimit] = useState('');
    const [dailyLimit, setDailyLimit] = useState('');
    const [maxConcurrency, setMaxConcurrency] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState(null);
    const toPositiveIntOrNull = (raw) => {
        const trimmed = raw.trim();
        if (trimmed.length === 0)
            return null;
        const n = Number(trimmed);
        return Number.isInteger(n) && n > 0 ? n : null;
    };
    const handleSubmit = (event) => {
        event.preventDefault();
        setSubmitting(true);
        setError(null);
        const payload = {
            name: name.trim(),
            rpm_limit: toPositiveIntOrNull(rpmLimit),
            daily_limit: toPositiveIntOrNull(dailyLimit),
            max_concurrency: toPositiveIntOrNull(maxConcurrency),
        };
        api
            .createApiKey(payload)
            .then((created) => {
            onCreated(created.key);
            setName('');
            setRpmLimit('');
            setDailyLimit('');
            setMaxConcurrency('');
        })
            .catch((err) => setError(err))
            .finally(() => setSubmitting(false));
    };
    return (_jsxs("form", { onSubmit: handleSubmit, className: "card", children: [_jsx("h2", { style: { marginTop: 0 }, children: "\u521B\u5EFA\u65B0\u7684 API Key" }), _jsxs("div", { className: "form-row", children: [_jsxs("div", { className: "field", children: [_jsx("label", { htmlFor: "key-name", children: "\u540D\u79F0" }), _jsx("input", { id: "key-name", type: "text", value: name, onChange: (e) => setName(e.target.value), required: true })] }), _jsxs("div", { className: "field", children: [_jsx("label", { htmlFor: "key-rpm", children: "\u6BCF\u5206\u949F\u9650\u5236" }), _jsx("input", { id: "key-rpm", type: "number", min: 1, value: rpmLimit, onChange: (e) => setRpmLimit(e.target.value), placeholder: "\u4E0D\u9650" })] }), _jsxs("div", { className: "field", children: [_jsx("label", { htmlFor: "key-daily", children: "\u6BCF\u65E5\u9650\u989D" }), _jsx("input", { id: "key-daily", type: "number", min: 1, value: dailyLimit, onChange: (e) => setDailyLimit(e.target.value), placeholder: "\u4E0D\u9650" })] }), _jsxs("div", { className: "field", children: [_jsx("label", { htmlFor: "key-concurrency", children: "\u6700\u5927\u5E76\u53D1" }), _jsx("input", { id: "key-concurrency", type: "number", min: 1, value: maxConcurrency, onChange: (e) => setMaxConcurrency(e.target.value), placeholder: "\u4E0D\u9650" })] })] }), error !== null && (_jsx("div", { style: { marginBottom: 12 }, children: _jsx(ErrorBanner, { error: error }) })), _jsx("button", { type: "submit", className: "btn btn-primary", disabled: submitting || name.trim().length === 0, children: submitting ? '创建中…' : '创建' })] }));
}
export function ApiKeysPage() {
    const { data, error, loading, reload } = useAsync(() => api.listApiKeys());
    const [revealKey, setRevealKey] = useState(null);
    const [busyId, setBusyId] = useState(null);
    const [rowError, setRowError] = useState(null);
    const toggleEnabled = (key) => {
        setBusyId(key.id);
        setRowError(null);
        api
            .updateApiKey(key.id, { enabled: !key.enabled })
            .then(() => reload())
            .catch((err) => setRowError({ id: key.id, error: err }))
            .finally(() => setBusyId(null));
    };
    const handleRevoke = (key) => {
        if (!window.confirm(`确认撤销「${key.name}」？撤销后不可恢复。`))
            return;
        setBusyId(key.id);
        setRowError(null);
        api
            .revokeApiKey(key.id)
            .then(() => reload())
            .catch((err) => setRowError({ id: key.id, error: err }))
            .finally(() => setBusyId(null));
    };
    return (_jsxs(Layout, { title: "API Key", subtitle: "\u5BF9\u5916\u5BC6\u94A5\u7684\u521B\u5EFA\u3001\u9650\u989D\u4E0E\u64A4\u9500", children: [_jsx(CreateApiKeyForm, { onCreated: (key) => {
                    setRevealKey(key);
                    reload();
                } }), _jsx(AsyncSection, { loading: loading, error: error, data: data, onRetry: reload, isEmpty: (list) => list.length === 0, emptyTitle: "\u8FD8\u6CA1\u6709\u521B\u5EFA\u4EFB\u4F55 API Key", children: (keys) => (_jsx("div", { className: "card table-wrap", children: _jsxs("table", { children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u540D\u79F0" }), _jsx("th", { children: "\u5BC6\u94A5" }), _jsx("th", { children: "\u72B6\u6001" }), _jsx("th", { children: "\u9650\u989D" }), _jsx("th", { children: "\u6700\u8FD1\u4F7F\u7528" }), _jsx("th", { children: "\u521B\u5EFA\u65F6\u95F4" }), _jsx("th", { children: "\u64CD\u4F5C" })] }) }), _jsx("tbody", { children: keys.map((key) => (_jsxs("tr", { children: [_jsx("td", { children: key.name }), _jsx("td", { className: "mono", children: key.masked_key }), _jsx("td", { children: _jsx(BoolBadge, { value: key.enabled, trueLabel: "\u542F\u7528\u4E2D", falseLabel: key.revoked_at !== null ? '已撤销' : '已停用' }) }), _jsxs("td", { className: "text-muted", children: [key.rpm_limit !== null ? `${key.rpm_limit}/分钟 · ` : '', key.daily_limit !== null ? `${key.daily_limit}/天 · ` : '', key.max_concurrency !== null ? `并发 ${key.max_concurrency}` : '', key.rpm_limit === null && key.daily_limit === null && key.max_concurrency === null && '不限'] }), _jsx("td", { children: formatDateTime(key.last_used_at) }), _jsx("td", { children: formatDateTime(key.created_at) }), _jsxs("td", { children: [_jsxs("div", { className: "flex gap-8", children: [_jsx("button", { type: "button", className: "btn btn-sm", disabled: busyId === key.id || key.revoked_at !== null, onClick: () => toggleEnabled(key), children: key.enabled ? '停用' : '启用' }), _jsx("button", { type: "button", className: "btn btn-sm btn-danger", disabled: busyId === key.id || key.revoked_at !== null, onClick: () => handleRevoke(key), children: "\u64A4\u9500" })] }), rowError?.id === key.id && (_jsx("div", { style: { marginTop: 8, maxWidth: 320 }, children: _jsx(ErrorBanner, { error: rowError.error }) }))] })] }, key.id))) })] }) })) }), revealKey !== null && _jsx(RevealApiKeyModal, { apiKey: revealKey, onClose: () => setRevealKey(null) })] }));
}
