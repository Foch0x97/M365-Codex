import { ApiError } from '@m365-codex/shared';
import { parse as parseQuery } from 'node:querystring';
import type { OAuthConfig } from '../config/index.js';
import type { AccountRepository, AccountView } from '../repo/accounts.js';
import type { OAuthSessionRepository } from '../repo/oauthSessions.js';
import { extractIdentity, type OAuthClient } from './client.js';
import { createPkcePair } from './pkce.js';

/**
 * 授权流程编排。
 *
 * 采用与用户现有「M365 Native 本地 PKCE 授权助手」相同的交互形态：
 * 服务生成授权链接 → 用户在浏览器登录 → 把 nativeclient 回调地址粘回来。
 * 这样不需要本服务对外暴露回调端点，也就不需要公网可达。
 */

export interface AuthorizationStart {
  authorize_url: string;
  state: string;
  expires_at: number;
}

export interface AuthorizationResult {
  account: AccountView;
  /** 该账号此前是否已在池中 */
  existing: boolean;
}

export interface OAuthServiceDeps {
  config: OAuthConfig;
  client: OAuthClient;
  sessions: OAuthSessionRepository;
  accounts: AccountRepository;
}

export class OAuthService {
  readonly #deps: OAuthServiceDeps;

  constructor(deps: OAuthServiceDeps) {
    this.#deps = deps;
  }

  /**
   * 开启一次授权。每次调用生成独立的 verifier/state 会话，
   * 因此可以同时为多个账号并行授权，互不干扰。
   */
  start(now = Date.now()): AuthorizationStart {
    const pkce = createPkcePair();
    const session = this.#deps.sessions.create(
      {
        state: pkce.state,
        codeVerifier: pkce.verifier,
        redirectUri: this.#deps.config.redirectUri,
        scopes: this.#deps.config.scopes,
      },
      now,
    );
    return {
      authorize_url: this.#deps.client.buildAuthorizeUrl({
        state: pkce.state,
        codeChallenge: pkce.challenge,
      }),
      state: pkce.state,
      expires_at: session.expires_at,
    };
  }

  /**
   * 用回调地址（或裸的 `code=…&state=…`）完成授权。
   * state 严格匹配到具体会话，授权码只消费一次。
   */
  async complete(callback: string, now = Date.now()): Promise<AuthorizationResult> {
    const { code, state } = parseCallback(callback);

    const consumed = this.#deps.sessions.consume(state, now);
    if (!consumed.ok) {
      throw mapConsumeFailure(consumed.reason);
    }

    let tokens;
    try {
      tokens = await this.#deps.client.exchangeCode({ code, codeVerifier: consumed.codeVerifier });
    } catch (error) {
      throw new ApiError({
        type: 'upstream_error',
        status: 502,
        message: `换取 Token 失败：${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }

    const identity = extractIdentity(tokens);
    if (identity === null) {
      throw new ApiError({
        type: 'upstream_error',
        status: 502,
        message: 'Token 中缺少租户（tid）或对象（oid）声明，无法识别账号',
      });
    }

    const existing = this.#deps.accounts.findByTenantObject(identity.tid, identity.oid) !== undefined;
    const account = this.#deps.accounts.upsert(
      {
        tid: identity.tid,
        oid: identity.oid,
        email: identity.email,
        displayName: identity.displayName,
        source: 'oauth',
        tokens: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? null,
          expiresAt: computeExpiry(tokens.expires_in, now),
        },
      },
      now,
    );

    return { account, existing };
  }
}

/** `expires_in`（秒）转成毫秒 epoch；缺省按 1 小时算，与 Microsoft 默认一致。 */
export function computeExpiry(expiresIn: number | undefined, now: number): number {
  const seconds = typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? expiresIn : 3600;
  return now + seconds * 1000;
}

/** 从完整回调 URL 或裸查询串中取出 code 与 state。 */
export function parseCallback(input: string): { code: string; state: string } {
  const text = input.trim();
  if (text === '') {
    throw ApiError.badRequest('请粘贴包含 code 与 state 的回调地址', 'callback');
  }

  let query: string;
  if (text.startsWith('http://') || text.startsWith('https://')) {
    try {
      query = new URL(text).search.replace(/^\?/, '');
    } catch {
      throw ApiError.badRequest('回调地址不是合法 URL', 'callback');
    }
  } else {
    query = text.replace(/^\?/, '');
  }

  const parsed = parseQuery(query);
  const first = (value: string | string[] | undefined): string =>
    Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

  // Microsoft 在用户取消或出错时也会回调，此时带的是 error 而不是 code
  const oauthError = first(parsed.error);
  if (oauthError !== '') {
    const description = first(parsed.error_description).split('\n')[0] ?? '';
    throw ApiError.badRequest(`授权未完成（${oauthError}）：${description}`, 'callback');
  }

  const code = first(parsed.code);
  const state = first(parsed.state);
  if (code === '') throw ApiError.badRequest('回调地址中没有 code 参数', 'callback');
  if (state === '') throw ApiError.badRequest('回调地址中没有 state 参数', 'callback');
  return { code, state };
}

function mapConsumeFailure(reason: 'not_found' | 'expired' | 'already_consumed'): ApiError {
  switch (reason) {
    case 'not_found':
      return ApiError.badRequest('state 不匹配任何进行中的授权会话，请重新生成授权链接', 'state');
    case 'expired':
      return ApiError.badRequest('授权会话已超过 10 分钟有效期，请重新生成授权链接', 'state');
    case 'already_consumed':
      return ApiError.badRequest('该授权码已被使用过，请重新生成授权链接', 'state');
  }
}
