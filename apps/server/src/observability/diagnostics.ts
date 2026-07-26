import type { AccountStatus } from '@m365-codex/shared';

/**
 * 诊断包（对应实施计划 §17）。
 *
 * 目的：用户报障时能一次性交出「足以定位问题」的信息，且**交出去不会泄露任何东西**。
 * 因此这里是纯函数 + 显式白名单：只汇总结构化的计数与配置摘要，
 * 绝不接触提示词、输出正文、邮箱、Token、文件名。
 *
 * 判断某项该不该进诊断包的标准很简单：把它贴到公开的 issue 里会不会后悔。
 */

export type SystemStatus =
  | 'normal'
  | 'degraded'
  | 'maintenance'
  | 'upstream_unavailable'
  | 'migration_failed';

export interface DiagnosticsInput {
  appVersion: string;
  schemaVersion: number;
  expectedSchemaVersion: number;
  startedAt: number;
  now: number;
  /** 各状态的账号数量，不含任何账号标识 */
  accountsByStatus: Record<AccountStatus, number>;
  /** 最近一段时间内按错误分类计数，不含错误消息原文 */
  recentErrorsByType: Record<string, number>;
  inFlightRequests: number;
  /** 配置摘要，必须已经脱敏（summarizeConfig 的输出） */
  configSummary: Record<string, unknown>;
  storage: { dbBytes: number; filesBytes: number; fileCount: number };
  maintenanceJobs: { name: string; lastRunAt: number | null; lastError: string | null }[];
  readiness: { name: string; ok: boolean }[];
}

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
  maintenance: { name: string; last_run_at: number | null; last_error: string | null }[];
  readiness: { name: string; ok: boolean }[];
  config: Record<string, unknown>;
  notes: string[];
}

/** 能被调度器选中的状态。其余状态（冷却、需重新授权、停用…）不算可用。 */
const USABLE_STATUSES: AccountStatus[] = ['online', 'busy'];

/**
 * 判定系统状态（§17 的状态枚举）。
 * 顺序有意为之：迁移失败最严重，其次是完全没有可用账号，再次是「有但不健康」。
 */
export function deriveSystemStatus(input: {
  schemaOk: boolean;
  readinessOk: boolean;
  usableAccounts: number;
  totalAccounts: number;
}): SystemStatus {
  if (!input.schemaOk) return 'migration_failed';
  if (!input.readinessOk) return 'degraded';
  // 一个账号都没添加过，属于「还没配置完」，不是上游挂了
  if (input.totalAccounts > 0 && input.usableAccounts === 0) return 'upstream_unavailable';
  if (input.totalAccounts === 0) return 'degraded';
  return 'normal';
}

export function buildDiagnostics(input: DiagnosticsInput): DiagnosticsReport {
  const schemaOk = input.schemaVersion === input.expectedSchemaVersion;
  const totalAccounts = Object.values(input.accountsByStatus).reduce((sum, n) => sum + n, 0);
  const usableAccounts = USABLE_STATUSES.reduce(
    (sum, status) => sum + (input.accountsByStatus[status] ?? 0),
    0,
  );
  const readinessOk = input.readiness.every((check) => check.ok);

  const notes: string[] = [];
  if (!schemaOk) {
    notes.push(`数据库结构版本 v${input.schemaVersion} 与程序期望的 v${input.expectedSchemaVersion} 不一致`);
  }
  if (totalAccounts === 0) {
    notes.push('尚未添加任何 Microsoft 账号，请先在管理界面完成 PKCE 授权');
  } else if (usableAccounts === 0) {
    notes.push('所有账号当前都不可调度（冷却、需重新授权或已停用）');
  }
  for (const job of input.maintenanceJobs) {
    if (job.lastError !== null) notes.push(`维护任务 ${job.name} 上次执行失败`);
  }

  return {
    generated_at: input.now,
    app_version: input.appVersion,
    system_status: deriveSystemStatus({ schemaOk, readinessOk, usableAccounts, totalAccounts }),
    uptime_ms: input.now - input.startedAt,
    schema: { current: input.schemaVersion, expected: input.expectedSchemaVersion, ok: schemaOk },
    accounts: { ...input.accountsByStatus },
    accounts_usable: usableAccounts,
    in_flight_requests: input.inFlightRequests,
    recent_errors: { ...input.recentErrorsByType },
    storage: {
      db_bytes: input.storage.dbBytes,
      files_bytes: input.storage.filesBytes,
      file_count: input.storage.fileCount,
    },
    maintenance: input.maintenanceJobs.map((job) => ({
      name: job.name,
      last_run_at: job.lastRunAt,
      last_error: job.lastError,
    })),
    readiness: input.readiness.map((check) => ({ name: check.name, ok: check.ok })),
    config: input.configSummary,
    notes,
  };
}
