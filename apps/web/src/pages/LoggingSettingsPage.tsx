import { SettingsGroupPage } from '../components/SettingsGroupPage';

export function LoggingSettingsPage() {
  return (
    <SettingsGroupPage
      title="日志"
      subtitle="日志隐私模式（对应 /admin/settings 的 logging 分组）"
      groups={[
        {
          group: 'logging',
          heading: '隐私模式',
          fields: [
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
            {
              key: 'debug_expires_at',
              label: 'debug 模式过期时间',
              kind: 'string',
              hint: '只读展示：切换到 debug 后由服务端自动设置，不支持手动填写。',
            },
          ],
        },
      ]}
    />
  );
}
