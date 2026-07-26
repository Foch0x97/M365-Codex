/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 设为 "1" 时使用 src/api/mock.ts 提供的模拟数据，脱离服务端独立开发。 */
  readonly VITE_USE_MOCK?: string;
  /** 开发代理目标，覆盖 vite.config.ts 默认的 http://127.0.0.1:8080。 */
  readonly VITE_API_TARGET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
