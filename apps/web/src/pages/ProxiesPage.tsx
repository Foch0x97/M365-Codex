import { useState, type FormEvent } from 'react';
import { api, type ProxyView } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Layout } from '../components/Layout';
import { AsyncSection } from '../components/StateBlock';
import { ProxyStatusBadge } from '../components/StatusBadge';
import { useAsync } from '../hooks/useAsync';
import { formatDateTime } from '../util/format';

/**
 * 出口代理池。地址一律以打码形态展示（`url_masked`，用户名密码永不明文出现在 DOM 里）——
 * 创建表单里用户会输入一次完整地址提交给服务端，但提交后本页面只再渲染服务端返回的打码结果。
 */
function CreateProxyForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [weight, setWeight] = useState(10);
  const [priority, setPriority] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    api
      .createProxy({ name: name.trim(), url: url.trim(), weight, priority, enabled: true })
      .then(() => {
        setName('');
        setUrl('');
        onCreated();
      })
      .catch((err: unknown) => setError(err))
      .finally(() => setSubmitting(false));
  };

  return (
    <form onSubmit={handleSubmit} className="card">
      <h2 style={{ marginTop: 0 }}>新增代理节点</h2>
      <div className="form-row">
        <div className="field">
          <label htmlFor="proxy-name">名称</label>
          <input id="proxy-name" type="text" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="field" style={{ flex: '2 1 320px' }}>
          <label htmlFor="proxy-url">地址</label>
          <input
            id="proxy-url"
            type="text"
            placeholder="socks5://user:pass@1.2.3.4:1080"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoComplete="off"
            required
          />
          <span className="field-hint">提交后立即打码展示，明文不会再出现在页面上。</span>
        </div>
        <div className="field">
          <label htmlFor="proxy-weight">权重</label>
          <input id="proxy-weight" type="number" min={1} value={weight} onChange={(e) => setWeight(Number(e.target.value) || 1)} />
        </div>
        <div className="field">
          <label htmlFor="proxy-priority">优先级</label>
          <input id="proxy-priority" type="number" min={1} value={priority} onChange={(e) => setPriority(Number(e.target.value) || 1)} />
        </div>
      </div>
      {error !== null && (
        <div style={{ marginBottom: 12 }}>
          <ErrorBanner error={error} />
        </div>
      )}
      <button type="submit" className="btn btn-primary" disabled={submitting || name.trim().length === 0 || url.trim().length === 0}>
        {submitting ? '创建中…' : '创建'}
      </button>
    </form>
  );
}

function BulkImportForm({ onImported }: { onImported: () => void }) {
  const [urls, setUrls] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ succeeded: number; failed: number } | null>(null);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    api
      .bulkImportProxies({ urls })
      .then((res) => {
        setResult({ succeeded: res.succeeded, failed: res.failed });
        setUrls('');
        onImported();
      })
      .catch((err: unknown) => setError(err))
      .finally(() => setSubmitting(false));
  };

  return (
    <form onSubmit={handleSubmit} className="card">
      <h2 style={{ marginTop: 0 }}>多行批量导入</h2>
      <div className="field">
        <label htmlFor="proxy-bulk">每行一个地址</label>
        <textarea
          id="proxy-bulk"
          value={urls}
          onChange={(e) => setUrls(e.target.value)}
          placeholder={'http://user:pass@1.2.3.4:8080\nsocks5://user:pass@5.6.7.8:1080'}
        />
      </div>
      {error !== null && (
        <div style={{ marginBottom: 12 }}>
          <ErrorBanner error={error} />
        </div>
      )}
      {result !== null && (
        <div className="text-muted" style={{ marginBottom: 12 }}>
          成功 {result.succeeded} 条，失败 {result.failed} 条
        </div>
      )}
      <button type="submit" className="btn" disabled={submitting || urls.trim().length === 0}>
        {submitting ? '导入中…' : '批量导入'}
      </button>
    </form>
  );
}

