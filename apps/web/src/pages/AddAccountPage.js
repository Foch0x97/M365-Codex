import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { CopyButton } from '../components/CopyButton';
import { ErrorBanner } from '../components/ErrorBanner';
import { Layout } from '../components/Layout';
import { formatDateTime } from '../util/format';
/**
 * 添加账号只有一种方式：本网关自己的 PKCE 授权流程。
 * 因为回调落在 Microsoft 自己的页面上，本服务不需要公网可达，也不用暴露回调端点——
 * 用户在浏览器完成登录后，把地址栏的完整 URL 贴回来即可。
 */
export function AddAccountPage() {
    const navigate = useNavigate();
    const [session, setSession] = useState(null);
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState(null);
    const [callbackUrl, setCallbackUrl] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState(null);
    const [result, setResult] = useState(null);
    const handleCreate = () => {
        setCreating(true);
        setCreateError(null);
        api
            .createAuthorizeUrl()
            .then((res) => setSession(res))
            .catch((err) => setCreateError(err))
            .finally(() => setCreating(false));
    };
    const handleSubmit = (event) => {
        event.preventDefault();
        setSubmitting(true);
        setSubmitError(null);
        setResult(null);
        api
            .submitOAuthCallback(callbackUrl.trim())
            .then((res) => {
            setResult(res);
            setCallbackUrl('');
        })
            .catch((err) => setSubmitError(err))
            .finally(() => setSubmitting(false));
    };
    return (_jsxs(Layout, { title: "\u6DFB\u52A0\u8D26\u53F7", subtitle: "\u901A\u8FC7 PKCE \u6388\u6743\u6D41\u7A0B\u6DFB\u52A0\u4E00\u4E2A Microsoft 365 Copilot \u8D26\u53F7", children: [_jsxs("div", { className: "card", children: [_jsx("h2", { style: { marginTop: 0 }, children: "\u7B2C\u4E00\u6B65\uFF1A\u751F\u6210\u6388\u6743\u94FE\u63A5" }), _jsxs("p", { className: "text-muted", children: ["\u70B9\u51FB\u751F\u6210\u540E\u5728\u65B0\u6807\u7B7E\u9875\u6253\u5F00\uFF0C\u9009\u62E9\u4E00\u4E2A\u6709 Copilot \u6743\u9650\u7684\u8D26\u53F7\u767B\u5F55\u3002\u767B\u5F55\u5B8C\u6210\u540E Microsoft \u4F1A\u8DF3\u8F6C\u5230\u5B83\u81EA\u5DF1\u7684", _jsx("code", { children: " nativeclient " }), "\u63D0\u793A\u9875\u2014\u2014\u8FD9\u4E00\u6B65\u662F\u6B63\u5E38\u7684\uFF0C\u590D\u5236\u90A3\u4E2A\u9875\u9762\u5730\u5740\u680F\u7684\u5B8C\u6574\u94FE\u63A5\u5907\u7528\u3002"] }), _jsx("button", { type: "button", className: "btn btn-primary", onClick: handleCreate, disabled: creating, children: creating ? '生成中…' : '生成授权链接' }), createError !== null && (_jsx("div", { style: { marginTop: 12 }, children: _jsx(ErrorBanner, { error: createError }) })), session !== null && (_jsxs("div", { style: { marginTop: 14 }, children: [_jsx("div", { className: "mono-copy", style: { maxWidth: '100%', overflowWrap: 'anywhere' }, children: _jsx("a", { href: session.authorize_url, target: "_blank", rel: "noreferrer", children: session.authorize_url }) }), _jsxs("div", { className: "flex gap-8", style: { marginTop: 8 }, children: [_jsx(CopyButton, { value: session.authorize_url, label: "\u590D\u5236\u94FE\u63A5" }), _jsxs("span", { className: "text-faint", style: { alignSelf: 'center' }, children: ["\u4F1A\u8BDD ", formatDateTime(session.expires_at), " \u540E\u8FC7\u671F\uFF0C\u8FC7\u671F\u9700\u91CD\u65B0\u751F\u6210"] })] })] }))] }), _jsxs("div", { className: "card", children: [_jsx("h2", { style: { marginTop: 0 }, children: "\u7B2C\u4E8C\u6B65\uFF1A\u63D0\u4EA4\u56DE\u8C03\u5730\u5740" }), _jsx("p", { className: "text-muted", children: "\u628A\u6D4F\u89C8\u5668\u5730\u5740\u680F\u590D\u5236\u5230\u7684\u5B8C\u6574 URL \u7C98\u8D34\u5230\u8FD9\u91CC\u3002\u6388\u6743\u7801\u53EA\u80FD\u4F7F\u7528\u4E00\u6B21\uFF0C\u53EF\u4EE5\u540C\u65F6\u4E3A\u591A\u4E2A\u8D26\u53F7\u5E76\u884C\u6388\u6743\u3002" }), _jsxs("form", { onSubmit: handleSubmit, children: [_jsxs("div", { className: "field", children: [_jsx("label", { htmlFor: "callback-url", children: "\u56DE\u8C03\u5730\u5740" }), _jsx("input", { id: "callback-url", type: "text", placeholder: "https://login.microsoftonline.com/common/oauth2/nativeclient?code=\u2026&state=\u2026", value: callbackUrl, onChange: (e) => setCallbackUrl(e.target.value), required: true })] }), submitError !== null && (_jsx("div", { style: { marginBottom: 12 }, children: _jsx(ErrorBanner, { error: submitError }) })), _jsx("button", { type: "submit", className: "btn btn-primary", disabled: submitting || callbackUrl.trim().length === 0, children: submitting ? '提交中…' : '完成授权' })] }), result !== null && (_jsxs("div", { className: "error-banner", style: { marginTop: 14, borderColor: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 10%, transparent)' }, children: [_jsx("div", { className: "error-title", style: { color: 'var(--ok)' }, children: result.existing ? '账号已重新授权' : '账号已创建' }), _jsxs("div", { children: [result.account.display_name ?? result.account.email ?? result.account.id, "\uFF08\u72B6\u6001\uFF1A", result.account.status, "\uFF09"] }), _jsx("div", { style: { marginTop: 10 }, children: _jsx("button", { type: "button", className: "btn btn-sm", onClick: () => navigate('/accounts'), children: "\u524D\u5F80\u8D26\u53F7\u5217\u8868" }) })] }))] })] }));
}
