import { api } from '../api';
import { Layout } from '../components/Layout';
import { AsyncSection } from '../components/StateBlock';
import { CapabilityStatusBadge } from '../components/StatusBadge';
import { useAsync } from '../hooks/useAsync';

export function CapabilitiesPage() {
  const { data, error, loading, reload } = useAsync(() => api.getCapabilities());

  return (
    <Layout title="模型与能力" subtitle="model 与 reasoning.effort 原样透传，这里只做记录与如实上报">
      <AsyncSection loading={loading} error={error} data={data} onRetry={reload}>
        {(caps) => (
          <>
            <div className="card">
              <h2 style={{ marginTop: 0 }}>观测到的模型</h2>
              <p className="text-muted">
                本项目不造模型别名——这里列出的是曾经被请求过、如实记录下来的 <code>model</code> 取值，
                不代表本项目对其做了任何校验或改写。
              </p>
              <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
                {caps.models.map((m) => (
                  <span key={m.id} className="badge badge-info mono">
                    {m.id}（{m.source}）
                  </span>
                ))}
                {caps.models.length === 0 && <span className="text-faint">尚未观测到任何请求</span>}
              </div>
            </div>

            <div className="card table-wrap">
              <h2 style={{ marginTop: 0 }}>能力矩阵</h2>
              <p className="text-muted">
                未经 M0 探针确认的能力一律标 <code>upstream_decided</code> 或 <code>unsupported</code>，
                不会标成 <code>native</code>。
              </p>
              <table>
                <thead>
                  <tr>
                    <th>能力</th>
                    <th>状态</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {caps.matrix.map((row) => (
                    <tr key={row.feature}>
                      <td className="mono">{row.feature}</td>
                      <td>
                        <CapabilityStatusBadge status={row.status} />
                      </td>
                      <td className="text-muted">{row.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </AsyncSection>
    </Layout>
  );
}
