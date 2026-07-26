import { stat } from 'node:fs/promises';
import type { Logger } from 'pino';
import type { AccountRepository } from '../repo/accounts.js';
import { importAccountsFromFile, type ImportSummary } from './importer.js';

/**
 * 外部账号文件的周期性同步。
 *
 * 场景：用户在 Docker 里跑着 M365 Native 授权助手，它会持续把最新 Token 写进
 * `accounts.json`。把该文件只读挂载进本容器并配置 `EXTERNAL_ACCOUNTS_FILE`，
 * 本模块就会跟着更新账号池，账号过期不再中断测试。
 *
 * 设计取舍：
 * - 按文件 mtime 判断是否变化，没变就不做任何写库操作；
 * - 同步失败只记日志、不抛出，不能因为外部文件出问题就拖垮服务；
 * - 只读源文件，永不写回。
 */

export interface ExternalAccountSyncOptions {
  filePath: string;
  accounts: AccountRepository;
  logger: Logger;
  /** 0 表示只在启动时同步一次 */
  intervalMs: number;
}

export interface SyncState {
  last_run_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  last_summary: Omit<ImportSummary, 'skipped'> & { skipped: number } | null;
  file_mtime_ms: number | null;
}

export class ExternalAccountSync {
  readonly #options: ExternalAccountSyncOptions;
  #timer: NodeJS.Timeout | undefined;
  #lastMtimeMs: number | null = null;
  #state: SyncState = {
    last_run_at: null,
    last_success_at: null,
    last_error: null,
    last_summary: null,
    file_mtime_ms: null,
  };

  constructor(options: ExternalAccountSyncOptions) {
    this.#options = options;
  }

  get state(): SyncState {
    return { ...this.#state };
  }

  /** 立即同步一次，然后按间隔periodic 运行（间隔为 0 时不启动定时器）。 */
  async start(): Promise<void> {
    await this.runOnce();
    if (this.#options.intervalMs > 0) {
      this.#timer = setInterval(() => {
        void this.runOnce();
      }, this.#options.intervalMs);
      // 同步任务不应该阻止进程退出
      this.#timer.unref();
    }
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /**
   * 执行一次同步。
   * @param force 忽略 mtime 未变化的判断，强制重新导入
   */
  async runOnce(force = false, now = Date.now()): Promise<SyncState> {
    const { filePath, accounts, logger } = this.#options;
    this.#state.last_run_at = now;

    let mtimeMs: number;
    try {
      const info = await stat(filePath);
      mtimeMs = info.mtimeMs;
    } catch (error) {
      this.#state.last_error = `账号文件不可读：${(error as Error).message}`;
      logger.warn({ file: filePath }, '外部账号文件不可读，跳过本次同步');
      return this.state;
    }

    this.#state.file_mtime_ms = mtimeMs;
    if (!force && this.#lastMtimeMs === mtimeMs) {
      return this.state;
    }

    try {
      const summary = await importAccountsFromFile(
        filePath,
        accounts,
        { sourceLabel: 'sync:m365-native', skipExpired: false },
        now,
      );
      this.#lastMtimeMs = mtimeMs;
      this.#state.last_success_at = now;
      this.#state.last_error = null;
      this.#state.last_summary = {
        total: summary.total,
        created: summary.created,
        updated: summary.updated,
        skipped: summary.skipped.length,
        source_updated_at: summary.source_updated_at,
      };
      logger.info(
        {
          total: summary.total,
          created: summary.created,
          updated: summary.updated,
          skipped: summary.skipped.length,
        },
        '外部账号文件同步完成',
      );
    } catch (error) {
      this.#state.last_error = (error as Error).message;
      logger.warn({ file: filePath, reason: this.#state.last_error }, '外部账号文件同步失败');
    }

    return this.state;
  }
}
