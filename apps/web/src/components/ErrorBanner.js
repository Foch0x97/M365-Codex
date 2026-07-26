import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { ApiRequestError } from '../api';
/**
 * 统一错误体的展示组件：把 request_id 显眼地露出来，方便用户报障时提供给排查方。
 * 兼容非 ApiRequestError 的普通异常（例如网络层完全没连上）。
 */
export function ErrorBanner({ error, onRetry }) {
    if (error === null || error === undefined)
        return null;
    const isApiError = error instanceof ApiRequestError;
    const title = isApiError ? apiErrorTypeLabel(error.body.error.type) : '发生错误';
    const message = error instanceof Error ? error.message : String(error);
    const requestId = isApiError ? error.body.error.request_id : null;
    const param = isApiError ? error.body.error.param : null;
    return (_jsxs("div", { className: "error-banner", role: "alert", children: [_jsx("div", { className: "error-title", children: title }), _jsx("div", { children: message }), (requestId !== null || param !== null) && (_jsxs("div", { className: "error-meta", children: [param !== null && _jsxs("span", { children: ["\u76F8\u5173\u5B57\u6BB5\uFF1A", param, "\u3000"] }), requestId !== null && _jsxs("span", { className: "mono", children: ["request_id: ", requestId] })] })), onRetry !== undefined && (_jsx("div", { style: { marginTop: 10 }, children: _jsx("button", { type: "button", className: "btn btn-sm", onClick: onRetry, children: "\u91CD\u8BD5" }) }))] }));
}
function apiErrorTypeLabel(type) {
    const map = {
        invalid_request_error: '请求不合法',
        authentication_error: '认证失败',
        permission_error: '无权限',
        not_found_error: '资源不存在',
        rate_limit_error: '触发限流',
        idempotency_error: '幂等键冲突',
        unsupported_parameter: '参数暂不支持',
        unsupported_feature: '功能不在支持范围',
        account_pool_exhausted: '账号池已耗尽',
        upstream_error: '上游错误',
        upstream_timeout: '上游超时',
        service_not_ready: '服务尚未就绪',
        internal_error: '内部错误',
    };
    return map[type] ?? type;
}
