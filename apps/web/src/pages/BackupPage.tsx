import { useState, type ChangeEvent, type FormEvent } from 'react';
import { api, type BackupInfo, type DiagnosticsReport, type RestoreResult } from '../api';
import { CopyButton } from '../components/CopyButton';
import { ErrorBanner } from '../components/ErrorBanner';
import { Layout } from '../components/Layout';
import { AsyncSection } from '../components/StateBlock';
import { useAsync } from '../hooks/useAsync';
import { formatBytes, formatDateTime } from '../util/format';

/**
 * 备份 / 恢复 / 诊断，对应服务端 apps/server/src/routes/backup.ts：
 *   POST /admin/backup、GET /admin/backup、GET /admin/backup/:id/download、
 *   POST /admin/restore、GET /admin/diagnostics。
 *
 * 恢复的语义必须如实传达：服务端只做「校验 + 落盘」，正在运行的进程仍持有旧库连接，
 * 界面上任何地方都不能暗示恢复完成即已生效——上传成功后必须重启服务。
 */

/** 触发浏览器下载一个内存中的 Blob；用完立即释放 object URL，不常驻。 */
function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function CreateBackupCard({ onCreated }: { onCreated: (info: BackupInfo) => void }) {
  const [includeFiles, setIncludeFiles] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const handleCreate = () => {
    setCreating(true);
    setError(null);
    api
      .createBackup({ includeFiles })
      .then((info) => onCreated(info))
      .catch((err: unknown) => setError(err))
      .finally(() => setCreating(false));
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>生成备份</h2>
      <div className="field">
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={includeFiles}
            onChange={(e) => setIncludeFiles(e.target.checked)}
          />
          包含已上传文件
        </label>
        <span className="field-hint">
          备份始终包含数据库快照（VACUUM INTO 生成的一致性快照）；勾选后额外打包 <code>files/</code>{' '}
          目录下的原始上传文件。主密钥不会写入备份包——换机器恢复时仍需提供同一个{' '}
          <code>M365_CODEX_MASTER_KEY</code>。
        </span>
      </div>
      {error !== null && (
        <div style={{ marginBottom: 12 }}>
          <ErrorBanner error={error} />
        </div>
      )}
      <button type="button" className="btn btn-primary" onClick={handleCreate} disabled={creating}>
        {creating ? '生成中…' : '生成备份'}
      </button>
    </div>
  );
}

