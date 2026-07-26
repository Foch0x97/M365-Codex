import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from './AuthContext';

/** 未登录（或会话已过期/被 401 清空）一律回登录页；登录后带回原本想去的路径。 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'checking') {
    return (
      <div className="state-block" role="status">
        <span className="spinner" aria-hidden="true" />
        <div style={{ marginTop: 10 }}>正在校验登录状态…</div>
      </div>
    );
  }

  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
