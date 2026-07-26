import { SettingsGroupPage } from '../components/SettingsGroupPage';

export function SchedulerSettingsPage() {
  return (
    <SettingsGroupPage
      title="调度"
      subtitle="后台清理任务的执行间隔与各类数据的保留时长（对应 /admin/settings 的 scheduler 分组，单位均为毫秒）"
      groups={[
        {
          group: 'scheduler',
          heading: '清理与保留策略',
          fields: [
            {
              key: 'cleanup_interval_ms',
              label: '清理任务执行间隔',
              kind: 'number',
              unit: 'ms',
              hint: '后台清理任务两次运行之间的间隔。',
            },
            {
              key: 'response_retention_ms',
              label: '响应记录保留时长',
              kind: 'number',
              unit: 'ms',
              hint: '超过此时长的历史请求/响应记录会被清理任务删除。',
            },
            {
              key: 'audit_log_retention_ms',
              label: '审计日志保留时长',
              kind: 'number',
              unit: 'ms',
            },
            {
              key: 'idempotency_retention_ms',
              label: '幂等键保留时长',
              kind: 'number',
              unit: 'ms',
              hint: '用于去重的幂等键记录保留时长，过期后允许同一个 key 重新使用。',
            },
            {
              key: 'files_retention_ms',
              label: '文件保留时长',
              kind: 'number',
              unit: 'ms',
              hint: '超过后由过期清理任务自动删除已上传文件。',
            },
            {
              key: 'files_upload_ttl_ms',
              label: '文件上传有效期',
              kind: 'number',
              unit: 'ms',
              hint: '文件上传后允许被引用的有效期，超时未被使用会被清理。',
            },
          ],
        },
      ]}
    />
  );
}
