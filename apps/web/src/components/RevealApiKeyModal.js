import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { CopyButton } from './CopyButton';
/**
 * API Key 创建后明文只会出现这一次——服务端不保存明文，之后任何接口都拿不到它。
 * 关闭前必须勾选「我已保存」，避免用户手滑关掉弹窗后再也找不回这个密钥。
 */
export function RevealApiKeyModal({ apiKey, onClose }) {
    const [confirmed, setConfirmed] = useState(false);
    return (_jsx("div", { className: "modal-backdrop", role: "dialog", "aria-modal": "true", "aria-labelledby": "reveal-key-title", children: _jsxs("div", { className: "modal", children: [_jsx("h2", { id: "reveal-key-title", style: { marginTop: 0 }, children: "\u5BC6\u94A5\u5DF2\u521B\u5EFA" }), _jsxs("div", { className: "error-banner", style: { marginBottom: 16 }, children: [_jsx("div", { className: "error-title", children: "\u8FD9\u662F\u552F\u4E00\u4E00\u6B21\u663E\u793A\u5B8C\u6574\u5BC6\u94A5\u7684\u673A\u4F1A" }), _jsx("div", { children: "\u5173\u95ED\u672C\u5F39\u7A97\u540E\uFF0C\u670D\u52A1\u7AEF\u4E0D\u4F1A\u518D\u4FDD\u5B58\u660E\u6587\uFF0C\u4E5F\u65E0\u6CD5\u518D\u6B21\u67E5\u770B\u2014\u2014\u8BF7\u7ACB\u5373\u590D\u5236\u5E76\u59A5\u5584\u4FDD\u5B58\u3002" })] }), _jsx("div", { className: "mono-copy", style: { width: '100%', justifyContent: 'space-between' }, children: _jsx("span", { style: { overflowWrap: 'anywhere' }, children: apiKey }) }), _jsx("div", { style: { marginTop: 10 }, children: _jsx(CopyButton, { value: apiKey, label: "\u590D\u5236\u5BC6\u94A5" }) }), _jsxs("label", { className: "checkbox-row", style: { marginTop: 20 }, children: [_jsx("input", { type: "checkbox", checked: confirmed, onChange: (e) => setConfirmed(e.target.checked) }), "\u6211\u5DF2\u4FDD\u5B58\u8FD9\u4E2A\u5BC6\u94A5"] }), _jsx("div", { style: { marginTop: 16 }, children: _jsx("button", { type: "button", className: "btn btn-primary", disabled: !confirmed, onClick: onClose, children: "\u5173\u95ED" }) })] }) }));
}
