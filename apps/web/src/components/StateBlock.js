import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { ErrorBanner } from './ErrorBanner';
export function LoadingBlock({ label = '加载中…' }) {
    return (_jsxs("div", { className: "state-block", role: "status", children: [_jsx("span", { className: "spinner", "aria-hidden": "true" }), _jsx("div", { style: { marginTop: 10 }, children: label })] }));
}
export function EmptyBlock({ title, hint }) {
    return (_jsxs("div", { className: "state-block", children: [_jsx("div", { className: "state-title", children: title }), hint !== undefined && _jsx("div", { children: hint })] }));
}
/**
 * 加载 / 错误 / 空 / 有数据 四态的统一入口，页面只需要关心「有数据时怎么画」。
 */
export function AsyncSection({ loading, error, data, isEmpty, emptyTitle, emptyHint, onRetry, loadingLabel, children, }) {
    if (loading)
        return _jsx(LoadingBlock, { label: loadingLabel });
    if (error !== null && error !== undefined)
        return _jsx(ErrorBanner, { error: error, onRetry: onRetry });
    if (data === null)
        return _jsx(EmptyBlock, { title: emptyTitle ?? '暂无数据', hint: emptyHint });
    if (isEmpty?.(data) === true)
        return _jsx(EmptyBlock, { title: emptyTitle ?? '暂无数据', hint: emptyHint });
    return _jsx(_Fragment, { children: children(data) });
}
