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
  readonly logLevel: string;
  readonly upstreamWsBase: string | null;
  readonly httpProxy: string | null;
  readonly httpsProxy: string | null;
  readonly noProxy: string | null;
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
});

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
    logLevel: data.LOG_LEVEL ?? 'info',
    upstreamWsBase: data.UPSTREAM_WS_BASE ?? null,
    httpProxy: data.HTTP_PROXY ?? null,
    httpsProxy: data.HTTPS_PROXY ?? null,
    noProxy: data.NO_PROXY ?? null,
  });
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
  };
}
