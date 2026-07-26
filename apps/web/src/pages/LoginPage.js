import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from '../components/ErrorBanner';
import { ThemeToggle } from '../components/ThemeToggle';
export function LoginPage() {
    const { login, status } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const [password, setPassword] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState(null);
    if (status === 'authenticated') {
        const from = location.state?.from ?? '/overview';
        return _jsx(Navigate, { to: from, replace: true });
    }
    const handleSubmit = (event) => {
        event.preventDefault();
        setSubmitting(true);
        setError(null);
        login(password)
            .then(() => {
            const from = location.state?.from ?? '/overview';
            navigate(from, { replace: true });
        })
            .catch((err) => setError(err))
            .finally(() => setSubmitting(false));
    };
    return (_jsx("div", { className: "login-shell", children: _jsxs("div", { className: "login-card", children: [_jsxs("div", { className: "flex-between", style: { marginBottom: 20 }, children: [_jsxs("div", { className: "brand", children: [_jsx("span", { className: "brand-mark", "aria-hidden": "true" }), "M365-Codex"] }), _jsx(ThemeToggle, {})] }), _jsxs("div", { className: "card", children: [_jsx("h1", { className: "page-title", style: { marginBottom: 4 }, children: "\u7BA1\u7406\u5458\u767B\u5F55" }), _jsxs("p", { className: "page-subtitle", style: { marginBottom: 20 }, children: ["\u4F7F\u7528 ", _jsx("code", { children: "M365_CODEX_ADMIN_PASSWORD" }), " \u767B\u5F55\uFF0C\u4E0E\u5BF9\u5916 API Key \u5B8C\u5168\u9694\u79BB\u3002"] }), _jsxs("form", { onSubmit: handleSubmit, children: [_jsxs("div", { className: "field", children: [_jsx("label", { htmlFor: "admin-password", children: "\u7BA1\u7406\u5458\u5BC6\u7801" }), _jsx("input", { id: "admin-password", type: "password", autoComplete: "current-password", value: password, onChange: (e) => setPassword(e.target.value), autoFocus: true, required: true })] }), error !== null && (_jsx("div", { style: { marginBottom: 14 }, children: _jsx(ErrorBanner, { error: error }) })), _jsx("button", { type: "submit", className: "btn btn-primary", style: { width: '100%' }, disabled: submitting, children: submitting ? '登录中…' : '登录' })] })] }), _jsx("p", { className: "text-faint", style: { marginTop: 14, fontSize: 12 }, children: "\u4EE4\u724C\u53EA\u4FDD\u5B58\u5728\u5185\u5B58\u4E0E\u672C\u6807\u7B7E\u9875\u7684\u4F1A\u8BDD\u5B58\u50A8\u4E2D\uFF0C\u5173\u95ED\u6807\u7B7E\u9875\u540E\u9700\u8981\u91CD\u65B0\u767B\u5F55\u3002" })] }) }));
}
