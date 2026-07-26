/**
 * 与服务端约定的类型定义，字段名与语义严格照抄
 * `docs/管理端API契约.md`（本仓库内部文档，不进 GitHub 展示，但是这份 WebUI 唯一的接口依据）。
 *
 * 不在这里发明契约之外的字段；服务端尚未实现的部分先按契约文档的形状声明，
 * 真正联调时如有出入以 src/api/client.ts 里的注释为准去对齐。
 */

// ---- 通用 ----

/** 统一错误体。服务端实现里额外带了 `code`（HTTP 状态码字符串），契约文档未强制要求但会出现，按可选处理。 */
export interface ApiErrorBody {
  error: {
    type: string;
    message: string;
    param: string | null;
    request_id: string | null;
    code?: string;
  };
}

/** 请求失败时抛出的异常，携带完整错误体方便 UI 展示 request_id。 */
export class ApiRequestError extends Error {
  readonly body: ApiErrorBody;
  readonly status: number;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error.message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.body = body;
  }
}

export type SettingSource = 'env' | 'db' | 'default';

export interface SettingItem<T = unknown> {
  value: T;
  source: SettingSource;
  editable: boolean;
  requires_restart: boolean;
}

// ---- 登录 / 会话 ----

export interface LoginResponse {
  token: string;
  expires_at: number;
}

