import { ApiError } from '@m365-codex/shared';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { UpstreamConfig } from '../config/index.js';
import { buildUpstreamUrl } from '../adapter/endpoint.js';
import { UpstreamError } from '../adapter/errors.js';
import type {
  ProtocolCodec,
  ToolDeclaration,
  ToolResultInput,
  UpstreamEvent,
} from '../adapter/protocol.js';
import { SydneyConnection, type ConnectionDeps } from '../adapter/connection.js';
import type { AccountRepository } from '../repo/accounts.js';
import { TokenUnavailableError, type TokenManager } from '../oauth/tokenManager.js';
import type { Metrics } from '../observability/metrics.js';
import type { AccountPool } from './accountPool.js';

/**
 * 上游调度器：把「一次对话请求」路由到某个账号的上游连接，并在失败时
 * 按错误分类做刷新 / 冷却 / 切换（对应实施计划 §M3 DoD）。
 *
 * 失败处置：
 * - 401 → 刷新一次 Token，在同一账号重试一次；
 * - 403 / 策略关闭 → 冷却该账号并切换，不无限切换（账号进排除集）；
 * - 429 → 按 Retry-After 冷却该账号，切换到别的账号；
 * - 5xx / WS 断开 → 有限次重试，可切换；
 * - 4xx（非 401/403/429）→ 视为致命，直接失败。
 *
 * 「切账号用本地内容重建上下文」：本层每次尝试都用**原始请求文本**重新发起
 * invocation。因此**只有在尚未向下游吐出任何内容时**才做切换/重试；一旦已经
 * 有 text_delta 流出，中途失败会如实抛出——干净的断点续传与工具幂等属于 M4/M5。
 */

export interface DispatchRequest {
  /** 用户本轮输入的纯文本（M3 仅文本） */
  text: string;
  /** 粘性绑定：上一轮用的账号与上游会话引用 */
  sticky?: { accountId: string; conversationRef: string | null } | null;
  /** 透传给上游的参数（model / reasoning.effort 等，不改写） */
  passthrough?: Record<string, unknown> | undefined;
  /** 本轮可用的工具声明（M5） */
  tools?: readonly ToolDeclaration[] | undefined;
  /** 工具执行结果回传（M5，续接时带上） */
  toolResults?: readonly ToolResultInput[] | undefined;
  /**
   * 本次请求是否可能触发副作用（携带工具结果回传时为真）。
   * 副作用阶段禁止自动跨账号重放——一旦失败不切换账号，如实抛出。
   */
  sideEffect?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface DispatchResult {
  /** 本次实际使用的账号 */
  accountId: string;
  /** 上游会话引用（供上层持久化，实现续接） */
  conversationRef: string | null;
  /** 归一化事件流 */
  events: AsyncGenerator<UpstreamEvent>;
}

export interface DispatcherDeps {
  config: UpstreamConfig;
  codec: ProtocolCodec;
  accounts: AccountRepository;
  pool: AccountPool;
  tokens: TokenManager;
  logger: Logger;
  proxyUrl?: string | null;
  /** NO_PROXY 排除列表，透传给连接层；命中的目标主机即使配了代理也直连 */
  noProxy?: string | null;
  /**
   * 按账号解析出口代理（对应实施计划 §13.1「账号绑定代理后保持出口粘性」）。
   * 返回 null 表示该账号未绑定代理或绑定的节点已停用，回退到 `proxyUrl` 全局默认值。
   */
  resolveProxyForAccount?: (accountId: string) => string | null;
  /** 注入连接实现，测试用 */
  connectionFactory?: (deps: ConnectionDeps) => SydneyConnection;
  /** 单次请求最多尝试多少个账号（含重试），默认 4 */
  maxAttempts?: number;
  /** 403 / 429 之外的默认冷却时长（毫秒） */
  defaultCooldownMs?: number;
  /** M8：上游调用与错误分类打点（§17） */
  metrics?: Metrics;
}

export class UpstreamDispatcher {
  readonly #deps: DispatcherDeps;
  readonly #maxAttempts: number;
  readonly #defaultCooldownMs: number;

