import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Layout } from '../components/Layout';
/** 尚未完善的页面占位：能正常进入、不白屏，避免用户点导航时以为应用挂了。 */
export function PlaceholderPage({ title, subtitle, note }) {
    return (_jsx(Layout, { title: title, subtitle: subtitle, children: _jsxs("div", { className: "card state-block", children: [_jsx("div", { className: "state-title", children: "\u529F\u80FD\u5EFA\u8BBE\u4E2D" }), _jsx("div", { children: note })] }) }));
}
