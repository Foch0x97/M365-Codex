import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, type AuthorizeUrlResponse, type OAuthCallbackResult } from '../api';
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
  const [session, setSession] = useState<AuthorizeUrlResponse | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);

  const [callbackUrl, setCallbackUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [result, setResult] = useState<OAuthCallbackResult | null>(null);

  const handleCreate = () => {
    setCreating(true);
    setCreateError(null);
    api
      .createAuthorizeUrl()
      .then((res) => setSession(res))
      .catch((err: unknown) => setCreateError(err))
      .finally(() => setCreating(false));
  };

  const handleSubmit = (event: FormEvent) => {
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
      .catch((err: unknown) => setSubmitError(err))
      .finally(() => setSubmitting(false));
  };

  return (
    <Layout title="添加账号" subtitle="通过 PKCE 授权流程添加一个 Microsoft 365 Copilot 账号">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>第一步：生成授权链接</h2>
        <p className="text-muted">
          点击生成后在新标签页打开，选择一个有 Copilot 权限的账号登录。登录完成后 Microsoft 会跳转到它自己的
          <code> nativeclient </code>
          提示页——这一步是正常的，复制那个页面地址栏的完整链接备用。
        </p>
        <button type="button" className="btn btn-primary" onClick={handleCreate} disabled={creating}>
          {creating ? '生成中…' : '生成授权链接'}
        </button>
        {createError !== null && (
          <div style={{ marginTop: 12 }}>
            <ErrorBanner error={createError} />
          </div>
        )}
        {session !== null && (
          <div style={{ marginTop: 14 }}>
            <div className="mono-copy" style={{ maxWidth: '100%', overflowWrap: 'anywhere' }}>
              <a href={session.authorize_url} target="_blank" rel="noreferrer">
                {session.authorize_url}
              </a>
            </div>
            <div className="flex gap-8" style={{ marginTop: 8 }}>
              <CopyButton value={session.authorize_url} label="复制链接" />
              <span className="text-faint" style={{ alignSelf: 'center' }}>
                会话 {formatDateTime(session.expires_at)} 后过期，过期需重新生成
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>第二步：提交回调地址</h2>
        <p className="text-muted">
          把浏览器地址栏复制到的完整 URL 粘贴到这里。授权码只能使用一次，可以同时为多个账号并行授权。
        </p>
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="callback-url">回调地址</label>
            <input
              id="callback-url"
              type="text"
              placeholder="https://login.microsoftonline.com/common/oauth2/nativeclient?code=…&state=…"
              value={callbackUrl}
              onChange={(e) => setCallbackUrl(e.target.value)}
              required
            />
          </div>
          {submitError !== null && (
            <div style={{ marginBottom: 12 }}>
              <ErrorBanner error={submitError} />
            </div>
          )}
          <button type="submit" className="btn btn-primary" disabled={submitting || callbackUrl.trim().length === 0}>
            {submitting ? '提交中…' : '完成授权'}
          </button>
        </form>
        {result !== null && (
          <div className="error-banner" style={{ marginTop: 14, borderColor: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 10%, transparent)' }}>
            <div className="error-title" style={{ color: 'var(--ok)' }}>
              {result.existing ? '账号已重新授权' : '账号已创建'}
            </div>
            <div>
              {result.account.display_name ?? result.account.email ?? result.account.id}（状态：
              {result.account.status}）
            </div>
            <div style={{ marginTop: 10 }}>
              {/* 纯粹的页面跳转，用声明式的 Link 而不是 onClick 里手动 navigate()——
                  后者返回 void | Promise<void>，塞进事件处理器还得额外处理这个基本不会拒绝的 Promise。 */}
              <Link to="/accounts" className="btn btn-sm">
                前往账号列表
              </Link>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
