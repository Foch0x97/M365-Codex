import { api } from '../api';
import { CopyButton } from '../components/CopyButton';
import { Layout } from '../components/Layout';
import { AsyncSection } from '../components/StateBlock';
import { SystemStatusBadge } from '../components/StatusBadge';
import { useAsync } from '../hooks/useAsync';
import { formatBytes, formatDuration, formatPercent } from '../util/format';

export function OverviewPage() {
  const { data, error, loading, reload } = useAsync(() => api.getOverview());

  return (
    <Layout title="概览" subtitle="服务整体状态一览，数据来自 /admin/overview">
      <AsyncSection loading={loading} error={error} data={data} onRetry={reload}>
        {(overview) => (
          <>
            <div className="card">
              <div className="flex-between">
                <div className="flex gap-12" style={{ alignItems: 'center' }}>
                  <SystemStatusBadge status={overview.system_status} />
                  <span className="text-muted">版本 {overview.version}</span>
                  <span className="text-muted">已运行 {formatDuration(overview.uptime_ms)}</span>
                </div>
                <button type="button" className="btn btn-sm" onClick={reload}>
                  刷新
                </button>
              </div>
            </div>

            <div className="grid grid-cols-4" style={{ marginTop: 16 }}>
              <div className="card stat-tile">
                <span className="stat-label">在线账号 / 总数</span>
                <span className="stat-value">
                  {overview.accounts.online} / {overview.accounts.total}
                </span>
                <span className="stat-hint">
                  冷却 {overview.accounts.cooldown} · 需重新授权 {overview.accounts.reauth_required} · 已停用{' '}
                  {overview.accounts.disabled}
                </span>
              </div>
              <div className="card stat-tile">
                <span className="stat-label">当前请求</span>
                <span className="stat-value">{overview.requests.in_flight}</span>
                <span className="stat-hint">
                  近 1 小时 {overview.requests.last_hour} 次，失败 {overview.requests.failed_last_hour} 次
                </span>
              </div>
              <div className="card stat-tile">
                <span className="stat-label">工具调用成功率</span>
                <span className="stat-value">{formatPercent(overview.tools.arg_pass_rate)}</span>
                <span className="stat-hint">近 1 小时调用 {overview.tools.calls_last_hour} 次</span>
              </div>
              <div className="card stat-tile">
                <span className="stat-label">上游协议版本</span>
                <span className="stat-value" style={{ fontSize: 16 }}>
                  {overview.upstream.protocol_version}
                </span>
                <span className="stat-hint">
                  {overview.upstream.ws_base} · 图片输入{overview.upstream.image_input ? '已启用' : '未启用'}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-3" style={{ marginTop: 16 }}>
              <div className="card stat-tile">
                <span className="stat-label">数据库占用</span>
                <span className="stat-value" style={{ fontSize: 18 }}>
                  {formatBytes(overview.storage.db_bytes)}
                </span>
              </div>
              <div className="card stat-tile">
                <span className="stat-label">文件占用</span>
                <span className="stat-value" style={{ fontSize: 18 }}>
                  {formatBytes(overview.storage.files_bytes)}
                </span>
                <span className="stat-hint">共 {overview.storage.files_count} 个文件</span>
              </div>
              <div className="card stat-tile">
                <span className="stat-label">Token 刷新状态</span>
                <span className="stat-value" style={{ fontSize: 18 }}>
                  {overview.accounts.reauth_required > 0 ? '有账号待处理' : '正常'}
                </span>
                <span className="stat-hint">
                  {overview.accounts.reauth_required > 0
                    ? `${overview.accounts.reauth_required} 个账号需要重新授权`
                    : '所有账号刷新凭据有效'}
                </span>
              </div>
            </div>

            <div className="card" style={{ marginTop: 16 }}>
              <div className="flex-between">
                <div>
                  <div className="stat-label">当前公开 API 地址</div>
                  <div className="mono" style={{ marginTop: 6 }}>
                    {overview.public_api_base_url}
                  </div>
                </div>
                <CopyButton value={overview.public_api_base_url} />
              </div>
            </div>

            {overview.pending_restart.length > 0 && (
              <div className="card" style={{ marginTop: 16 }}>
                <div className="stat-label" style={{ marginBottom: 8 }}>
                  待重启才能生效的配置项
                </div>
                <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
                  {overview.pending_restart.map((key) => (
                    <span key={key} className="badge badge-warn">
                      {key}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </AsyncSection>
    </Layout>
  );
}
