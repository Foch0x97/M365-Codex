import type { AccountRepository, AccountView } from '../repo/accounts.js';

/**
 * 账号池选择与并发计数。
 *
 * 选择策略：带权最少连接（weighted least-connections）。
 * - 只在「可用」账号里选：状态为 online / probing / busy，且不在冷却期；
 * - 连接数越少越优先；并列时连续失败次数少的优先；
 * - 支持排除集合（本次请求已经试过并失败的账号）。
 *
 * 并发计数存在内存里——它反映的是「本进程此刻正占用某账号的连接数」，
 * 属于运行时状态，不需要持久化。
 */

/** 可参与调度的账号状态。 */
const SCHEDULABLE_STATUSES = new Set(['online', 'probing', 'busy']);

export interface PickOptions {
  /** 本次请求已排除的账号（试过且失败） */
  exclude?: ReadonlySet<string>;
  /** 优先尝试的账号（粘性：上一轮绑定的账号） */
  prefer?: string | null;
  now?: number;
}

export class AccountPool {
  readonly #accounts: AccountRepository;
  /** accountId → 当前活跃连接数 */
  readonly #active = new Map<string, number>();

  constructor(accounts: AccountRepository) {
    this.#accounts = accounts;
  }

  activeCount(accountId: string): number {
    return this.#active.get(accountId) ?? 0;
  }

  acquire(accountId: string): void {
    this.#active.set(accountId, this.activeCount(accountId) + 1);
  }

  release(accountId: string): void {
    const next = this.activeCount(accountId) - 1;
    if (next <= 0) this.#active.delete(accountId);
    else this.#active.set(accountId, next);
  }

  /** 当前是否存在任何可调度账号（忽略排除集）。用于区分「池空」与「都被排除了」。 */
  hasAnySchedulable(now = Date.now()): boolean {
    return this.#accounts.listViews().some((account) => this.#isUsable(account, now));
  }

  /**
   * 选一个账号。返回 null 表示没有可用账号（调用方据此返回 503）。
   * prefer 命中且可用时直接返回它，实现请求↔账号粘性。
   */
  pick(options: PickOptions = {}): AccountView | null {
    const now = options.now ?? Date.now();
    const exclude = options.exclude ?? new Set<string>();
    const candidates = this.#accounts
      .listViews()
      .filter((account) => this.#isUsable(account, now) && !exclude.has(account.id));

    if (candidates.length === 0) return null;

    if (options.prefer != null && !exclude.has(options.prefer)) {
      const preferred = candidates.find((account) => account.id === options.prefer);
      if (preferred !== undefined) return preferred;
    }

    // 带权最少连接：先比活跃连接数，再比连续失败数，最后比 updated_at 求稳定
    return candidates.sort((a, b) => {
      const activeDiff = this.activeCount(a.id) - this.activeCount(b.id);
      if (activeDiff !== 0) return activeDiff;
      const failDiff = a.consecutive_failures - b.consecutive_failures;
      if (failDiff !== 0) return failDiff;
      return a.updated_at - b.updated_at;
    })[0] as AccountView;
  }

  #isUsable(account: AccountView, now: number): boolean {
    if (!SCHEDULABLE_STATUSES.has(account.status)) return false;
    if (account.cooldown_until !== null && account.cooldown_until > now) return false;
    return true;
  }
}
