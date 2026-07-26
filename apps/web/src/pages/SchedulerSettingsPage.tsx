import { SettingsGroupPage } from '../components/SettingsGroupPage';

export function SchedulerSettingsPage() {
  return (
    <SettingsGroupPage
      title="调度"
      subtitle="账号池调度与重试策略（对应 /admin/settings 的 scheduler 分组）"
      groups={[
        {
          group: 'scheduler',
          heading: '调度策略',
          fields: [
            {
              key: 'sticky_account',
              label: '会话粘性绑定',
              kind: 'boolean',
              hint: '优先复用同一账号，避免 WebSocket 长连接频繁切换出口。',
            },
            { key: 'retry_limit', label: '切换账号的最大重试次数', kind: 'number' },
            { key: 'cooldown_seconds', label: '默认冷却时长（秒）', kind: 'number' },
          ],
        },
      ]}
    />
  );
}
