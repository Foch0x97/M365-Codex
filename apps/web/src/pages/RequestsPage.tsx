import { useState } from 'react';
import { Link } from 'react-router';
import { api, type ResponseStatus } from '../api';
import { Layout } from '../components/Layout';
import { AsyncSection } from '../components/StateBlock';
import { ResponseStatusBadge } from '../components/StatusBadge';
import { useAsync } from '../hooks/useAsync';
import { formatDateTime } from '../util/format';

const STATUS_OPTIONS: Array<{ value: ResponseStatus | ''; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'queued', label: '排队中' },
  { value: 'in_progress', label: '进行中' },
  { value: 'completed', label: '已完成' },
  { value: 'incomplete', label: '未完成' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
];

/** 不含提示词与输出正文——隐私模式 strict 下服务端本来就不留，这里只展示元数据。 */
export function RequestsPage() {
  const [status, setStatus] = useState<ResponseStatus | ''>('');
  const [limit, setLimit] = useState(50);
  const { data, error, loading, reload } = useAsync(
    () => api.listRequests({ limit, status: status || undefined }),
    [status, limit],
  );

  return (
    <Layout title="请求" subtitle="请求记录（不含提示词与输出正文）">
      <div className="card">
        <div className="form-row">
          <div className="field">
            <label htmlFor="req-status">状态筛选</label>
            <select id="req-status" value={status} onChange={(e) => setStatus(e.target.value as ResponseStatus | '')}>
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="req-limit">显示条数</label>
            <input
              id="req-limit"
              type="number"
              min={1}
              max={500}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value) || 50)}
            />
          </div>
        </div>
      </div>

      <AsyncSection
        loading={loading}
        error={error}
        data={data}
        onRetry={reload}
        isEmpty={(res) => res.items.length === 0}
        emptyTitle="没有符合条件的请求"
      >
        {(res) => (
          <div className="card table-wrap">
            <div className="text-muted" style={{ marginBottom: 10 }}>
              共 {res.total} 条，当前显示 {res.items.length} 条
            </div>
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>状态</th>
                  <th>模型</th>
                  <th>推理强度</th>
                  <th>账号</th>
                  <th>工具轮次 / 累计调用</th>
                  <th>创建时间</th>
                  <th>错误</th>
                </tr>
              </thead>
              <tbody>
                {res.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Link to={`/requests/${item.id}`} className="mono">
                        {item.id}
                      </Link>
                    </td>
                    <td>
                      <ResponseStatusBadge status={item.status} />
                    </td>
                    <td>{item.requested_model}</td>
                    <td>{item.requested_reasoning_effort ?? '—'}</td>
                    <td className="mono text-faint">{item.account_id ?? '—'}</td>
                    <td>
                      {item.tool_round} / {item.tool_calls_total}
                    </td>
                    <td>{formatDateTime(item.created_at)}</td>
                    <td className="text-danger">{item.error_message ?? ''}</td>
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
