import { useState } from 'react';
import { Link } from 'react-router';
import { api, type AccountStatus, type AccountView } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Layout } from '../components/Layout';
import { AsyncSection } from '../components/StateBlock';
import { AccountStatusBadge, BoolBadge } from '../components/StatusBadge';
import { useAsync } from '../hooks/useAsync';
import { formatDateTime, formatRelative } from '../util/format';

const NEXT_STATUS: Partial<Record<AccountStatus, { label: string; next: AccountStatus }>> = {
  disabled: { label: '启用', next: 'probing' },
  online: { label: '停用', next: 'disabled' },
  busy: { label: '停用', next: 'disabled' },
  cooldown: { label: '停用', next: 'disabled' },
  error: { label: '停用', next: 'disabled' },
};

export function AccountsPage() {
  const { data, error, loading, reload } = useAsync(() => api.listAccounts());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; error: unknown } | null>(null);

  const runAction = (id: string, action: () => Promise<AccountView>) => {
    setBusyId(id);
    setRowError(null);
    action()
      .then(() => reload())
      .catch((err: unknown) => setRowError({ id, error: err }))
      .finally(() => setBusyId(null));
  };

  const handleDelete = (account: AccountView) => {
    if (!window.confirm(`确认删除账号「${account.display_name ?? account.email ?? account.id}」？此操作不可撤销。`)) {
      return;
    }
    setBusyId(account.id);
    api
      .deleteAccount(account.id)
      .then(() => reload())
      .catch((err: unknown) => setRowError({ id: account.id, error: err }))
      .finally(() => setBusyId(null));
  };

  return (
    <Layout title="Microsoft 账号" subtitle="账号池状态与生命周期管理">
      <div className="flex-between" style={{ marginBottom: 12 }}>
        <span className="text-muted">
          共 {data?.length ?? 0} 个账号。新增账号请前往{' '}
          <Link to="/accounts/add">添加账号</Link>。
        </span>
        <button type="button" className="btn btn-sm" onClick={reload}>
          刷新
        </button>
      </div>
      <AsyncSection
        loading={loading}
        error={error}
        data={data}
        onRetry={reload}
        isEmpty={(list) => list.length === 0}
        emptyTitle="还没有任何账号"
        emptyHint="前往「添加账号」发起 PKCE 授权流程。"
      >
        {(accounts) => (
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>账号</th>
                  <th>状态</th>
                  <th>刷新凭据</th>
                  <th>最近成功</th>
                  <th>连续失败</th>
                  <th>Token 过期</th>
                  <th>代理绑定</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => {
                  const action = NEXT_STATUS[account.status];
                  return (
                    <tr key={account.id}>
                      <td>
                        <div>{account.display_name ?? '（未命名）'}</div>
                        <div className="text-faint mono">{account.email ?? account.id}</div>
                      </td>
                      <td>
                        <AccountStatusBadge status={account.status} />
                      </td>
                      <td>
                        <BoolBadge value={account.has_refresh_token} trueLabel="有效" falseLabel="缺失" />
                      </td>
                      <td>{formatRelative(account.last_ok_at)}</td>
                      <td>{account.consecutive_failures}</td>
                      <td title={formatDateTime(account.token_expires_at)}>
                        {formatRelative(account.token_expires_at)}
                      </td>
                      <td>{account.proxy_id ?? <span className="text-faint">未绑定</span>}</td>
                      <td>
                        <div className="flex gap-8">
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busyId === account.id}
                            onClick={() => runAction(account.id, () => api.refreshAccount(account.id))}
                          >
                            刷新 Token
                          </button>
                          {action !== undefined && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={busyId === account.id}
                              onClick={() => runAction(account.id, () => api.setAccountStatus(account.id, action.next))}
                            >
                              {action.label}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            disabled={busyId === account.id}
                            onClick={() => handleDelete(account)}
                          >
                            删除
                          </button>
                        </div>
                        {rowError?.id === account.id && (
                          <div style={{ marginTop: 8, maxWidth: 320 }}>
                            <ErrorBanner error={rowError.error} />
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </AsyncSection>
    </Layout>
  );
}