  constructor(deps: DispatcherDeps) {
    this.#deps = deps;
    this.#maxAttempts = deps.maxAttempts ?? 4;
    this.#defaultCooldownMs = deps.defaultCooldownMs ?? 30_000;
  }

  /**
   * 调度一次对话。返回选中的账号、上游会话引用，以及事件流。
   * 事件流内部完成账号选择与失败切换；池中无可用账号时抛
   * `503 account_pool_exhausted`。
   */
  dispatch(request: DispatchRequest): DispatchResult {
    // 先确定首选账号是否可用，以便同步返回 accountId；真正的连接在事件流里建立
    const state: { accountId: string; conversationRef: string | null } = {
      accountId: '',
      conversationRef: request.sticky?.conversationRef ?? null,
    };
    const events = this.#runWithFailover(request, state);
    return {
      get accountId() {
        return state.accountId;
      },
      get conversationRef() {
        return state.conversationRef;
      },
      events,
    };
  }

  async *#runWithFailover(
    request: DispatchRequest,
    state: { accountId: string; conversationRef: string | null },
  ): AsyncGenerator<UpstreamEvent> {
    const { pool, logger } = this.#deps;
    const excluded = new Set<string>();
    let emittedContent = false;
    let attempts = 0;
    let lastError: UpstreamError | TokenUnavailableError | null = null;

    while (attempts < this.#maxAttempts) {
      const account = pool.pick({
        exclude: excluded,
        prefer: attempts === 0 ? (request.sticky?.accountId ?? null) : null,
      });

      if (account === null) {
        // 区分「池里本来就没有可用账号」与「都被本次请求排除了」
        if (!pool.hasAnySchedulable()) {
          throw new ApiError({
            type: 'account_pool_exhausted',
            status: 503,
            message: '没有可用的 Microsoft 账号',
          });
        }
        break; // 有可用账号但都被排除，退出循环由下面统一处理
      }

      attempts += 1;
      state.accountId = account.id;
      pool.acquire(account.id);
      this.#deps.metrics?.upstreamAttempts.inc({ result: 'started' });

      try {
        // 取 Token（必要时刷新）
        let accessToken: string;
        try {
          accessToken = await this.#deps.tokens.getAccessToken(account.id);
        } catch (error) {
          if (error instanceof TokenUnavailableError) {
            lastError = error;
            // 账号本身取不到 Token（需重新授权等）：排除后换账号
            excluded.add(account.id);
            logger.warn({ account_id: account.id, reason: error.reason }, '账号 Token 不可用，切换');
            continue;
          }
          throw error;
        }

        const url = buildUpstreamUrl({
          config: this.#deps.config,
          oid: account.oid,
          tid: account.tid,
          accessToken,
        });

        // 账号绑定的出口优先：同一账号的长连接固定走同一个代理，避免频繁切换网络出口
        const proxyUrl = this.#deps.resolveProxyForAccount?.(account.id) ?? this.#deps.proxyUrl ?? null;
        const connection = (this.#deps.connectionFactory ?? defaultConnectionFactory)({
          config: this.#deps.config,
          codec: this.#deps.codec,
          logger,
          proxyUrl,
          noProxy: this.#deps.noProxy ?? null,
        });

        const invocationId = randomUUID();
        let retriedAfterRefresh = false;

        try {
          for await (const event of connection.run({
            url,
            invocationId,
            text: request.text,
            conversationRef: state.conversationRef ?? undefined,
            oid: account.oid,
            passthrough: request.passthrough,
            tools: request.tools,
            toolResults: request.toolResults,
            signal: request.signal,
          })) {
            // 文本、推理、工具调用都算「已产出内容」——之后失败不再切换账号，
            // 避免副作用工具调用被跨账号重放执行（§M5）
            if (
              event.kind === 'text_delta' ||
              event.kind === 'reasoning_delta' ||
              event.kind === 'tool_call_begin'
            ) {
              emittedContent = true;
            }
            if (event.kind === 'upstream_error' && !event.retryable) {
              // 上游在流内报了不可重试的错误
              this.#deps.accounts.recordFailure(account.id, 'upstream_error');
            }
            yield event;
          }
          // 正常跑完
          this.#deps.accounts.recordSuccess(account.id);
          this.#deps.metrics?.upstreamAttempts.inc({ result: 'success' });
          return;
        } catch (error) {
          const upstreamError =
            error instanceof UpstreamError
              ? error
              : new UpstreamError(
                  `未分类上游错误：${error instanceof Error ? error.message : String(error)}`,
                  'unknown',
                  { cause: error },
                );
          lastError = upstreamError;
          this.#deps.metrics?.upstreamAttempts.inc({ result: 'error' });
          this.#deps.metrics?.upstreamErrors.inc({ disposition: upstreamError.disposition });

          // 已经吐过内容就不能干净切换，如实抛出
          if (emittedContent) {
            this.#deps.accounts.recordFailure(account.id, upstreamError.disposition);
            throw this.#toApiError(upstreamError);
          }

          // 副作用请求（回传工具结果）禁止跨账号重放：即便还没吐内容，
          // 换账号重发也可能让已执行过的副作用工具再执行一次，故直接失败
          if (request.sideEffect === true) {
            this.#deps.accounts.recordFailure(account.id, upstreamError.disposition);
            throw this.#toApiError(upstreamError);
          }

          const decision = this.#applyDisposition(account.id, upstreamError, excluded);
          if (decision === 'fatal') {
            throw this.#toApiError(upstreamError);
          }
          if (decision === 'refresh_retry' && !retriedAfterRefresh) {
            // 401：刷新一次，在同一账号再试一次（不排除）
            retriedAfterRefresh = true;
            try {
              await this.#deps.tokens.refresh(account.id);
              attempts -= 1; // 这次刷新重试不计入尝试上限
            } catch {
              excluded.add(account.id);
            }
          }
          continue;
        } finally {
          pool.release(account.id);
        }
      } catch (outerError) {
        pool.release(account.id);
        throw outerError;
      }
    }

