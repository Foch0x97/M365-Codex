import type { AdminApi } from './adminApi';
/**
 * `VITE_USE_MOCK=1` 时整站切到内存模拟数据，脱离服务端独立开发/跑测试；
 * 默认（未设置或为其他值）走真实后端。页面代码统一从这里导入 `api`，不直接依赖 client/mock。
 */
export declare const api: AdminApi;
export * from './types';
export type { AdminApi } from './adminApi';
