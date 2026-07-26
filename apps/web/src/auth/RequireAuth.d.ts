import type { ReactNode } from 'react';
/** 未登录（或会话已过期/被 401 清空）一律回登录页；登录后带回原本想去的路径。 */
export declare function RequireAuth({ children }: {
    children: ReactNode;
}): import("react").JSX.Element;
