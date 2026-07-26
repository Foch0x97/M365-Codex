import type { AdminApi } from './adminApi';
/**
 * 真实服务端实现。接口路径与方法严格照 docs/管理端API契约.md。
 *
 * 注意几处已知的、和现有 M1–M2 代码实现之间可能存在的出入（见本次任务最终报告），
 * 这里按契约文档写；服务端如果保留了旧路径，需要在联调时二选一对齐。
 */
export declare const realAdminApi: AdminApi;
