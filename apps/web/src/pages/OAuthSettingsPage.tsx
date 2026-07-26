import { SettingsGroupPage } from '../components/SettingsGroupPage';

export function OAuthSettingsPage() {
  return (
    <SettingsGroupPage
      title="OAuth"
      subtitle="Microsoft OAuth 客户端与端点设置（对应 /admin/settings 的 oauth 分组）"
      groups={[
        {
          group: 'oauth',
          heading: 'OAuth 端点',
          fields: [
            { key: 'client_id', label: '客户端 ID', kind: 'string' },
            { key: 'redirect_uri', label: '回调地址', kind: 'string', hint: '回调落在 Microsoft 自己的页面上，本服务不需要公网可达。' },
            { key: 'authorize_url', label: '授权端点', kind: 'string' },
            { key: 'token_url', label: 'Token 端点', kind: 'string' },
            { key: 'scopes', label: 'Scope（空格分隔）', kind: 'string' },
          ],
        },
      ]}
    />
  );
}
