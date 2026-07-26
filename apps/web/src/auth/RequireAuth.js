import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Navigate, useLocation } from 'react-router';
import { useAuth } from './AuthContext';
/** 未登录（或会话已过期/被 401 清空）一律回登录页；登录后带回原本想去的路径。 */
export function RequireAuth({ children }) {
    const { status } = useAuth();
    const location = useLocation();
    if (status === 'checking') {
        return (_jsxs("div", { className: "state-block", role: "status", children: [_jsx("span", { className: "spinner", "aria-hidden": "true" }), _jsx("div", { style: { marginTop: 10 }, children: "\u6B63\u5728\u6821\u9A8C\u767B\u5F55\u72B6\u6001\u2026" })] }));
    }
    if (status === 'anonymous') {
        return _jsx(Navigate, { to: "/login", replace: true, state: { from: location.pathname } });
    }
    return _jsx(_Fragment, { children: children });
}
