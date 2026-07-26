import { SettingsGroupPage } from '../components/SettingsGroupPage';

export function SystemSettingsPage() {
  return (
    <SettingsGroupPage
      title="系统设置"
      subtitle="网络地址、工具调用限额与文件策略（对应 /admin/settings 的 network / tools / files 分组）"
      groups={[
        {
          group: 'network',
          heading: '网络',
          fields: [
            { key: 'public_api_base_url', label: '对外 API Base URL', kind: 'string', hint: '用于 WebUI 展示、Codex 配置生成、调用示例。' },
            { key: 'public_admin_url', label: '管理界面公开地址', kind: 'string' },
            { key: 'trust_proxy', label: '信任反向代理头', kind: 'boolean', hint: '启用后才信任 Forwarded / X-Forwarded-*。' },
            { key: 'http_proxy', label: 'HTTP 代理地址', kind: 'string', hint: '出站 HTTP 请求使用的代理，留空表示不使用。' },
            { key: 'https_proxy', label: 'HTTPS 代理地址', kind: 'string', hint: '出站 HTTPS 请求使用的代理，留空表示不使用。' },
            { key: 'no_proxy', label: '代理排除列表', kind: 'string', hint: '逗号分隔的主机名，命中的地址不走上面两个代理。' },
          ],
        },
        {
          group: 'tools',
          heading: '工具调用',
          fields: [
            {
              key: 'mode',
              label: '工具调用方式',
              kind: 'select',
              options: [
                { value: 'native', label: 'native（原生工具声明）' },
                { value: 'prompt', label: 'prompt（提示词模拟）' },
                { value: 'auto', label: 'auto（两条通道都上，默认）' },
              ],
            },
            { key: 'max_calls_per_round', label: '每轮最大调用数', kind: 'number' },
            { key: 'max_rounds', label: '最大轮次', kind: 'number' },
            { key: 'max_total_calls', label: '累计最大调用数', kind: 'number' },
            { key: 'max_result_bytes', label: '单次结果最大字节数', kind: 'number' },
            {
              key: 'max_arg_repairs',
              label: '参数修复最大次数',
              kind: 'number',
              min: 0,
              max: 2,
              hint: '协议规则封顶 2 次，界面上也限制在 0-2 之间，填更大的值服务端会拒绝。',
            },
            { key: 'allow_parallel', label: '允许并行工具调用', kind: 'boolean', hint: '同一轮内是否允许多个工具调用并发执行。' },
          ],
        },
        {
          group: 'files',
          heading: '文件',
          fields: [
            { key: 'max_file_bytes', label: '单文件最大字节数', kind: 'number' },
            { key: 'max_request_bytes', label: '单请求最大字节数', kind: 'number' },
            { key: 'max_total_bytes_per_key', label: '每个 API Key 累计最大字节数', kind: 'number', hint: '同一个 Key 名下所有未过期文件的总大小上限。' },
          ],
        },
      ]}
    />
  );
}
