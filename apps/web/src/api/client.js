import { request } from './http';
/**
 * 真实服务端实现。接口路径与方法严格照 docs/管理端API契约.md。
 *
 * 注意几处已知的、和现有 M1–M2 代码实现之间可能存在的出入（见本次任务最终报告），
 * 这里按契约文档写；服务端如果保留了旧路径，需要在联调时二选一对齐。
 */
export const realAdminApi = {
    login: (password) => request('/admin/login', { method: 'POST', body: { password } }),
    logout: () => request('/admin/logout', { method: 'POST' }),
    getSession: () => request('/admin/session'),
    getOverview: () => request('/admin/overview'),
    listAccounts: () => request('/admin/accounts').then((r) => r.data),
    getAccount: (id) => request(`/admin/accounts/${id}`),
    setAccountStatus: (id, status) => request(`/admin/accounts/${id}`, { method: 'PATCH', body: { status } }),
    refreshAccount: (id) => request(`/admin/accounts/${id}/refresh`, { method: 'POST' }),
    deleteAccount: (id) => request(`/admin/accounts/${id}`, { method: 'DELETE' }),
    bindAccountProxy: (id, proxyId) => request(`/admin/accounts/${id}/proxy`, { method: 'POST', body: { proxy_id: proxyId } }),
    createAuthorizeUrl: () => request('/admin/oauth/authorize-url', { method: 'POST' }),
    submitOAuthCallback: (callbackUrl) => request('/admin/oauth/callback', {
        method: 'POST',
        body: { redirect_url: callbackUrl },
    }),
    getOAuthSessions: () => request('/admin/oauth/sessions'),
    listRequests: ({ limit, status, apiKeyId }) => request('/admin/requests', {
        query: { limit, status, api_key_id: apiKeyId },
    }),
    getRequest: (id) => request(`/admin/requests/${id}`),
    listApiKeys: () => request('/admin/api-keys').then((r) => r.data),
    createApiKey: (payload) => request('/admin/api-keys', { method: 'POST', body: payload }),
    updateApiKey: (id, payload) => request(`/admin/api-keys/${id}`, { method: 'PATCH', body: payload }),
    revokeApiKey: (id) => request(`/admin/api-keys/${id}`, { method: 'DELETE' }),
    getCapabilities: () => request('/admin/capabilities'),
    listFiles: ({ apiKeyId, limit }) => request('/admin/files', { query: { api_key_id: apiKeyId, limit } }),
    deleteFile: (id) => request(`/admin/files/${id}`, { method: 'DELETE' }),
    cleanupFiles: () => request('/admin/files/cleanup', { method: 'POST' }),
    listProxies: () => request('/admin/proxies').then((r) => r.items),
    createProxy: (payload) => request('/admin/proxies', { method: 'POST', body: payload }),
    bulkImportProxies: (payload) => request('/admin/proxies/bulk', { method: 'POST', body: payload }),
    updateProxy: (id, payload) => request(`/admin/proxies/${id}`, { method: 'PATCH', body: payload }),
    deleteProxy: (id) => request(`/admin/proxies/${id}`, { method: 'DELETE' }),
    checkProxy: (id) => request(`/admin/proxies/${id}/check`, { method: 'POST' }),
    getSettings: () => request('/admin/settings'),
    updateSettings: (group, values) => request('/admin/settings', { method: 'PATCH', body: { group, values } }),
    getCodexConfig: (apiKeyEnv) => request('/admin/codex-config', { query: { api_key_env: apiKeyEnv } }),
    getAuditLogs: (limit) => request('/admin/audit-logs', { query: { limit } }).then((r) => r.data),
};