    // 尝试用尽或账号都被排除
    if (lastError !== null) {
      if (lastError instanceof UpstreamError) throw this.#toApiError(lastError);
      throw new ApiError({
        type: 'account_pool_exhausted',
        status: 503,
        message: '所有候选账号均不可用',
      });
    }
    throw new ApiError({
      type: 'account_pool_exhausted',
      status: 503,
      message: '没有可用的 Microsoft 账号',
    });
  }

  /**
   * 按错误分类更新账号状态并决定后续动作。
   * 返回 'switch' 换账号 / 'refresh_retry' 刷新重试同账号 / 'fatal' 直接失败。
   */
  #applyDisposition(
    accountId: string,
    error: UpstreamError,
    excluded: Set<string>,
    now = Date.now(),
  ): 'switch' | 'refresh_retry' | 'fatal' {
    const { accounts } = this.#deps;
    switch (error.disposition) {
      case 'refresh_and_retry':
        accounts.recordFailure(accountId, 'unauthorized');
        return 'refresh_retry';
      case 'account_forbidden':
        accounts.recordFailure(accountId, 'forbidden', {
          cooldownUntil: now + this.#defaultCooldownMs,
        });
        excluded.add(accountId);
        return 'switch';
      case 'rate_limited':
        accounts.recordFailure(accountId, 'rate_limited', {
          cooldownUntil: now + (error.retryAfterMs ?? this.#defaultCooldownMs),
        });
        excluded.add(accountId);
        return 'switch';
      case 'retry_or_switch':
      case 'unknown':
        accounts.recordFailure(accountId, 'upstream_error');
        excluded.add(accountId);
        return 'switch';
      case 'fatal_client':
        return 'fatal';
    }
  }

  #toApiError(error: UpstreamError): ApiError {
    const isTimeout = error.disposition === 'retry_or_switch' && error.statusCode === null;
    return new ApiError({
      type: isTimeout ? 'upstream_timeout' : 'upstream_error',
      status: 502,
      message: error.message,
      details: { disposition: error.disposition, status_code: error.statusCode },
    });
  }
}

function defaultConnectionFactory(deps: ConnectionDeps): SydneyConnection {
  return new SydneyConnection(deps);
}
