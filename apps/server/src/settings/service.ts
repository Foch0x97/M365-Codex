import { ApiError } from '@m365-codex/shared';
import type { Logger } from 'pino';
import { MAX_ARG_REPAIRS_CEILING, type AppConfig, type RawEnv } from '../config/index.js';
import type { SettingsRepository } from '../repo/settings.js';

/**
 * 设置读写的分组语义（对应实施计划 §M7、契约 §2.3）。
 *
 * 核心规则：环境变量显式设置过的项 `source: "env"`、`editable: false`——容器
 * 编排是唯一真源，UI 不能悄悄盖掉；其余项存进 `settings` 表，`requires_restart`
 * 为真的项要等下次进程重启（`server.ts` 把 settings 表内容合成 env 覆盖层，
 * 重新走一遍 `loadConfig`）才会生效，此前体现为 `/admin/overview` 的
 * `pending_restart` 列表；只有 `logging.log_level` 是真正热生效的项。
 */

export type SettingGroup = 'network' | 'scheduler' | 'logging' | 'oauth' | 'tools' | 'files';
export const SETTING_GROUPS: readonly SettingGroup[] = [
  'network',
  'scheduler',
  'logging',
  'oauth',
  'tools',
  'files',
];

export type SettingValueType = 'string' | 'number' | 'boolean' | 'string_list';

export interface SettingFieldView {
  value: unknown;
  source: 'env' | 'db' | 'default';
  editable: boolean;
  requires_restart: boolean;
}

interface FieldDef {
  field: string;
  envVar: string;
  type: SettingValueType;
  requiresRestart: boolean;
  /** 当前生效值：来自本进程启动时锁定的 `AppConfig`。 */
  readConfig: (config: AppConfig) => unknown;
  /** 额外的语义校验（类型校验之外），例如上限约束。 */
  validate?: (value: unknown) => string | null;
}