export function ProxiesPage() {
  const { data, error, loading, reload } = useAsync(() => api.listProxies());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<{ id: string; ok: boolean; latency_ms: number | null; detail: string } | null>(null);
  const [rowError, setRowError] = useState<{ id: string; error: unknown } | null>(null);

  const handleCheck = (proxy: ProxyView) => {
    setBusyId(proxy.id);
    setRowError(null);
    setCheckResult(null);
    api
      .checkProxy(proxy.id)
      .then((res) => {
        setCheckResult({ id: proxy.id, ...res });
        reload();
      })
      .catch((err: unknown) => setRowError({ id: proxy.id, error: err }))
      .finally(() => setBusyId(null));
  };

  const handleToggle = (proxy: ProxyView) => {
    setBusyId(proxy.id);
    setRowError(null);
    api
      .updateProxy(proxy.id, { enabled: !proxy.enabled })
      .then(() => reload())
      .catch((err: unknown) => setRowError({ id: proxy.id, error: err }))
      .finally(() => setBusyId(null));
  };

  const handleDelete = (proxy: ProxyView) => {
    if (!window.confirm(`确认删除代理节点「${proxy.name}」？`)) return;
    setBusyId(proxy.id);
    setRowError(null);
    api
      .deleteProxy(proxy.id)
      .then(() => reload())
      .catch((err: unknown) => setRowError({ id: proxy.id, error: err }))
      .finally(() => setBusyId(null));
  };

  return (
    <Layout title="代理池" subtitle="出口代理节点管理，地址一律打码展示">
      <div className="grid grid-cols-2">
        <CreateProxyForm onCreated={reload} />
        <BulkImportForm onImported={reload} />
      </div>

      <AsyncSection
        loading={loading}
        error={error}
        data={data}
        onRetry={reload}
        isEmpty={(list) => list.length === 0}
        emptyTitle="还没有配置任何代理节点"
      >
        {(proxies) => (
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>地址（已打码）</th>
                  <th>状态</th>
                  <th>权重 / 优先级</th>
                  <th>延迟</th>
                  <th>绑定账号</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {proxies.map((proxy) => (
                  <tr key={proxy.id}>
                    <td>{proxy.name}</td>
                    <td className="mono">{proxy.url_masked}</td>
                    <td>
                      <ProxyStatusBadge status={proxy.enabled ? proxy.status : 'unknown'} />
                      {!proxy.enabled && <span className="badge badge-neutral" style={{ marginLeft: 6 }}>已停用</span>}
                    </td>
                    <td>
                      {proxy.weight} / {proxy.priority}
                    </td>
                    <td>{proxy.latency_ms !== null ? `${proxy.latency_ms} ms` : '—'}</td>
                    <td className="text-faint">{proxy.bound_accounts.length > 0 ? proxy.bound_accounts.join(', ') : '未绑定'}</td>
                    <td>
                      <div className="flex gap-8">
                        <button type="button" className="btn btn-sm" disabled={busyId === proxy.id} onClick={() => handleCheck(proxy)}>
                          健康检查
                        </button>
                        <button type="button" className="btn btn-sm" disabled={busyId === proxy.id} onClick={() => handleToggle(proxy)}>
                          {proxy.enabled ? '停用' : '启用'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={busyId === proxy.id}
                          onClick={() => handleDelete(proxy)}
                        >
                          删除
                        </button>
                      </div>
                      {checkResult?.id === proxy.id && (
                        <div className="text-muted" style={{ marginTop: 6 }}>
                          {checkResult.ok ? '连通正常' : '连通失败'}
                          {checkResult.latency_ms !== null ? ` · ${checkResult.latency_ms} ms` : ''} · {checkResult.detail}
                        </div>
                      )}
                      {rowError?.id === proxy.id && (
                        <div style={{ marginTop: 8, maxWidth: 280 }}>
                          <ErrorBanner error={rowError.error} />
                        </div>
                      )}
                      {proxy.last_check_at !== null && (
                        <div className="text-faint" style={{ marginTop: 4 }}>
                          上次检查 {formatDateTime(proxy.last_check_at)}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AsyncSection>
    </Layout>
  );
}
