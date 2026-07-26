import { Buffer } from 'node:buffer';
import { z } from 'zod';
import {
  DEFAULT_DATA_DIR,
  DEFAULT_PORT,
  LOG_PRIVACY_MODES,
  MASTER_KEY_BYTES,
  type LogPrivacyMode,
} from '@m365-codex/shared';

/**
 * 配置加载与校验（对应实施计划 §3）。
 *
 * 硬约束：
 * - `M365_CODEX_MASTER_KEY` 无默认值，缺失或非 32 字节一律拒绝启动；
 * - 禁止通过环境变量注入任何 Microsoft Token / OAuth 凭据；
 * - 上游地址、scope 等一律走配置，不硬编码进业务逻辑。
 */

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`配置校验失败：\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * 明确禁止出现的环境变量名。出现即拒绝启动，避免运维图省事把
 * 真实 Token 塞进容器环境，从而绕过加密入库与审计。
 */
export const FORBIDDEN_ENV_KEYS: readonly string[] = [
  'M365_ACCESS_TOKEN',
  'M365_REFRESH_TOKEN',
  'M365_CODEX_ACCESS_TOKEN',
  'M365_CODEX_REFRESH_TOKEN',
  'MICROSOFT_ACCESS_TOKEN',
  'MICROSOFT_REFRESH_TOKEN',
  'AAD_ACCESS_TOKEN',
  'AAD_REFRESH_TOKEN',
  'SUBSTRATE_ACCESS_TOKEN',
  'SYDNEY_ACCESS_TOKEN',
  'COPILOT_ACCESS_TOKEN',
  'BIZCHAT_ACCESS_TOKEN',
];

/**
 * OAuth 上游参数。
 *
 * 全部走配置：上游端点会漂移（已观察到 substrate.office.com 与
 * substrate.svc.cloud.microsoft 两种形态），CLIENT_ID 与 scope 也可能随之调整，
 * 因此这里只提供默认值，不在业务逻辑里硬编码。
 */
export interface OAuthConfig {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
}

/** 默认值来自公开的 Microsoft 原生客户端 PKCE 流程，均非机密。 */
export const DEFAULT_OAUTH_CLIENT_ID = 'c0ab8ce9-e9a0-42e7-b064-33d422df41f1';
export const DEFAULT_OAUTH_REDIRECT_URI =
  'https://login.microsoftonline.com/common/oauth2/nativeclient';
export const DEFAULT_OAUTH_AUTHORIZE_URL =
  'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
export const DEFAULT_OAUTH_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
export const DEFAULT_OAUTH_SCOPES: readonly string[] = [
  'https://substrate.office.com/sydney/M365Chat.Read',
  'https://substrate.office.com/sydney/sydney.readwrite',
  'offline_access',
  'openid',
  'profile',
];

/**
 * Sydney / BizChat 上游 WebSocket 参数。
 *
 * 上游端点会漂移（已观察到 substrate.office.com 与 substrate.svc.cloud.microsoft
 * 两种形态），所以基址、路径模板、协议版本全部走配置。路径模板里的占位符：
 *   {oid} {tid} 会被替换为账号的对象 ID 与租户 ID。
 * access_token 通过查询参数附加，不写进模板（避免误入日志）。
 */
export interface UpstreamConfig {
  readonly wsBase: string;
  readonly pathTemplate: string;
  /** 协议适配层版本，独立于业务版本；M0 探针确认真实协议后可切换 */
  readonly protocolVersion: string;
  /** 心跳间隔（毫秒） */
  readonly heartbeatIntervalMs: number;
  /** 握手超时（毫秒） */
  readonly handshakeTimeoutMs: number;
  /** 单条消息空闲超时（毫秒）：超过该时间没有任何上游帧则判定卡死 */
  readonly idleTimeoutMs: number;
  /** WS 断开后的最大重连次数（同一账号内） */
  readonly maxReconnects: number;
  /**
   * WebSocket 握手时必须带的 `X-Scenario` 头。
   *
   * 2026-07-27 用真实账号实测：这个头是**上游放行的唯一硬条件**——不带它，
   * 无论 token 多正确、放查询参数还是 Authorization 头，一律 403（空响应体、
   * 无 WWW-Authenticate，看起来像"账号没权限"，极具误导性）。取值必须精确匹配，
   * `bizchat` / `M365Chat` / 任意其它值都是 403。
   *
   * 做成配置项是因为它显然属于会随上游变动的东西；默认值来自实测。
   */
  readonly scenario: string;
}

export const DEFAULT_UPSTREAM_WS_BASE = 'wss://substrate.office.com';
export const DEFAULT_UPSTREAM_PATH_TEMPLATE = '/m365Copilot/Chathub/{oid}@{tid}';
export const DEFAULT_UPSTREAM_PROTOCOL_VERSION = 'sydney-json-v1';
/** 实测值：上游只认这一个取值，换成别的一律 403（见 UpstreamConfig.scenario 注释）。 */
export const DEFAULT_UPSTREAM_SCENARIO = 'officeweb';

/**
 * 工具调用与代理循环的全局上限（对应实施计划 §7.4）。
 *
 * 这些是**全局天花板**，API Key 级限制只能更严、不能突破（§10，M7 落地）。
 * `mode` 决定怎么把工具目录交给上游：
 *   native —— 只在 invocation 里带结构化工具声明（上游原生支持时）；
 *   prompt —— 只用提示词约束输出 `<tool_call>` JSON（上游不支持原生工具时）；
 *   auto   —— 两者都上，并同时解析两种回应形态。M0 探针出结论前的默认值。
 */
export type ToolsMode = 'native' | 'prompt' | 'auto';

export interface ToolsConfig {
  readonly mode: ToolsMode;
  /** 单轮最多接受多少个工具调用 */
  readonly maxCallsPerRound: number;
  /** 一条对话链上最多几轮工具调用 */
  readonly maxRounds: number;
  /** 一条对话链上累计最多多少个工具调用 */
  readonly maxTotalCalls: number;
  /** 单个工具结果的最大字节数 */
  readonly maxResultBytes: number;
  /** 参数不合法时向上游请求修复的最多次数（§7.3 上限为 2） */
  readonly maxArgRepairs: number;
  /** 是否允许一轮里出现多个工具调用 */
  readonly allowParallel: boolean;
}

export const MAX_ARG_REPAIRS_CEILING = 2;

/**
 * 文件子系统的限额（对应实施计划 §11、§M6）。
 *
 * 全部走配置，且都是**天花板**：单文件、单请求、单 Key 累计存储三层限制，
 * 任何一层超限都返回明确错误，不做静默截断。
 */
export interface FilesConfig {
  /** 单个文件（或 Upload 单个 part）最大字节数 */
  readonly maxFileBytes: number;
  /** 单次 multipart 请求最大字节数（须 ≥ maxFileBytes，供路由设置 Fastify 的 bodyLimit） */
  readonly maxRequestBytes: number;
  /** 单个 API Key 累计存储上限（未删除文件的字节数之和） */
  readonly maxTotalBytesPerKey: number;
  /** 文件保留期（毫秒），超过 created_at + 该值即视为过期；0 表示不自动过期 */
  readonly retentionMs: number;
  /** 未完成 Upload 的存活时间（毫秒），超过后视为过期并清理已收到的分片 */
  readonly uploadTtlMs: number;
}

/**
 * API Key 限额的**全局天花板**（对应实施计划 §10 末句:「API Key 限制不得超过
 * 系统全局限制」)。单个 Key 的 rpm_limit / daily_limit / max_concurrency 只能
 * 比这里更严，绝不允许突破——具体裁剪逻辑在 `gateway/rateLimit.ts`。
 */
export interface RateLimitConfig {
  readonly globalRpmLimit: number;
  readonly globalDailyLimit: number;
  readonly globalMaxConcurrency: number;
}

/**
 * 定时清理的间隔与保留期（对应实施计划 §18）。
 * 文件/Upload 自己的保留期复用 `FilesConfig`，这里只放专属于 M7 清理任务的项。
 */
export interface CleanupConfig {
  /** 各清理任务共用的运行间隔 */
  readonly intervalMs: number;
  /** 已结束（completed/failed/cancelled/incomplete）的 Response 保留多久 */
  readonly responseRetentionMs: number;
  /** 审计日志保留多久 */
  readonly auditLogRetentionMs: number;
  /** 幂等记录保留多久 */
  readonly idempotencyRetentionMs: number;
}

/**
 * 指标与备份（对应实施计划 §17、§15.4，M8 新增）。
 *
 * `metricsRequireAuth` 默认开启：`/metrics` 会暴露账号数量、错误分布这类信息，
 * 不应该无鉴权公开；显式改为 false 时走无鉴权（适合放进只在内网可达的抓取器）。
 */
export interface MetricsConfig {
  readonly enabled: boolean;
  readonly requireAuth: boolean;
}

/** 备份保留份数：`POST /admin/backup` 生成的包超过这个数量后，定时清理会删掉最旧的。 */
export interface BackupConfig {
  readonly retentionCount: number;
}

export interface AppConfig {
  readonly port: number;
  readonly dataDir: string;
  readonly masterKey: Buffer;
  readonly masterKeyVersion: number;
  readonly adminPassword: string;
  readonly publicApiBaseUrl: string | null;
  readonly publicAdminUrl: string | null;
  readonly trustProxy: boolean;
  readonly logPrivacyMode: LogPrivacyMode;
  /**
   * `debug` 隐私模式的默认自动过期时长（毫秒，对应实施计划 §15.3）。
   * debug 会记录更多请求信息，不能无限期停留在这一档；切到 debug 时按这个
   * 时长自动计算 `logging.debug_expires_at`，到期由 `settings/service.ts`
   * 的定时任务自动恢复 strict。
   */
  readonly logPrivacyDebugTtlMs: number;
  readonly logLevel: string;
  readonly upstreamWsBase: string | null;
  readonly httpProxy: string | null;
  readonly httpsProxy: string | null;
  readonly noProxy: string | null;
  readonly oauth: OAuthConfig;
  readonly upstream: UpstreamConfig;
  readonly tools: ToolsConfig;
  readonly files: FilesConfig;
  readonly rateLimit: RateLimitConfig;
  readonly cleanup: CleanupConfig;
  /** 出口代理健康检查超时（毫秒，契约 §2.4 `POST /admin/proxies/:id/check`） */
  readonly proxyCheckTimeoutMs: number;
  /** M8：`/metrics` 端点的开关与鉴权要求 */
  readonly metrics: MetricsConfig;
  /** M8：备份保留份数 */
  readonly backup: BackupConfig;
  /**
   * 启动时原始环境变量里显式出现过的键名（非空值）。
   * `/admin/settings` 据此判断某项是否 `source: "env"`——容器编排是唯一真源，
   * 一旦环境变量显式设置过，UI 就不能悄悄盖掉（见实施计划 §M7、契约 §2.3）。
   */
  readonly envKeysPresent: ReadonlySet<string>;
  /**
   * 上游是否真支持图片输入。默认 false——上游能力要等 M0 真实探针校准，
   * 探针结论出来前一律拒绝并返回 unsupported_feature，不假装支持。
   */
  readonly upstreamImageInput: boolean;
  /**
   * 重建出的对话上下文超过多少字符就从最旧历史开始截断（见
   * `responses/schema.ts` 的 `extractInputText`）。Codex 这类 `store:false`
   * 客户端每轮会带上几万字符的系统指令 + 完整历史，默认给一个宽松值。
   */
  readonly contextMaxChars: number;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** 解析并校验 Base64 主密钥，失败时抛出可读原因。 */
export function parseMasterKey(raw: string): Buffer {
  const value = raw.trim();
  if (value.length === 0) {
    throw new Error('主密钥为空');
  }
  if (!BASE64_PATTERN.test(value)) {
    throw new Error('主密钥不是合法的 Base64 字符串');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength !== MASTER_KEY_BYTES) {
    throw new Error(`主密钥解码后为 ${decoded.byteLength} 字节，要求正好 ${MASTER_KEY_BYTES} 字节`);
  }
  return decoded;
}

const optionalTrimmed = z
  .string()
  .transform((value) => {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  })
  .optional();

const booleanFromEnv = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => ['true', 'false', '1', '0', 'yes', 'no', ''].includes(value), {
    message: '只接受 true/false/1/0/yes/no',
  })
  .transform((value) => value === 'true' || value === '1' || value === 'yes')
  .optional();

const optionalUrl = optionalTrimmed.refine(
  (value) => {
    if (value === undefined) return true;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: '必须是 http/https URL' },
);

const optionalWsUrl = optionalTrimmed.refine(
  (value) => {
    if (value === undefined) return true;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
    } catch {
      return false;
    }
  },
  { message: '必须是 ws/wss URL' },
);

const envSchema = z.object({
  M365_CODEX_MASTER_KEY: z.string({ required_error: '必填：未设置主加密密钥' }),
  M365_CODEX_ADMIN_PASSWORD: z
    .string({ required_error: '必填：未设置管理端密码' })
    .min(12, '管理端密码至少 12 位'),
  PORT: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? DEFAULT_PORT : Number(value)))
    .refine((value) => Number.isInteger(value) && value >= 1 && value <= 65535, {
      message: '必须是 1-65535 的整数',
    }),
  DATA_DIR: optionalTrimmed,
  PUBLIC_API_BASE_URL: optionalUrl,
  PUBLIC_ADMIN_URL: optionalUrl,
  TRUST_PROXY: booleanFromEnv,
  LOG_PRIVACY_MODE: z.enum(LOG_PRIVACY_MODES).optional(),
  // 保守默认 1 小时：debug 模式记录更多请求信息，不该无限期停留
  LOG_PRIVACY_DEBUG_TTL_MS: positiveIntFromEnv(60 * 60 * 1000, 60_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  UPSTREAM_WS_BASE: optionalWsUrl,
  HTTP_PROXY: optionalTrimmed,
  HTTPS_PROXY: optionalTrimmed,
  NO_PROXY: optionalTrimmed,
  MASTER_KEY_VERSION: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? 1 : Number(value)))
    .refine((value) => Number.isInteger(value) && value >= 1, { message: '必须是 ≥1 的整数' }),
  OAUTH_CLIENT_ID: optionalTrimmed,
  OAUTH_REDIRECT_URI: optionalUrl,
  OAUTH_AUTHORIZE_URL: optionalUrl,
  OAUTH_TOKEN_URL: optionalUrl,
  OAUTH_SCOPES: optionalTrimmed,
  UPSTREAM_PATH_TEMPLATE: optionalTrimmed,
  UPSTREAM_PROTOCOL_VERSION: optionalTrimmed,
  UPSTREAM_SCENARIO: optionalTrimmed,
  UPSTREAM_HEARTBEAT_INTERVAL_MS: positiveIntFromEnv(15_000, 1_000),
  UPSTREAM_HANDSHAKE_TIMEOUT_MS: positiveIntFromEnv(15_000, 1_000),
  UPSTREAM_IDLE_TIMEOUT_MS: positiveIntFromEnv(60_000, 1_000),
  UPSTREAM_MAX_RECONNECTS: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? 2 : Number(value)))
    .refine((value) => Number.isInteger(value) && value >= 0 && value <= 10, {
      message: '必须是 0-10 的整数',
    }),
  TOOLS_MODE: z.enum(['native', 'prompt', 'auto']).optional(),
  TOOLS_MAX_CALLS_PER_ROUND: positiveIntFromEnv(8, 1),
  TOOLS_MAX_ROUNDS: positiveIntFromEnv(16, 1),
  TOOLS_MAX_TOTAL_CALLS: positiveIntFromEnv(64, 1),
  TOOLS_MAX_RESULT_BYTES: positiveIntFromEnv(256 * 1024, 1024),
  TOOLS_MAX_ARG_REPAIRS: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? MAX_ARG_REPAIRS_CEILING : Number(value)))
    .refine((value) => Number.isInteger(value) && value >= 0 && value <= MAX_ARG_REPAIRS_CEILING, {
      message: `必须是 0-${MAX_ARG_REPAIRS_CEILING} 的整数`,
    }),
  TOOLS_ALLOW_PARALLEL: booleanFromEnv,
  FILES_MAX_FILE_BYTES: positiveIntFromEnv(25 * 1024 * 1024, 1024),
  FILES_MAX_REQUEST_BYTES: positiveIntFromEnv(26 * 1024 * 1024, 1024),
  FILES_MAX_TOTAL_BYTES_PER_KEY: positiveIntFromEnv(200 * 1024 * 1024, 1024),
  // 0 表示不自动过期，因此下限放宽到 0（不能用 positiveIntFromEnv，它的下限是 min）
  FILES_RETENTION_MS: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? 30 * 24 * 60 * 60 * 1000 : Number(value)))
    .refine((value) => Number.isInteger(value) && value >= 0, { message: '必须是 ≥0 的整数' }),
  FILES_UPLOAD_TTL_MS: positiveIntFromEnv(24 * 60 * 60 * 1000, 60_000),
  UPSTREAM_IMAGE_INPUT: booleanFromEnv,
  CONTEXT_MAX_CHARS: positiveIntFromEnv(400_000, 10_000),
  // --- API Key 限额的全局天花板（§10）---
  RATE_LIMIT_GLOBAL_RPM: positiveIntFromEnv(600, 1),
  RATE_LIMIT_GLOBAL_DAILY: positiveIntFromEnv(50_000, 1),
  RATE_LIMIT_GLOBAL_MAX_CONCURRENCY: positiveIntFromEnv(50, 1),
  // --- 定时清理（§18）---
  CLEANUP_INTERVAL_MS: positiveIntFromEnv(10 * 60 * 1000, 30_000),
  CLEANUP_RESPONSE_RETENTION_MS: positiveIntFromEnv(7 * 24 * 60 * 60 * 1000, 60_000),
  CLEANUP_AUDIT_LOG_RETENTION_MS: positiveIntFromEnv(90 * 24 * 60 * 60 * 1000, 60_000),
  CLEANUP_IDEMPOTENCY_RETENTION_MS: positiveIntFromEnv(24 * 60 * 60 * 1000, 60_000),
  PROXY_CHECK_TIMEOUT_MS: positiveIntFromEnv(5_000, 500),
  // --- 指标与备份（M8，§17、§15.4）---
  METRICS_ENABLED: booleanFromEnv,
  // 默认开启：/metrics 会暴露账号数量与错误分布，不应无鉴权公开
  METRICS_REQUIRE_AUTH: booleanFromEnv,
  BACKUP_RETENTION_COUNT: positiveIntFromEnv(7, 1),
});

/** 生成一个「可选正整数、带默认值与下限」的 env 解析器。 */
function positiveIntFromEnv(defaultValue: number, min: number) {
  return z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? defaultValue : Number(value)))
    .refine((value) => Number.isInteger(value) && value >= min, {
      message: `必须是 ≥${min} 的整数`,
    });
}

/** scope 允许用空格或逗号分隔，兼容两种常见写法。 */
function parseScopes(raw: string | undefined): readonly string[] {
  if (raw === undefined) return DEFAULT_OAUTH_SCOPES;
  const parsed = raw
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope !== '');
  return parsed.length === 0 ? DEFAULT_OAUTH_SCOPES : parsed;
}

export type RawEnv = Record<string, string | undefined>;

/**
 * 从环境变量加载配置。任何一项不合法都会汇总后一次性抛出 ConfigError，
 * 避免运维反复试错。错误信息中不会回显敏感值。
 */
export function loadConfig(env: RawEnv = process.env): AppConfig {
  const issues: string[] = [];

  for (const key of FORBIDDEN_ENV_KEYS) {
    if (env[key] !== undefined && env[key] !== '') {
      issues.push(
        `${key}: 禁止通过环境变量注入 Microsoft 凭据，请改用管理界面的 PKCE 授权流程`,
      );
    }
  }

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.') || '(root)';
      issues.push(`${path}: ${issue.message}`);
    }
  }

  let masterKey: Buffer | undefined;
  const rawMasterKey = env.M365_CODEX_MASTER_KEY;
  if (typeof rawMasterKey === 'string' && rawMasterKey.trim() !== '') {
    try {
      masterKey = parseMasterKey(rawMasterKey);
    } catch (error) {
      issues.push(`M365_CODEX_MASTER_KEY: ${(error as Error).message}`);
    }
  } else if (rawMasterKey !== undefined) {
    issues.push('M365_CODEX_MASTER_KEY: 不能为空');
  }

  if (parsed.success && parsed.data.FILES_MAX_REQUEST_BYTES < parsed.data.FILES_MAX_FILE_BYTES) {
    issues.push('FILES_MAX_REQUEST_BYTES: 不能小于 FILES_MAX_FILE_BYTES');
  }

  if (issues.length > 0 || !parsed.success || masterKey === undefined) {
    throw new ConfigError(issues.length > 0 ? issues : ['未知的配置错误']);
  }

  const data = parsed.data;

  return Object.freeze({
    port: data.PORT,
    dataDir: data.DATA_DIR ?? DEFAULT_DATA_DIR,
    masterKey,
    masterKeyVersion: data.MASTER_KEY_VERSION,
    adminPassword: data.M365_CODEX_ADMIN_PASSWORD,
    publicApiBaseUrl: data.PUBLIC_API_BASE_URL ?? null,
    publicAdminUrl: data.PUBLIC_ADMIN_URL ?? null,
    trustProxy: data.TRUST_PROXY ?? false,
    logPrivacyMode: data.LOG_PRIVACY_MODE ?? 'strict',
    logPrivacyDebugTtlMs: data.LOG_PRIVACY_DEBUG_TTL_MS,
    logLevel: data.LOG_LEVEL ?? 'info',
    upstreamWsBase: data.UPSTREAM_WS_BASE ?? null,
    httpProxy: data.HTTP_PROXY ?? null,
    httpsProxy: data.HTTPS_PROXY ?? null,
    noProxy: data.NO_PROXY ?? null,
    oauth: Object.freeze({
      clientId: data.OAUTH_CLIENT_ID ?? DEFAULT_OAUTH_CLIENT_ID,
      redirectUri: data.OAUTH_REDIRECT_URI ?? DEFAULT_OAUTH_REDIRECT_URI,
      authorizeUrl: data.OAUTH_AUTHORIZE_URL ?? DEFAULT_OAUTH_AUTHORIZE_URL,
      tokenUrl: data.OAUTH_TOKEN_URL ?? DEFAULT_OAUTH_TOKEN_URL,
      scopes: Object.freeze(parseScopes(data.OAUTH_SCOPES)),
    }),
    upstream: Object.freeze({
      wsBase: data.UPSTREAM_WS_BASE ?? DEFAULT_UPSTREAM_WS_BASE,
      pathTemplate: data.UPSTREAM_PATH_TEMPLATE ?? DEFAULT_UPSTREAM_PATH_TEMPLATE,
      protocolVersion: data.UPSTREAM_PROTOCOL_VERSION ?? DEFAULT_UPSTREAM_PROTOCOL_VERSION,
      scenario: data.UPSTREAM_SCENARIO ?? DEFAULT_UPSTREAM_SCENARIO,
      heartbeatIntervalMs: data.UPSTREAM_HEARTBEAT_INTERVAL_MS,
      handshakeTimeoutMs: data.UPSTREAM_HANDSHAKE_TIMEOUT_MS,
      idleTimeoutMs: data.UPSTREAM_IDLE_TIMEOUT_MS,
      maxReconnects: data.UPSTREAM_MAX_RECONNECTS,
    }),
    tools: Object.freeze({
      mode: data.TOOLS_MODE ?? 'auto',
      maxCallsPerRound: data.TOOLS_MAX_CALLS_PER_ROUND,
      maxRounds: data.TOOLS_MAX_ROUNDS,
      maxTotalCalls: data.TOOLS_MAX_TOTAL_CALLS,
      maxResultBytes: data.TOOLS_MAX_RESULT_BYTES,
      maxArgRepairs: data.TOOLS_MAX_ARG_REPAIRS,
      allowParallel: data.TOOLS_ALLOW_PARALLEL ?? true,
    }),
    files: Object.freeze({
      maxFileBytes: data.FILES_MAX_FILE_BYTES,
      maxRequestBytes: data.FILES_MAX_REQUEST_BYTES,
      maxTotalBytesPerKey: data.FILES_MAX_TOTAL_BYTES_PER_KEY,
      retentionMs: data.FILES_RETENTION_MS,
      uploadTtlMs: data.FILES_UPLOAD_TTL_MS,
    }),
    rateLimit: Object.freeze({
      globalRpmLimit: data.RATE_LIMIT_GLOBAL_RPM,
      globalDailyLimit: data.RATE_LIMIT_GLOBAL_DAILY,
      globalMaxConcurrency: data.RATE_LIMIT_GLOBAL_MAX_CONCURRENCY,
    }),
    cleanup: Object.freeze({
      intervalMs: data.CLEANUP_INTERVAL_MS,
      responseRetentionMs: data.CLEANUP_RESPONSE_RETENTION_MS,
      auditLogRetentionMs: data.CLEANUP_AUDIT_LOG_RETENTION_MS,
      idempotencyRetentionMs: data.CLEANUP_IDEMPOTENCY_RETENTION_MS,
    }),
    proxyCheckTimeoutMs: data.PROXY_CHECK_TIMEOUT_MS,
    envKeysPresent: computeEnvKeysPresent(env),
    upstreamImageInput: data.UPSTREAM_IMAGE_INPUT ?? false,
    contextMaxChars: data.CONTEXT_MAX_CHARS,
    metrics: Object.freeze({
      enabled: data.METRICS_ENABLED ?? true,
      requireAuth: data.METRICS_REQUIRE_AUTH ?? true,
    }),
    backup: Object.freeze({
      retentionCount: data.BACKUP_RETENTION_COUNT,
    }),
  });
}

/** 记录启动时哪些环境变量被显式赋了非空值，供 `/admin/settings` 判断 `source: "env"`。 */
function computeEnvKeysPresent(env: RawEnv): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() !== '') keys.add(key);
  }
  return keys;
}

/** 生成可安全写入日志的配置摘要：不含密钥与密码。 */
export function summarizeConfig(config: AppConfig): Record<string, unknown> {
  return {
    port: config.port,
    dataDir: config.dataDir,
    masterKeyVersion: config.masterKeyVersion,
    masterKeyConfigured: true,
    adminPasswordConfigured: config.adminPassword.length > 0,
    publicApiBaseUrl: config.publicApiBaseUrl,
    publicAdminUrl: config.publicAdminUrl,
    trustProxy: config.trustProxy,
    logPrivacyMode: config.logPrivacyMode,
    logLevel: config.logLevel,
    upstreamWsBaseConfigured: config.upstreamWsBase !== null,
    egressProxyConfigured: config.httpProxy !== null || config.httpsProxy !== null,
    oauthClientId: config.oauth.clientId,
    oauthScopeCount: config.oauth.scopes.length,
    upstreamWsBase: config.upstream.wsBase,
    upstreamProtocolVersion: config.upstream.protocolVersion,
    toolsMode: config.tools.mode,
    toolsMaxRounds: config.tools.maxRounds,
    toolsMaxCallsPerRound: config.tools.maxCallsPerRound,
    filesMaxFileBytes: config.files.maxFileBytes,
    filesMaxTotalBytesPerKey: config.files.maxTotalBytesPerKey,
    upstreamImageInput: config.upstreamImageInput,
    contextMaxChars: config.contextMaxChars,
    metricsEnabled: config.metrics.enabled,
    metricsRequireAuth: config.metrics.requireAuth,
    backupRetentionCount: config.backup.retentionCount,
  };
}