function BackupListCard({ refreshKey }: { refreshKey: number }) {
  const { data, error, loading, reload } = useAsync(() => api.listBackups(), [refreshKey]);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<{ id: string; error: unknown } | null>(null);

  const handleDownload = (backup: BackupInfo) => {
    setDownloadingId(backup.id);
    setDownloadError(null);
    api
      .downloadBackup(backup.id)
      .then((blob) => triggerBlobDownload(blob, `${backup.id}.tar.gz`))
      .catch((err: unknown) => setDownloadError({ id: backup.id, error: err }))
      .finally(() => setDownloadingId(null));
  };

  return (
    <div className="card table-wrap">
      <div className="flex-between" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>备份列表</h2>
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
        emptyTitle="还没有生成过任何备份"
      >
        {(backups) => (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>大小</th>
                <th>生成时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((backup) => (
                <tr key={backup.id}>
                  <td className="mono">{backup.id}</td>
                  <td>{formatBytes(backup.bytes)}</td>
                  <td>{formatDateTime(backup.created_at)}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={downloadingId === backup.id}
                      onClick={() => handleDownload(backup)}
                    >
                      {downloadingId === backup.id ? '下载中…' : '下载'}
                    </button>
                    {downloadError?.id === backup.id && (
                      <div style={{ marginTop: 8, maxWidth: 280 }}>
                        <ErrorBanner error={downloadError.error} />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </AsyncSection>
    </div>
  );
}

function RestoreCard() {
  const [file, setFile] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setFile(event.target.files?.[0] ?? null);
    setResult(null);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (file === null) return;
    if (
      !window.confirm(
        '即将上传备份包并覆盖当前数据库（文件目录视备份内容而定）。\n' +
          '校验通过只代表已经写入磁盘，绝不代表当前正在运行的服务已经切换到新数据——\n' +
          '必须在恢复后手动重启服务，重启前服务仍按旧数据运行。确认继续？',
      )
    ) {
      return;
    }
    setRestoring(true);
    setError(null);
    setResult(null);
    api
      .restoreBackup(file)
      .then((res) => setResult(res))
      .catch((err: unknown) => setError(err))
      .finally(() => setRestoring(false));
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>从备份恢复</h2>
      <div className="error-banner" style={{ marginBottom: 12 }}>
        <div className="error-title">恢复不会立即生效</div>
        <div>
          上传的备份包会先做格式与版本校验，通过后写入数据目录；但当前正在运行的进程仍持有旧数据库的连接，
          <strong>必须手动重启服务后，恢复的数据才会真正生效</strong>。重启之前，服务表现如同什么都没发生过。
        </div>
      </div>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="restore-file">备份包文件（.tar.gz）</label>
          <input id="restore-file" type="file" accept=".gz,.tar.gz" onChange={handleFileChange} />
        </div>
        {error !== null && (
          <div style={{ marginBottom: 12 }}>
            <ErrorBanner error={error} />
          </div>
        )}
        <button type="submit" className="btn btn-danger" disabled={restoring || file === null}>
          {restoring ? '上传并校验中…' : '上传并恢复'}
        </button>
      </form>
      {result !== null && (
        <div className="error-banner" style={{ marginTop: 14 }}>
          <div className="error-title">
            <span className="badge badge-warn" style={{ marginRight: 8 }}>
              需要重启才会生效
            </span>
            备份已写入数据目录
          </div>
          <div>{result.message}</div>
          <div className="text-muted" style={{ marginTop: 8 }}>
            备份生成于 {formatDateTime(result.manifest.created_at)} · schema v{result.manifest.schema_version} ·
            {result.manifest.includes_files
              ? ` 含 ${result.manifest.file_count} 个文件`
              : ' 不含上传文件'}
          </div>
        </div>
      )}
    </div>
  );
}

function DiagnosticsCard() {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const handleGenerate = () => {
    setLoading(true);
    setError(null);
    api
      .getDiagnostics()
      .then((res) => setReport(res))
      .catch((err: unknown) => setError(err))
      .finally(() => setLoading(false));
  };

  const handleDownloadJson = () => {
    if (report === null) return;
    triggerBlobDownload(
      new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
      `diagnostics-${report.generated_at}.json`,
    );
  };

  return (
    <div className="card">
      <div className="flex-between" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>诊断包</h2>
        <div className="flex gap-8">
          {report !== null && (
            <button type="button" className="btn btn-sm" onClick={handleDownloadJson}>
              下载 JSON
            </button>
          )}
          <button type="button" className="btn btn-sm btn-primary" onClick={handleGenerate} disabled={loading}>
            {loading ? '生成中…' : '生成诊断包'}
          </button>
        </div>
      </div>
      <div className="field-hint" style={{ marginBottom: 12 }}>
        只汇总结构化计数与脱敏后的配置摘要，不含提示词、输出正文、邮箱、Token 或文件名，可以放心随报障工单一起提供。
      </div>
      {error !== null && (
        <div style={{ marginBottom: 12 }}>
          <ErrorBanner error={error} />
        </div>
      )}
      {report !== null && (
        <div className="grid grid-cols-2">
          <div>
            <div className="stat-label">系统状态</div>
            <div>{report.system_status}</div>
          </div>
          <div>
            <div className="stat-label">运行时长</div>
            <div>{Math.round(report.uptime_ms / 60_000)} 分钟</div>
          </div>
          <div>
            <div className="stat-label">数据库结构版本</div>
            <div>
              v{report.schema.current}（期望 v{report.schema.expected}）{report.schema.ok ? '' : ' · 不一致'}
            </div>
          </div>
          <div>
            <div className="stat-label">存储占用</div>
            <div>
              数据库 {formatBytes(report.storage.db_bytes)} · 文件 {formatBytes(report.storage.files_bytes)}（
              {report.storage.file_count} 个）
            </div>
          </div>
          <div>
            <div className="stat-label">可用账号</div>
            <div>{report.accounts_usable}</div>
          </div>
          <div>
            <div className="stat-label">进行中请求</div>
            <div>{report.in_flight_requests}</div>
          </div>
          {report.notes.length > 0 && (
            <div style={{ gridColumn: '1 / -1' }}>
              <div className="stat-label">备注</div>
              <ul>
                {report.notes.map((note) => (
                  <li key={note} className="text-muted">
                    {note}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function BackupPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [lastCreated, setLastCreated] = useState<BackupInfo | null>(null);

  const handleCreated = (info: BackupInfo) => {
    setLastCreated(info);
    setRefreshKey((k) => k + 1);
  };

  return (
    <Layout title="备份与恢复" subtitle="数据库与文件备份、恢复、诊断包导出">
      <div className="grid grid-cols-2">
        <CreateBackupCard onCreated={handleCreated} />
        <div className="card">
          <h2 style={{ marginTop: 0 }}>最近一次生成</h2>
          {lastCreated === null ? (
            <div className="text-muted">尚未在本次会话生成过备份。</div>
          ) : (
            <div>
              <div className="flex gap-8" style={{ alignItems: 'center' }}>
                <span className="mono">{lastCreated.id}</span>
                <CopyButton value={lastCreated.id} label="复制 ID" />
              </div>
              <div className="text-muted" style={{ marginTop: 6 }}>
                {formatBytes(lastCreated.bytes)} · {formatDateTime(lastCreated.created_at)}
              </div>
            </div>
          )}
        </div>
      </div>

      <BackupListCard refreshKey={refreshKey} />
      <RestoreCard />
      <DiagnosticsCard />
    </Layout>
  );
}
