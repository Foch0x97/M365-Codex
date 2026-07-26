import { useState, type FormEvent } from 'react';
import { api, type ApiKeyView, type CreateApiKeyRequest } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Layout } from '../components/Layout';
import { RevealApiKeyModal } from '../components/RevealApiKeyModal';
import { AsyncSection } from '../components/StateBlock';
import { BoolBadge } from '../components/StatusBadge';
import { useAsync } from '../hooks/useAsync';
import { formatDateTime } from '../util/format';

function CreateApiKeyForm({ onCreated }: { onCreated: (key: string) => void }) {
  const [name, setName] = useState('');
  const [rpmLimit, setRpmLimit] = useState('');
  const [dailyLimit, setDailyLimit] = useState('');
  const [maxConcurrency, setMaxConcurrency] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const toPositiveIntOrNull = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    const n = Number(trimmed);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const payload: CreateApiKeyRequest = {
      name: name.trim(),
      rpm_limit: toPositiveIntOrNull(rpmLimit),
      daily_limit: toPositiveIntOrNull(dailyLimit),
      max_concurrency: toPositiveIntOrNull(maxConcurrency),
    };
    api
      .createApiKey(payload)
      .then((created) => {
        onCreated(created.key);
        setName('');
        setRpmLimit('');
        setDailyLimit('');
        setMaxConcurrency('');
      })
      .catch((err: unknown) => setError(err))
      .finally(() => setSubmitting(false));
  };

  return (
    <form onSubmit={handleSubmit} className="card">
      <h2 style={{ marginTop: 0 }}>创建新的 API Key</h2>
      <div className="form-row">
        <div className="field">
          <label htmlFor="key-name">名称</label>
          <input id="key-name" type="text" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="key-rpm">每分钟限制</label>
          <input id="key-rpm" type="number" min={1} value={rpmLimit} onChange={(e) => setRpmLimit(e.target.value)} placeholder="不限" />
        </div>
        <div className="field">
          <label htmlFor="key-daily">每日限额</label>
          <input id="key-daily" type="number" min={1} value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} placeholder="不限" />
        </div>
        <div className="field">
          <label htmlFor="key-concurrency">最大并发</label>
          <input
            id="key-concurrency"
            type="number"
            min={1}
            value={maxConcurrency}
            onChange={(e) => setMaxConcurrency(e.target.value)}
            placeholder="不限"
          />
        </div>
      </div>
      {error !== null && (
        <div style={{ marginBottom: 12 }}>
          <ErrorBanner error={error} />
        </div>
      )}
      <button type="submit" className="btn btn-primary" disabled={submitting || name.trim().length === 0}>
        {submitting ? '创建中…' : '创建'}
      </button>
    </form>
  );
}

export function ApiKeysPage() {
  const { data, error, loading, reload } = useAsync(() => api.listApiKeys());
  const [revealKey, setRevealKey] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; error: unknown } | null>(null);

  const toggleEnabled = (key: ApiKeyView) => {
    setBusyId(key.id);
    setRowError(null);
    api
      .updateApiKey(key.id, { enabled: !key.enabled })
      .then(() => reload())
      .catch((err: unknown) => setRowError({ id: key.id, error: err }))
      .finally(() => setBusyId(null));
  };

  const handleRevoke = (key: ApiKeyView) => {
    if (!window.confirm(`确认撤销「${key.name}」？撤销后不可恢复。`)) return;
    setBusyId(key.id);
    setRowError(null);
    api
      .revokeApiKey(key.id)
      .then(() => reload())
      .catch((err: unknown) => setRowError({ id: key.id, error: err }))
      .finally(() => setBusyId(null));
  };

  return (
    <Layout title="API Key" subtitle="对外密钥的创建、限额与撤销">
      <CreateApiKeyForm
        onCreated={(key) => {
          setRevealKey(key);
          reload();
        }}
      />

      <AsyncSection
        loading={loading}
        error={error}
        data={data}
        onRetry={reload}
        isEmpty={(list) => list.length === 0}
        emptyTitle="还没有创建任何 API Key"
      >
        {(keys) => (
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>密钥</th>
                  <th>状态</th>
                  <th>限额</th>
                  <th>最近使用</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id}>
                    <td>{key.name}</td>
                    <td className="mono">{key.masked_key}</td>
                    <td>
                      <BoolBadge value={key.enabled} trueLabel="启用中" falseLabel={key.revoked_at !== null ? '已撤销' : '已停用'} />
                    </td>
                    <td className="text-muted">
                      {key.rpm_limit !== null ? `${key.rpm_limit}/分钟 · ` : ''}
                      {key.daily_limit !== null ? `${key.daily_limit}/天 · ` : ''}
                      {key.max_concurrency !== null ? `并发 ${key.max_concurrency}` : ''}
                      {key.rpm_limit === null && key.daily_limit === null && key.max_concurrency === null && '不限'}
                    </td>
                    <td>{formatDateTime(key.last_used_at)}</td>
                    <td>{formatDateTime(key.created_at)}</td>
                    <td>
                      <div className="flex gap-8">
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busyId === key.id || key.revoked_at !== null}
                          onClick={() => toggleEnabled(key)}
                        >
                          {key.enabled ? '停用' : '启用'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={busyId === key.id || key.revoked_at !== null}
                          onClick={() => handleRevoke(key)}
                        >
                          撤销
                        </button>
                      </div>
                      {rowError?.id === key.id && (
                        <div style={{ marginTop: 8, maxWidth: 320 }}>
                          <ErrorBanner error={rowError.error} />
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

      {revealKey !== null && <RevealApiKeyModal apiKey={revealKey} onClose={() => setRevealKey(null)} />}
    </Layout>
  );
}
