import { useState, type FormEvent } from 'react';
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
  const [error, setError] = useState<unknown>(null);

  if (status === 'authenticated') {
    const from = (location.state as { from?: string } | null)?.from ?? '/overview';
    return <Navigate to={from} replace />;
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    login(password)
      .then(() => {
        const from = (location.state as { from?: string } | null)?.from ?? '/overview';
        navigate(from, { replace: true });
      })
      .catch((err: unknown) => setError(err))
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="flex-between" style={{ marginBottom: 20 }}>
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            M365-Codex
          </div>
          <ThemeToggle />
        </div>
        <div className="card">
          <h1 className="page-title" style={{ marginBottom: 4 }}>
            管理员登录
          </h1>
          <p className="page-subtitle" style={{ marginBottom: 20 }}>
            使用 <code>M365_CODEX_ADMIN_PASSWORD</code> 登录，与对外 API Key 完全隔离。
          </p>
          <form onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="admin-password">管理员密码</label>
              <input
                id="admin-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                required
              />
            </div>
            {error !== null && (
              <div style={{ marginBottom: 14 }}>
                <ErrorBanner error={error} />
              </div>
            )}
            <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={submitting}>
              {submitting ? '登录中…' : '登录'}
            </button>
          </form>
        </div>
        <p className="text-faint" style={{ marginTop: 14, fontSize: 12 }}>
          令牌只保存在内存与本标签页的会话存储中，关闭标签页后需要重新登录。
        </p>
      </div>
    </div>
  );
}