export interface SessionResponse {
  created_at: number | null;
  expires_at: number | null;
  public_api_base_url: string | null;
  public_admin_url: string | null;
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
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export interface AccountView {
  id: string;
  tid: string;
  oid: string;
  email: string | null;
  display_name: string | null;
  status: AccountStatus;
  source: string;
  created_at: number;
  updated_at: number;
  token_expires_at: number | null;
  token_rotated_at: number | null;
  has_refresh_token: boolean;
  consecutive_failures: number;
  cooldown_until: number | null;
  last_ok_at: number | null;
  last_error_type: string | null;
  /** 出口代理绑定（M7 新增，随代理池一起落地）。未绑定为 null。 */
  proxy_id: string | null;
}

export interface AuthorizeUrlResponse {
  authorize_url: string;
  state: string;
  expires_at: number;
}

export interface OAuthCallbackResult {
  account: AccountView;
  existing: boolean;
}

export interface OAuthSessionsResponse {
  pending: number;
}

// ---- API Key ----

export interface ApiKeyView {
  id: string;
  name: string;
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

/** 创建返回：明文 key 只在这一次出现，之后任何接口都不会再吐出来。 */
export interface ApiKeyCreated extends ApiKeyView {
  key: string;
}

export interface CreateApiKeyRequest {
  name: string;
  starts_at?: number | null;
  expires_at?: number | null;
  rpm_limit?: number | null;
  daily_limit?: number | null;
  max_concurrency?: number | null;
  allowed_endpoints?: string[] | null;
  allowed_models?: string[] | null;
}

export type UpdateApiKeyRequest = Partial<
  Omit<CreateApiKeyRequest, 'name'> & { name: string; enabled: boolean }
>;

// ---- 审计日志 ----

export interface AuditLogEntry {
  id: string;
  actor: string;
  action: string;
  target?: string | null;
  detail?: Record<string, unknown> | null;
  client_ip?: string | null;
  created_at: number;
}

// ---- 概览 ----

export type SystemStatus = 'normal' | 'degraded' | 'maintenance' | 'upstream_unavailable' | 'migration_failed';

export interface OverviewResponse {
  system_status: SystemStatus;
  version: string;
  uptime_ms: number;
  accounts: {
    total: number;
    online: number;
    cooldown: number;
    reauth_required: number;
    disabled: number;
  };
  requests: {
    in_flight: number;
    last_hour: number;
    failed_last_hour: number;
  };
  tools: {
    calls_last_hour: number;
    arg_pass_rate: number;
  };
  upstream: {
    protocol_version: string;
    ws_base: string;
    image_input: boolean;
  };
  storage: {
    db_bytes: number;
    files_bytes: number;
    files_count: number;
  };
  public_api_base_url: string;
  pending_restart: string[];
}

// ---- 请求记录 ----

export type ResponseStatus = 'queued' | 'in_progress' | 'completed' | 'incomplete' | 'failed' | 'cancelled';

export interface RequestListItem {
  id: string;
  status: ResponseStatus;
  requested_model: string;
  requested_reasoning_effort: string | null;
  api_key_id: string | null;
  account_id: string | null;
  tool_round: number;
  tool_calls_total: number;
  created_at: number;
  updated_at: number;
  error_message: string | null;
}

export interface RequestListResponse {
  items: RequestListItem[];
  total: number;
}

export interface RequestToolCall {
  call_id: string;
  name: string;
  status: string;
  side_effect: boolean;
  created_at: number;
}

export interface RequestDetail extends RequestListItem {
  tool_calls: RequestToolCall[];
}

// ---- 设置 ----

export interface NetworkSettings {
  public_api_base_url: SettingItem<string>;
  public_admin_url: SettingItem<string>;
  trust_proxy: SettingItem<boolean>;
  http_proxy: SettingItem<string>;
  https_proxy: SettingItem<string>;
  no_proxy: SettingItem<string>;
}

/** 全部是清理任务的间隔/保留时长，单位毫秒（对应服务端 cleanup 调度器）。 */
export interface SchedulerSettings {
  cleanup_interval_ms: SettingItem<number>;
  response_retention_ms: SettingItem<number>;
  audit_log_retention_ms: SettingItem<number>;
  idempotency_retention_ms: SettingItem<number>;
  files_retention_ms: SettingItem<number>;
  files_upload_ttl_ms: SettingItem<number>;
}

export interface LoggingSettings {
  /** 唯一 requires_restart=false 的设置项：保存后立即热生效。 */
  log_level: SettingItem<string>;
  log_privacy_mode: SettingItem<'strict' | 'metadata' | 'debug'>;
}

export interface OAuthSettings {
  client_id: SettingItem<string>;
  redirect_uri: SettingItem<string>;
  authorize_url: SettingItem<string>;
  token_url: SettingItem<string>;
  /** 服务端类型是 string_list：多个 scope 用空格分隔展示/编辑。 */
  scopes: SettingItem<string[]>;
}

export interface ToolsSettings {
  mode: SettingItem<'native' | 'prompt' | 'auto'>;
  max_calls_per_round: SettingItem<number>;
  max_rounds: SettingItem<number>;
  max_total_calls: SettingItem<number>;
  max_result_bytes: SettingItem<number>;
  /** 协议规则封顶 2，服务端会拒绝更大的值。 */
  max_arg_repairs: SettingItem<number>;
  allow_parallel: SettingItem<boolean>;
}

export interface FilesSettings {
  max_file_bytes: SettingItem<number>;
  max_request_bytes: SettingItem<number>;
  max_total_bytes_per_key: SettingItem<number>;
}

export interface SettingsResponse {
  network: NetworkSettings;
  scheduler: SchedulerSettings;
  logging: LoggingSettings;
  oauth: OAuthSettings;
  tools: ToolsSettings;
  files: FilesSettings;
}

export type SettingsGroupName = keyof SettingsResponse;

// ---- 出口代理池 ----

export type ProxyProtocol = 'http' | 'https' | 'socks5';
export type ProxyStatus = 'unknown' | 'healthy' | 'unhealthy' | 'cooldown';

export interface ProxyView {
  id: string;
  name: string;
  /** 打码后的地址，用户名密码永不明文出现，例如 `socks5://***:***@1.2.3.4:1080`。 */
  url_masked: string;
  protocol: ProxyProtocol;
  enabled: boolean;
  weight: number;
  priority: number;
  status: ProxyStatus;
  latency_ms: number | null;
  last_check_at: number | null;
  failure_count: number;
  cooldown_until: number | null;
  bound_accounts: string[];
}

export interface CreateProxyRequest {
  name: string;
  url: string;
  weight: number;
  priority: number;
  enabled: boolean;
}

export interface BulkImportProxyRequest {
  urls: string;
}

/**
 * 字段名与服务端 `apps/server/src/routes/adminOps.ts` 的
 * `POST /admin/proxies/bulk` 实际返回严格对齐：`created`/`failed` 计数，
 * `results` 里逐行给出 `ok`/`id`（成功时）/`error`（失败时），没有 `succeeded`/`errors` 这两个字段。
 */
export interface BulkImportProxyResult {
  created: number;
  failed: number;
  results: Array<{ line: string; ok: boolean; id?: string; error?: string }>;
}

export interface ProxyCheckResult {
  ok: boolean;
  latency_ms: number | null;
  detail: string;
}

// ---- Codex 配置生成 ----

export interface CodexConfigResponse {
  toml: string;
  base_url: string;
  notes: string[];
}

// ---- 文件 ----

export interface FileListItem {
  id: string;
  filename: string;
  mime_type: string;
  kind: string;
  bytes: number;
  status: string;
  api_key_id: string | null;
  created_at: number;
  expires_at: number | null;
}

export interface FileListResponse {
  items: FileListItem[];
  total_bytes: number;
}

/**
 * 字段名与服务端 `apps/server/src/routes/adminOps.ts` 的
 * `POST /admin/files/cleanup` 实际返回严格对齐：过期文件与未完成上传分开计数，
 * 没有笼统的单一 `deleted` 字段。
 */
export interface FilesCleanupResult {
  deleted_files: number;
  deleted_uploads: number;
  freed_bytes: number;
}

// ---- 模型与能力矩阵 ----

export type CapabilityStatus = 'native' | 'local' | 'upstream_decided' | 'experimental' | 'unsupported';

export interface CapabilitiesResponse {
  models: Array<{ id: string; source: string }>;
  matrix: Array<{ feature: string; status: CapabilityStatus; detail: string }>;
}

// ---- 备份 / 恢复 / 诊断（对应服务端 apps/server/src/routes/backup.ts） ----

/** 与服务端 `BackupStore#save`/`#list`（apps/server/src/backup/store.ts）返回形状一致。 */
export interface BackupInfo {
  id: string;
  bytes: number;
  created_at: number;
}

export interface BackupListResponse {
  items: BackupInfo[];
}

/** 与服务端 `BackupManifest`（apps/server/src/backup/service.ts）字段一致。 */
export interface BackupManifest {
  format_version: number;
  app_version: string;
  schema_version: number;
  master_key_version: number;
  created_at: number;
  includes_files: boolean;
  file_count: number;
}

/**
 * `POST /admin/restore` 的返回体。`requires_restart` 恒为 true——
 * 服务端只负责校验并落盘，正在运行的进程仍持有旧库连接，必须重启才会生效。
 */
export interface RestoreResult {
  restored: boolean;
  requires_restart: boolean;
  message: string;
  manifest: BackupManifest;
}

/** 与服务端 `DiagnosticsReport`（apps/server/src/observability/diagnostics.ts）字段一致。 */
export interface DiagnosticsReport {
  generated_at: number;
  app_version: string;
  system_status: SystemStatus;
  uptime_ms: number;
  schema: { current: number; expected: number; ok: boolean };
  accounts: Record<string, number>;
  accounts_usable: number;
  in_flight_requests: number;
  recent_errors: Record<string, number>;
  storage: { db_bytes: number; files_bytes: number; file_count: number };
  maintenance: Array<{ name: string; last_run_at: number | null; last_error: string | null }>;
  readiness: Array<{ name: string; ok: boolean }>;
  config: Record<string, unknown>;
  notes: string[];
}
