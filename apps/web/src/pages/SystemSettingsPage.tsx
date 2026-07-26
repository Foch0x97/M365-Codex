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
            { key: 'port', label: '监听端口', kind: 'number' },
            { key: 'data_dir', label: '数据目录', kind: 'string' },
          ],
        },
        {
          group: 'tools',
          heading: '工具调用',
          fields: [
            {
              key: 'tools_mode',
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
            { key: 'max_calls_total', label: '累计最大调用数', kind: 'number' },
            { key: 'max_result_bytes', label: '单次结果最大字节数', kind: 'number' },
            { key: 'max_repair_attempts', label: '参数修复最大次数', kind: 'number', hint: '上限锁死为 2，即使这里填更大的值也不会生效。' },
          ],
        },
        {
          group: 'files',
          heading: '文件',
          fields: [
            { key: 'max_file_bytes', label: '单文件最大字节数', kind: 'number' },
            { key: 'max_request_bytes', label: '单请求最大字节数', kind: 'number' },
            { key: 'retention_hours', label: '文件保留时长（小时）', kind: 'number', hint: '超过后由过期清理任务自动删除。' },
          ],
        },
      ]}
    />
  );
}
