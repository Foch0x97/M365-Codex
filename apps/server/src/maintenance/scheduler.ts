import type { Logger } from 'pino';

/**
 * 定时维护任务调度（对应实施计划 §18 的「定时清理」）。
 *
 * 只做三件事：按间隔跑、单任务失败不影响其它任务、记录上次结果供管理界面显示。
 * 不引 cron 库：这里的任务都是「每隔 N 分钟跑一次」，不需要 cron 表达式。
 *
 * 设计取舍：
 * - 任务串行执行。清理任务都在同一个 SQLite 上写，并发跑只会互相抢锁；
 * - 首轮延迟一小段时间再跑，避免刚启动就和迁移、预热抢 I/O；
 * - `unref()` 定时器，让进程能正常退出，不被清理任务吊住。
 */

export interface MaintenanceJob {
  name: string;
  /** 运行间隔（毫秒） */
  intervalMs: number;
  /** 返回处理条数，用于日志与管理界面展示 */
  run: () => number | Promise<number>;
}

export interface JobStatus {
  name: string;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastAffected: number | null;
  lastError: string | null;
  runCount: number;
}

export class MaintenanceScheduler {
  readonly #jobs: MaintenanceJob[] = [];
  readonly #status = new Map<string, JobStatus>();
  readonly #logger: Logger;
  readonly #timers: NodeJS.Timeout[] = [];
  #started = false;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  register(job: MaintenanceJob): void {
    if (this.#started) throw new Error('调度已启动后不能再注册任务');
    this.#jobs.push(job);
    this.#status.set(job.name, {
      name: job.name,
      lastRunAt: null,
      lastDurationMs: null,
      lastAffected: null,
      lastError: null,
      runCount: 0,
    });
  }

  /** 立即执行一个任务（管理界面的「立即清理」按钮走这里）。 */
  async runNow(name: string): Promise<JobStatus> {
    const job = this.#jobs.find((j) => j.name === name);
    if (job === undefined) throw new Error(`没有名为 ${name} 的维护任务`);
    await this.#execute(job);
    return this.#status.get(name) as JobStatus;
  }

  /** 全部跑一遍，返回各任务状态。 */
  async runAll(): Promise<JobStatus[]> {
    for (const job of this.#jobs) {
      await this.#execute(job);
    }
    return this.statuses();
  }

  start(options: { initialDelayMs?: number } = {}): void {
    if (this.#started) return;
    this.#started = true;
    const initialDelay = options.initialDelayMs ?? 30_000;

    for (const job of this.#jobs) {
      const timer = setInterval(() => {
        void this.#execute(job);
      }, job.intervalMs);
      timer.unref();
      this.#timers.push(timer);

      const kickoff = setTimeout(() => {
        void this.#execute(job);
      }, initialDelay);
      kickoff.unref();
      this.#timers.push(kickoff);
    }
    this.#logger.info({ jobs: this.#jobs.map((j) => j.name) }, '维护任务调度已启动');
  }

  stop(): void {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers.length = 0;
    this.#started = false;
  }

  statuses(): JobStatus[] {
    return [...this.#status.values()];
  }

  async #execute(job: MaintenanceJob): Promise<void> {
    const status = this.#status.get(job.name) as JobStatus;
    const startedAt = Date.now();
    try {
      const affected = await job.run();
      status.lastAffected = affected;
      status.lastError = null;
      if (affected > 0) {
        this.#logger.info({ job: job.name, affected }, '维护任务清理了记录');
      }
    } catch (error) {
      // 单个任务炸掉不能影响其它任务，也不能把进程带走
      status.lastError = (error as Error).message;
      status.lastAffected = null;
      this.#logger.warn({ job: job.name, err_msg: status.lastError }, '维护任务执行失败');
    } finally {
      status.lastRunAt = startedAt;
      status.lastDurationMs = Date.now() - startedAt;
      status.runCount += 1;
    }
  }
}
