import { Layout } from '../components/Layout';

/**
 * 备份与恢复对应的接口（/admin/backup、/admin/restore、/admin/diagnostics、/metrics）
 * 属于 M8「迁移/备份/可观测」范围，本轮（M7）尚未实现，这里如实标注，不假装能用。
 */
export function BackupPage() {
  return (
    <Layout title="备份与恢复" subtitle="数据库与文件备份、诊断包导出">
      <div className="card state-block">
        <div className="state-title">属于 M8 里程碑</div>
        <div>
          <code>/admin/backup</code>、<code>/admin/restore</code>、<code>/admin/diagnostics</code>{' '}
          在实施计划里排在 M8（迁移/备份/可观测），本轮 M7 只交付 WebUI 骨架，这个页面等服务端接口落地后再接。
        </div>
      </div>
    </Layout>
  );
}
