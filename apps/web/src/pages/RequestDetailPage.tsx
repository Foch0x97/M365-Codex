import { useParams } from 'react-router';
import { api } from '../api';
import { Layout } from '../components/Layout';
import { AsyncSection } from '../components/StateBlock';
import { ResponseStatusBadge } from '../components/StatusBadge';
import { useAsync } from '../hooks/useAsync';
import { formatDateTime } from '../util/format';

export function RequestDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useAsync(() => api.getRequest(id), [id]);

  return (
    <Layout title="请求详情" subtitle={id}>
      <AsyncSection loading={loading} error={error} data={data} onRetry={reload}>
        {(detail) => (
          <>
            <div className="card">
              <div className="grid grid-cols-3">
                <div>
                  <div className="stat-label">状态</div>
                  <ResponseStatusBadge status={detail.status} />
                </div>
                <div>
                  <div className="stat-label">模型</div>
                  <div>{detail.requested_model}</div>
                </div>
                <div>
                  <div className="stat-label">推理强度</div>
                  <div>{detail.requested_reasoning_effort ?? '—'}</div>
                </div>
                <div>
                  <div className="stat-label">API Key</div>
                  <div className="mono">{detail.api_key_id ?? '—'}</div>
                </div>
                <div>
                  <div className="stat-label">账号</div>
                  <div className="mono">{detail.account_id ?? '—'}</div>
                </div>
                <div>
                  <div className="stat-label">工具轮次 / 累计调用</div>
                  <div>
                    {detail.tool_round} / {detail.tool_calls_total}
                  </div>
                </div>
                <div>
                  <div className="stat-label">创建时间</div>
                  <div>{formatDateTime(detail.created_at)}</div>
                </div>
                <div>
                  <div className="stat-label">更新时间</div>
                  <div>{formatDateTime(detail.updated_at)}</div>
                </div>
              </div>
              {detail.error_message !== null && (
                <div className="error-banner" style={{ marginTop: 16 }}>
                  <div className="error-title">错误信息</div>
                  <div>{detail.error_message}</div>
                </div>
              )}
            </div>

            <div className="card">
              <h2 style={{ marginTop: 0 }}>工具调用（不含参数与结果正文）</h2>
              {detail.tool_calls.length === 0 ? (
                <div className="text-muted">这条请求没有发生工具调用。</div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>call_id</th>
                        <th>名称</th>
                        <th>状态</th>
                        <th>副作用</th>
                        <th>时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.tool_calls.map((call) => (
                        <tr key={call.call_id}>
                          <td className="mono">{call.call_id}</td>
                          <td>{call.name}</td>
                          <td>{call.status}</td>
                          <td>{call.side_effect ? '是' : '否'}</td>
                          <td>{formatDateTime(call.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </AsyncSection>
    </Layout>
  );
}