const FIELD_DEFS: Record<SettingGroup, FieldDef[]> = {
  network: [
    {
      field: 'public_api_base_url',
      envVar: 'PUBLIC_API_BASE_URL',
      type: 'string',
      requiresRestart: true,
      readConfig: (c) => c.publicApiBaseUrl,
    },
    {
      field: 'public_admin_url',
      envVar: 'PUBLIC_ADMIN_URL',
      type: 'string',
      requiresRestart: true,
      readConfig: (c) => c.publicAdminUrl,
    },
    {
      field: 'trust_proxy',
      envVar: 'TRUST_PROXY',
      type: 'boolean',
      requiresRestart: true,
      readConfig: (c) => c.trustProxy,
    },
    {
      field: 'http_proxy',
      envVar: 'HTTP_PROXY',
      type: 'string',
      requiresRestart: true,
      readConfig: (c) => c.httpProxy,
    },
    {
      field: 'https_proxy',
      envVar: 'HTTPS_PROXY',
      type: 'string',
      requiresRestart: true,
      readConfig: (c) => c.httpsProxy,
    },
    {
      field: 'no_proxy',
      envVar: 'NO_PROXY',
      type: 'string',
      requiresRestart: true,
      readConfig: (c) => c.noProxy,
    },
  ],
  scheduler: [
    {
      field: 'cleanup_interval_ms',
      envVar: 'CLEANUP_INTERVAL_MS',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.cleanup.intervalMs,
    },
    {
      field: 'response_retention_ms',
      envVar: 'CLEANUP_RESPONSE_RETENTION_MS',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.cleanup.responseRetentionMs,
    },
    {
      field: 'audit_log_retention_ms',
      envVar: 'CLEANUP_AUDIT_LOG_RETENTION_MS',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.cleanup.auditLogRetentionMs,
    },
    {
      field: 'idempotency_retention_ms',
      envVar: 'CLEANUP_IDEMPOTENCY_RETENTION_MS',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.cleanup.idempotencyRetentionMs,
    },
    {
      field: 'files_retention_ms',
      envVar: 'FILES_RETENTION_MS',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.files.retentionMs,
    },
    {
      field: 'files_upload_ttl_ms',
      envVar: 'FILES_UPLOAD_TTL_MS',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.files.uploadTtlMs,
    },
  ],
  logging: [
    {
      field: 'log_level',
      envVar: 'LOG_LEVEL',
      type: 'string',
      requiresRestart: false,
      readConfig: (c) => c.logLevel,
    },
    {
      field: 'log_privacy_mode',
      envVar: 'LOG_PRIVACY_MODE',
      type: 'string',
      requiresRestart: true,
      readConfig: (c) => c.logPrivacyMode,
    },
  ],
  oauth: [
    {
      field: 'client_id',
      envVar: 'OAUTH_CLIENT_ID',
      type: 'string',
      requiresRestart: true,
      readConfig: (c) => c.oauth.clientId,
    },
    {
      field: 'redirect_uri',
      envVar: 'OAUTH_REDIRECT_URI',
      type: 'string',
      requiresRestart: true,
      readConfig: (c) => c.oauth.redirectUri,
    },
    {
      field: 'authorize_url',
      envVar: 'OAUTH_AUTHORIZE_URL',
      type: 'string',
      requiresRestart: true,
      readConfig: (c) => c.oauth.authorizeUrl,
    },
    {
      field: 'token_url',
      envVar: 'OAUTH_TOKEN_URL',
      type: 'string',
      requiresRestart: true,
      readConfig: (c) => c.oauth.tokenUrl,
    },
    {
      field: 'scopes',
      envVar: 'OAUTH_SCOPES',
      type: 'string_list',
      requiresRestart: true,
      readConfig: (c) => c.oauth.scopes,
    },
  ],
  tools: [
    {
      field: 'mode',
      envVar: 'TOOLS_MODE',
      type: 'string',
      requiresRestart: true,
      readConfig: (c) => c.tools.mode,
      validate: (v) => (v === 'native' || v === 'prompt' || v === 'auto' ? null : '必须是 native/prompt/auto 之一'),
    },
    {
      field: 'max_calls_per_round',
      envVar: 'TOOLS_MAX_CALLS_PER_ROUND',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.tools.maxCallsPerRound,
    },
    {
      field: 'max_rounds',
      envVar: 'TOOLS_MAX_ROUNDS',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.tools.maxRounds,
    },
    {
      field: 'max_total_calls',
      envVar: 'TOOLS_MAX_TOTAL_CALLS',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.tools.maxTotalCalls,
    },
    {
      field: 'max_result_bytes',
      envVar: 'TOOLS_MAX_RESULT_BYTES',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.tools.maxResultBytes,
    },
    {
      field: 'max_arg_repairs',
      envVar: 'TOOLS_MAX_ARG_REPAIRS',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.tools.maxArgRepairs,
      // 上限被协议规则锁死为 2（§7.3），设置项不能突破这个天花板
      validate: (v) =>
        typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_ARG_REPAIRS_CEILING
          ? null
          : `必须是 0-${MAX_ARG_REPAIRS_CEILING} 的整数`,
    },
    {
      field: 'allow_parallel',
      envVar: 'TOOLS_ALLOW_PARALLEL',
      type: 'boolean',
      requiresRestart: true,
      readConfig: (c) => c.tools.allowParallel,
    },
  ],
  files: [
    {
      field: 'max_file_bytes',
      envVar: 'FILES_MAX_FILE_BYTES',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.files.maxFileBytes,
    },
    {
      field: 'max_request_bytes',
      envVar: 'FILES_MAX_REQUEST_BYTES',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.files.maxRequestBytes,
    },
    {
      field: 'max_total_bytes_per_key',
      envVar: 'FILES_MAX_TOTAL_BYTES_PER_KEY',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.files.maxTotalBytesPerKey,
    },
  ],
};

