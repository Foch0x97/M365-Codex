import { useState } from 'react';
import { api } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Layout } from '../components/Layout';
import { AsyncSection } from '../components/StateBlock';
import { useAsync } from '../hooks/useAsync';
import { formatBytes, formatDateTime } from '../util/format';

export function FilesPage() {
  const { data, error, loading, reload } = useAsync(() => api.listFiles({}));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; error: unknown } | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<{ deleted: number; freed_bytes: number } | null>(null);
  const [cleanupError, setCleanupError] = useState<unknown>(null);

  const handleDelete = (id: string, filename: string) => {
    if (!window.confirm(`确认删除文件「${filename}」？`)) return;
    setBusyId(id);
    setRowError(null);
    api
      .deleteFile(id)
      .then(() => reload())
      .catch((err: unknown) => setRowError({ id, error: err }))
      .finally(() => setBusyId(null));
  };

  const handleCleanup = () => {
    setCleaning(true);
    setCleanupError(null);
    api
      .cleanupFiles()
      .then((res) => {
        setCleanupResult(res);
        reload();
      })
      .catch((err: unknown) => setCleanupError(err))
      .finally(() => setCleaning(false));
  };

  return (
    <Layout title="文件" subtitle="已上传文件的管理视角（Files / Uploads / 图片 / PDF / Office 提取产物）">
      <div className="card flex-between">
        <div>
          <div className="stat-label">立即执行一次过期清理</div>
          {cleanupResult !== null && (
            <div className="text-muted">
              上次清理删除 {cleanupResult.deleted} 个文件，释放 {formatBytes(cleanupResult.freed_bytes)}
            </div>
          )}
          {cleanupError !== null && <ErrorBanner error={cleanupError} />}
        </div>
        <button type="button" className="btn" onClick={handleCleanup} disabled={cleaning}>
          {cleaning ? '清理中…' : '立即清理'}
        </button>
      </div>

      <AsyncSection
        loading={loading}
        error={error}
        data={data}
        onRetry={reload}
        isEmpty={(res) => res.items.length === 0}
        emptyTitle="还没有任何文件"
      >
        {(res) => (
          <div className="card table-wrap">
            <div className="text-muted" style={{ marginBottom: 10 }}>
              共 {res.items.length} 个文件，合计占用 {formatBytes(res.total_bytes)}
            </div>
            <table>
              <thead>
                <tr>
                  <th>文件名</th>
                  <th>类型</th>
                  <th>大小</th>
                  <th>状态</th>
                  <th>归属 Key</th>
                  <th>创建时间</th>
                  <th>过期时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {res.items.map((file) => (
                  <tr key={file.id}>
                    <td>{file.filename}</td>
                    <td className="text-muted">
                      {file.kind} · {file.mime_type}
                    </td>
                    <td>{formatBytes(file.bytes)}</td>
                    <td>{file.status}</td>
                    <td className="mono text-faint">{file.api_key_id ?? '—'}</td>
                    <td>{formatDateTime(file.created_at)}</td>
                    <td>{formatDateTime(file.expires_at)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={busyId === file.id}
                        onClick={() => handleDelete(file.id, file.filename)}
                      >
                        删除
                      </button>
                      {rowError?.id === file.id && (
                        <div style={{ marginTop: 8, maxWidth: 280 }}>
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
    </Layout>
  );
}
