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
                { value: 'debug', label: 'debug（记录更多请求信息，需手动改回）' },
              ],
              hint:
                '警告：服务端没有自动过期机制——切到 debug 后会无限期持续生效，不会自己恢复成 strict，' +
                '必须手动改回来才会停止。debug 模式会额外记录请求/响应内容的片段（最多约 200 个字符的样本），' +
                '虽然 Token、密码等凭据字段在任何模式下都会脱敏，但内容片段仍可能包含敏感信息。' +
                '仅在临时排障时短暂开启，排查完请立刻手动切回 strict，不要让它长期停留在 debug。',
            },
          ],
        },
      ]}
    />
  );
}