function validateType(type: SettingValueType, value: unknown): string | null {
  switch (type) {
    case 'string':
      return typeof value === 'string' ? null : '必须是字符串';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : '必须是数字';
    case 'boolean':
      return typeof value === 'boolean' ? null : '必须是布尔值';
    case 'string_list':
      return Array.isArray(value) && value.every((v) => typeof v === 'string') ? null : '必须是字符串数组';
    default:
      return null;
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class SettingsService {
  readonly #repo: SettingsRepository;
  readonly #config: AppConfig;
  readonly #envKeysPresent: ReadonlySet<string>;
  readonly #logger: Logger;

  constructor(deps: { repo: SettingsRepository; config: AppConfig; logger: Logger }) {
    this.#repo = deps.repo;
    this.#config = deps.config;
    this.#envKeysPresent = deps.config.envKeysPresent;
    this.#logger = deps.logger;
  }

  getGroup(group: SettingGroup): Record<string, SettingFieldView> {
    const out: Record<string, SettingFieldView> = {};
    for (const def of FIELD_DEFS[group]) {
      out[def.field] = this.#view(group, def);
    }
    return out;
  }

  getAll(): Record<SettingGroup, Record<string, SettingFieldView>> {
    const out = {} as Record<SettingGroup, Record<string, SettingFieldView>>;
    for (const group of SETTING_GROUPS) out[group] = this.getGroup(group);
    return out;
  }

  /** 批量写一个分组；任何一项不合法或触碰 env 锁定项都整体拒绝，不留半截更新。 */
  patchGroup(group: SettingGroup, values: Record<string, unknown>): Record<string, SettingFieldView> {
    const defs = FIELD_DEFS[group];
    if (defs === undefined) throw ApiError.badRequest(`未知的设置分组：${group}`, 'group');
    const byField = new Map(defs.map((d) => [d.field, d]));

    for (const field of Object.keys(values)) {
      const def = byField.get(field);
      if (def === undefined) {
        throw ApiError.badRequest(`未知的设置项：${group}.${field}`, field);
      }
      if (this.#envKeysPresent.has(def.envVar)) {
        throw ApiError.forbidden(
          `${group}.${field} 由环境变量 ${def.envVar} 显式设置，容器编排是唯一真源，不能通过管理界面修改`,
        );
      }
      const value = values[field];
      const typeError = validateType(def.type, value);
      const semanticError = typeError === null ? (def.validate?.(value) ?? null) : null;
      const error = typeError ?? semanticError;
      if (error !== null) throw ApiError.badRequest(error, field);
    }

    // 校验全部通过后再落库，避免一半写入一半报错
    for (const field of Object.keys(values)) {
      const def = byField.get(field);
      if (def === undefined) continue;
      this.#repo.set(`${group}.${field}`, JSON.stringify(values[field]));
      if (!def.requiresRestart) this.#applyHot(group, def, values[field]);
    }
    return this.getGroup(group);
  }

  /** `/admin/overview` 用：改了但要等重启才生效的配置项（以环境变量名表示）。 */
  pendingRestartEnvVars(): string[] {
    const names: string[] = [];
    for (const group of SETTING_GROUPS) {
      for (const def of FIELD_DEFS[group]) {
        if (!def.requiresRestart) continue;
        if (this.#envKeysPresent.has(def.envVar)) continue; // env 是唯一真源，没有"待生效"一说
        const row = this.#repo.get(`${group}.${def.field}`);
        if (row === undefined) continue;
        const stored = safeParse(row.value);
        const active = def.readConfig(this.#config);
        if (!deepEqual(stored, active)) names.push(def.envVar);
      }
    }
    return names;
  }

  #view(group: SettingGroup, def: FieldDef): SettingFieldView {
    if (this.#envKeysPresent.has(def.envVar)) {
      return {
        value: def.readConfig(this.#config),
        source: 'env',
        editable: false,
        requires_restart: def.requiresRestart,
      };
    }
    const row = this.#repo.get(`${group}.${def.field}`);
    if (row !== undefined) {
      return { value: safeParse(row.value), source: 'db', editable: true, requires_restart: def.requiresRestart };
    }
    return {
      value: def.readConfig(this.#config),
      source: 'default',
      editable: true,
      requires_restart: def.requiresRestart,
    };
  }

  /** 目前只有 `logging.log_level` 真正无需重启即可生效：pino 的 level 可运行时修改。 */
  #applyHot(group: SettingGroup, def: FieldDef, value: unknown): void {
    if (group === 'logging' && def.field === 'log_level' && typeof value === 'string') {
      this.#logger.level = value;
    }
  }
}

function toEnvString(type: SettingValueType, value: unknown): string | null {
  switch (type) {
    case 'string':
      return typeof value === 'string' ? value : null;
    case 'number':
      return typeof value === 'number' ? String(value) : null;
    case 'boolean':
      return typeof value === 'boolean' ? String(value) : null;
    case 'string_list':
      return Array.isArray(value) ? value.join(' ') : null;
    default:
      return null;
  }
}

/**
 * 把 settings 表里「需要重启才生效」的历史改动，合成一层 env 覆盖，供 `server.ts`
 * 在下一次启动时重新 `loadConfig()`。环境变量本身显式设置过的项永远不被覆盖。
 */
export function buildEnvOverridesFromSettings(
  repo: SettingsRepository,
  envKeysPresent: ReadonlySet<string>,
): RawEnv {
  const overrides: RawEnv = {};
  for (const group of SETTING_GROUPS) {
    for (const def of FIELD_DEFS[group]) {
      if (envKeysPresent.has(def.envVar)) continue;
      const row = repo.get(`${group}.${def.field}`);
      if (row === undefined) continue;
      const str = toEnvString(def.type, safeParse(row.value));
      if (str !== null) overrides[def.envVar] = str;
    }
  }
  return overrides;
}
