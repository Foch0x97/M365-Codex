import { SettingsGroupPage } from '../components/SettingsGroupPage';

export function LoggingSettingsPage() {
  return (
    <SettingsGroupPage
      title="日志"
      subtitle="日志级别与隐私模式（对应 /admin/settings 的 logging 分组）"
      groups={[
        {
          group: 'logging',
          heading: '日志',
          fields: [
            {
              key: 'log_level',
              label: '日志级别',
              kind: 'select',
              options: [
                { value: 'fatal', label: 'fatal' },
                { value: 'error', label: 'error' },
                { value: 'warn', label: 'warn' },
                { value: 'info', label: 'info（默认）' },
                { value: 'debug', label: 'debug' },
                { value: 'trace', label: 'trace' },
                { value: 'silent', label: 'silent（不输出日志）' },
              ],
              hint: '全设置项里唯一无需重启即可生效的一项，保存后立即改变日志输出级别。',
            },
            {
              key: 'log_privacy_mode',
              label: '隐私模式',
              kind: 'select',
              options: [
                { value: 'strict', label: 'strict（默认，不存提示词/输出/上传/认证）' },
                { value: 'metadata', label: 'metadata（仅结构化元数据）' },
                { value: 'debug', label: 'debug（临时排障，会自动过期恢复 strict）' },
              ],
              hint: '切到 debug 即便如此也不会记录 Token 与完整认证 Header；到期自动恢复 strict 并写入审计日志。',
            },
          ],
        },
      ]}
    />
  );
}
