import type { Logger } from 'pino';
import type { AccountRepository } from '../repo/accounts.js';
import type { Metrics } from '../observability/metrics.js';
import { OAuthRequestError, type OAuthClient } from './client.js';
import { computeExpiry } from './service.js';

/**
 * Access Token 的按需刷新。
 *
 * 关键约束：
 * - **同账号只允许一个刷新任务**。并发请求共享同一个 Promise，否则多个刷新
 *   会互相覆盖 refresh_token，把账号刷坏；
 * - 写回是事务化的原子替换；
 * - `invalid_grant` 说明 refresh_token 作废，账号转入 `reauth_required`，
 *   不再反复重试；
 * - 全程不打印 Token，日志里只有账号 ID 与错误码。
 */

/** 提前多久刷新：Token 剩余寿命少于该值时主动换新。 */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

export class TokenUnavailableError extends Error {
  readonly accountId: string;
  readonly reason: 'no_token' | 'no_refresh_token' | 'reauth_required' | 'refresh_failed';

  constructor(accountId: string, reason: TokenUnavailableError['reason'], message: string) {
    super(message);
    this.name = 'TokenUnavailableError';
    this.accountId = accountId;
    this.reason = reason;
  }
}

export interface TokenManagerDeps {
  accounts: AccountRepository;
  client: OAuthClient;
  logger: Logger;
  skewMs?: number;
  /** 按账号解析出口代理，绑定后 Token 刷新走同一个出口（对应实施计划 §13.1）。 */
  resolveProxyForAccount?: (accountId: string) => string | null;
  /** M8：Token 刷新结果打点（§17） */
  metrics?: Metrics;
}

export class TokenManager {
  readonly #accounts: AccountRepository;
  readonly #client: OAuthClient;
  readonly #logger: Logger;
  readonly #skewMs: number;
  readonly #resolveProxyForAccount: ((accountId: string) => string | null) | undefined;
  readonly #metrics: Metrics | undefined;
  /** accountId → 进行中的刷新任务，保证同账号单飞 */
  readonly #inFlight = new Map<string, Promise<string>>();

  constructor(deps: TokenManagerDeps) {
    this.#accounts = deps.accounts;
    this.#client = deps.client;
    this.#logger = deps.logger;
    this.#skewMs = deps.skewMs ?? REFRESH_SKEW_MS;
    this.#resolveProxyForAccount = deps.resolveProxyForAccount;
    this.#metrics = deps.metrics;
  }

  /** 取一个当前可用的 access token，必要时先刷新。 */
  async getAccessToken(accountId: string, now = Date.now()): Promise<string> {
    const current = this.#accounts.readAccessToken(accountId);
    if (current === null) {
      throw new TokenUnavailableError(accountId, 'no_token', '该账号没有已保存的 Token');
    }
    const expiresAt = current.expiresAt;
    if (expiresAt !== null && expiresAt - now > this.#skewMs) {
      return current.token;
    }
    return this.refresh(accountId, now);
  }

  /** 强制刷新。同账号并发调用会复用同一个进行中的任务。 */
  async refresh(accountId: string, now = Date.now()): Promise<string> {
    const existing = this.#inFlight.get(accountId);
    if (existing !== undefined) return existing;

    const task = this.#doRefresh(accountId, now).finally(() => {
      this.#inFlight.delete(accountId);
    });
    this.#inFlight.set(accountId, task);
    return task;
  }

  /** 当前是否有进行中的刷新任务，供测试与可观测性使用。 */
  isRefreshing(accountId: string): boolean {
    return this.#inFlight.has(accountId);
  }

  async #doRefresh(accountId: string, now: number): Promise<string> {
    const account = this.#accounts.findById(accountId);
    if (account === undefined) {
      throw new TokenUnavailableError(accountId, 'no_token', '账号不存在');
    }
    if (account.status === 'reauth_required') {
      throw new TokenUnavailableError(
        accountId,
        'reauth_required',
        '该账号需要重新授权，刷新凭据已失效',
      );
    }

    const refreshToken = this.#accounts.readRefreshToken(accountId);
    if (refreshToken === null) {
      // 没有 refresh_token 就无从自动续期，直接要求重新授权
      this.#accounts.forceStatus(accountId, 'reauth_required', now);
      this.#metrics?.tokenRefresh.inc({ result: 'no_refresh_token' });
      throw new TokenUnavailableError(
        accountId,
        'no_refresh_token',
        '该账号没有 refresh_token，无法自动刷新',
      );
    }

    try {
      const proxyUrl = this.#resolveProxyForAccount?.(accountId) ?? undefined;
      const tokens = await this.#client.refresh({ refreshToken, proxyUrl });
      this.#accounts.replaceTokens(
        accountId,
        {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? null,
          expiresAt: computeExpiry(tokens.expires_in, now),
        },
        now,
      );
      this.#accounts.recordSuccess(accountId, now);
      if (account.status === 'error' || account.status === 'cooldown') {
        this.#accounts.forceStatus(accountId, 'probing', now);
      }
      this.#metrics?.tokenRefresh.inc({ result: 'success' });
      this.#logger.info({ account_id: accountId }, 'Token 刷新成功');
      return tokens.access_token;
    } catch (error) {
      if (error instanceof OAuthRequestError && error.requiresReauth) {
        this.#accounts.forceStatus(accountId, 'reauth_required', now);
        this.#accounts.recordFailure(accountId, error.errorCode, {}, now);
        this.#metrics?.tokenRefresh.inc({ result: 'reauth_required' });
        this.#logger.warn(
          { account_id: accountId, oauth_error: error.errorCode },
          '刷新凭据已失效，账号转入 reauth_required',
        );
        throw new TokenUnavailableError(
          accountId,
          'reauth_required',
          `刷新凭据已失效（${error.errorCode}），需要重新授权`,
        );
      }

      const errorCode = error instanceof OAuthRequestError ? error.errorCode : 'network_error';
      this.#accounts.recordFailure(accountId, errorCode, {}, now);
      this.#metrics?.tokenRefresh.inc({ result: 'failure' });
      this.#logger.warn({ account_id: accountId, oauth_error: errorCode }, 'Token 刷新失败');
      throw new TokenUnavailableError(accountId, 'refresh_failed', `Token 刷新失败（${errorCode}）`);
    }
  }
}
