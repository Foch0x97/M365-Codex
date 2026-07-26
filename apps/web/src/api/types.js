/**
 * 与服务端约定的类型定义，字段名与语义严格照抄
 * `docs/管理端API契约.md`（本仓库内部文档，不进 GitHub 展示，但是这份 WebUI 唯一的接口依据）。
 *
 * 不在这里发明契约之外的字段；服务端尚未实现的部分先按契约文档的形状声明，
 * 真正联调时如有出入以 src/api/client.ts 里的注释为准去对齐。
 */
/** 请求失败时抛出的异常，携带完整错误体方便 UI 展示 request_id。 */
export class ApiRequestError extends Error {
    body;
    status;
    constructor(status, body) {
        super(body.error.message);
        this.name = 'ApiRequestError';
        this.status = status;
        this.body = body;
    }
}
// ---- 账号 ----
export const ACCOUNT_STATUSES = [
    'probing',
    'online',
    'busy',
    'cooldown',
    'reauth_required',
    'disabled',
    'unsupported',
    'error',
];
