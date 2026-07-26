/** 领域状态与对外数据结构定义。 */

/** Microsoft 账号状态机（对应实施计划 §M2）。 */
export const ACCOUNT_STATUSES = [
  'probing',
  'online',
  'busy',
  'cooldown',
  'reauth_required',
  'disabled',
  'unsupported',
  'error',
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** Responses 生命周期状态。 */
export const RESPONSE_STATUSES = [
  'queued',
  'in_progress',
  'completed',
  'incomplete',
  'failed',
  'cancelled',
] as const;
export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

/** 日志隐私模式。 */
export const LOG_PRIVACY_MODES = ['strict', 'metadata', 'debug'] as const;
export type LogPrivacyMode = (typeof LOG_PRIVACY_MODES)[number];

/** 健康检查响应。 */
export interface HealthResponse {
  status: 'ok';
  version: string;
  uptime_ms: number;
}

/** 就绪检查中的单项结果。 */
export interface ReadinessCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ReadinessResponse {
  status: 'ready' | 'not_ready';
  version: string;
  schema_version: number;
  checks: ReadinessCheck[];
}

/** API Key 的对外展示形态（永远不含明文 Key）。 */
export interface ApiKeyView {
  id: string;
  name: string;
  /** 掩码展示，如 `sk-Ab12Cd34…` */
  masked_key: string;
  enabled: boolean;
  created_at: number;
  starts_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
  rpm_limit: number | null;
  daily_limit: number | null;
  max_concurrency: number | null;
  allowed_endpoints: string[] | null;
  allowed_models: string[] | null;
}

/** 创建 API Key 的返回：明文 Key 仅在此刻出现一次。 */
export interface ApiKeyCreated extends ApiKeyView {
  /** 明文 API Key，仅创建时返回一次，服务端不保存 */
  key: string;
}
