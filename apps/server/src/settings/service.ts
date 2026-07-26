import { ApiError, LOG_PRIVACY_MODES, type LogPrivacyMode } from '@m365-codex/shared';
import type { Logger } from 'pino';
import { MAX_ARG_REPAIRS_CEILING, type AppConfig, type RawEnv } from '../config/index.js';
import type { AuditLogRepository } from '../repo/auditLogs.js';
import type { SettingsRepository } from '../repo/settings.js';
import type { PrivacyModeHolder } from '../observability/privacyMode.js';

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
      // 与 log_level 一样是热生效的例外：debug 的自动过期必须立刻收紧回
      // strict，不能等到不知道什么时候的下次重启（见 #applyHot 与
      // observability/privacyMode.ts 顶部注释）
      requiresRestart: false,
      readConfig: (c) => c.logPrivacyMode,
      validate: (v) =>
        typeof v === 'string' && (LOG_PRIVACY_MODES as readonly string[]).includes(v)
          ? null
          : `必须是 ${LOG_PRIVACY_MODES.join('/')} 之一`,
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
  readonly #privacyMode: PrivacyModeHolder | undefined;
  readonly #auditLogs: AuditLogRepository | undefined;

  constructor(deps: {
    repo: SettingsRepository;
    config: AppConfig;
    logger: Logger;
    /** 用于让 log_privacy_mode 真正热生效；不传时该项的写入只落库，不影响运行时行为 */
    privacyMode?: PrivacyModeHolder;
    /** debug 自动过期时写审计日志；不传时静默跳过（供不关心审计的场景，如轻量单测） */
    auditLogs?: AuditLogRepository;
  }) {
    this.#repo = deps.repo;
    this.#config = deps.config;
    this.#envKeysPresent = deps.config.envKeysPresent;
    this.#logger = deps.logger;
    this.#privacyMode = deps.privacyMode;
    this.#auditLogs = deps.auditLogs;
  }

  getGroup(group: SettingGroup): Record<string, SettingFieldView> {
    const out: Record<string, SettingFieldView> = {};
    for (const def of FIELD_DEFS[group]) {
      out[def.field] = this.#view(group, def);
    }
    if (group === 'logging') {
      // debug_expires_at 不是普通配置项（不能通过 PATCH 直接设置具体时间戳，
      // 只能靠把 log_privacy_mode 切到 debug 间接产生），因此不走 FIELD_DEFS，
      // 单独合成一份只读视图供管理界面展示（契约 §2.3 的扩展）
      out.debug_expires_at = this.#debugExpiresAtView();
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

    // debug 自动过期（§15.3）：只在这次 PATCH 确实改了 log_privacy_mode 时才
    // 重新计算/清除，避免每次改别的日志项（如 log_level）都误触发
    if (group === 'logging' && Object.prototype.hasOwnProperty.call(values, 'log_privacy_mode')) {
      this.#syncDebugExpiry(values.log_privacy_mode as LogPrivacyMode);
    }
    return this.getGroup(group);
  }

  /**
   * debug 到期检查（对应实施计划 §15.3）：过期后自动恢复 strict、清掉过期
   * 时间、写一条审计日志。设计成被 `MaintenanceScheduler` 定时调用，不再
   * 另起一个定时器；返回值是本次是否发生了恢复动作（0 或 1），与其它
   * maintenance job 的 `run()` 约定一致，供调度状态里的“处理条数”展示。
   */
  enforceDebugExpiry(now = Date.now()): number {
    const row = this.#repo.get('logging.debug_expires_at');
    if (row === undefined) return 0;
    const expiresAt = safeParse(row.value);
    if (typeof expiresAt !== 'number' || now < expiresAt) return 0;

    this.#repo.delete('logging.debug_expires_at');
    // env 显式锁定 LOG_PRIVACY_MODE 时不动它的值——正常情况下这不会发生
    // （patchGroup 校验阶段就会拒绝把 env 锁定项写成 'debug'），只有重启时
    // 「settings 表里的历史改动被合成一层 env 覆盖」这个既有机制（见
    // server.ts 的 reloadConfigWithSettings）可能让它在重启后被误判为
    // env 锁定；这种边缘情况下只清掉过期时间、不谎报"已恢复 strict"
    if (!this.#envKeysPresent.has('LOG_PRIVACY_MODE')) {
      this.#repo.set('logging.log_privacy_mode', JSON.stringify('strict'), now);
      this.#privacyMode?.set('strict');
      this.#auditLogs?.record(
        { actor: 'system', action: 'settings.log_privacy_mode.debug_expired', detail: { restored_to: 'strict' } },
        now,
      );
      this.#logger.info('debug 日志隐私模式已到期，自动恢复 strict');
    } else {
      this.#logger.warn(
        'debug 日志隐私模式已到期，但 LOG_PRIVACY_MODE 当前被环境变量锁定，跳过恢复',
      );
    }
    return 1;
  }

  /**
   * 切到 debug 时按配置的 TTL 计算过期时间并落库；切回其它模式时清掉过期
   * 时间，不留悬空状态（一个「已经不是 debug 了、却还有个未来过期时间」的
   * 陈旧记录会误导管理界面）。
   */
  #syncDebugExpiry(mode: LogPrivacyMode, now = Date.now()): void {
    if (mode === 'debug') {
      const expiresAt = now + this.#config.logPrivacyDebugTtlMs;
      this.#repo.set('logging.debug_expires_at', JSON.stringify(expiresAt), now);
    } else {
      this.#repo.delete('logging.debug_expires_at');
    }
  }

  #debugExpiresAtView(): SettingFieldView {
    const row = this.#repo.get('logging.debug_expires_at');
    const raw = row === undefined ? null : safeParse(row.value);
    const value = typeof raw === 'number' ? raw : null;
    return { value, source: value === null ? 'default' : 'db', editable: false, requires_restart: false };
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

  /**
   * 热生效项：`logging.log_level`（pino 的 level 可运行时修改）与
   * `logging.log_privacy_mode`（debug 自动过期必须立刻收紧，见
   * observability/privacyMode.ts）。
   */
  #applyHot(group: SettingGroup, def: FieldDef, value: unknown): void {
    if (group !== 'logging') return;
    if (def.field === 'log_level' && typeof value === 'string') {
      this.#logger.level = value;
    }
    if (def.field === 'log_privacy_mode' && typeof value === 'string') {
      this.#privacyMode?.set(value as LogPrivacyMode);
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
