import { Buffer } from 'node:buffer';
import type { OAuthClient, TokenResponse } from '../../src/oauth/client.js';
import { OAuthRequestError } from '../../src/oauth/client.js';

/**
 * 模拟 Microsoft identity 端点。
 *
 * 集成测试一律用它，绝不接触真实网络与真实凭据。
 * 生成的「Token」是结构合法但完全虚构的 JWT，值里带明显的 fake 标记。
 */

export interface FakeIdentity {
  tid: string;
  oid: string;
  email: string;
  name?: string;
}

/** 造一个签名部分为占位符的 JWT——只有 payload 有意义，本项目也只读 payload。 */
export function makeFakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.fake-signature-not-verified`;
}

export function makeFakeTokenResponse(
  identity: FakeIdentity,
  options: { expiresIn?: number; withRefresh?: boolean; marker?: string } = {},
): TokenResponse {
  const marker = options.marker ?? 'v1';
  const claims = {
    tid: identity.tid,
    oid: identity.oid,
    preferred_username: identity.email,
    name: identity.name ?? identity.email.split('@')[0],
    aud: 'https://substrate.office.com/sydney',
  };
  const response: TokenResponse = {
    access_token: makeFakeJwt({ ...claims, marker }),
    id_token: makeFakeJwt(claims),
    token_type: 'Bearer',
    expires_in: options.expiresIn ?? 3600,
  };
  if (options.withRefresh !== false) {
    response.refresh_token = `fake-refresh-${identity.oid}-${marker}`;
  }
  return response;
}

export interface FakeOAuthClientOptions {
  /** 授权码 → 身份。未登记的 code 会被拒绝 */
  codes?: Map<string, FakeIdentity>;
  authorizeBase?: string;
}

/** 可编程的假 OAuth 客户端：能注入错误、统计调用次数、模拟慢响应。 */
export class FakeOAuthClient implements OAuthClient {
  readonly codes: Map<string, FakeIdentity>;
  readonly exchangeCalls: { code: string; codeVerifier: string }[] = [];
  readonly refreshCalls: { refreshToken: string }[] = [];

  /** 下一次 exchangeCode 抛出的错误 */
  nextExchangeError: Error | null = null;
  /** 下一次 refresh 抛出的错误 */
  nextRefreshError: Error | null = null;
  /** refresh 返回的身份；不设则从 refreshToken 反查 */
  refreshIdentity: FakeIdentity | null = null;
  /** refresh 是否下发新的 refresh_token */
  refreshIssuesNewRefreshToken = true;
  /** 人为延迟，用于测试并发单飞 */
  refreshDelayMs = 0;
  /** 每次 refresh 返回的 access_token 标记递增，便于区分是不是同一次刷新的结果 */
  #refreshCounter = 0;

  readonly #authorizeBase: string;

  constructor(options: FakeOAuthClientOptions = {}) {
    this.codes = options.codes ?? new Map();
    this.#authorizeBase = options.authorizeBase ?? 'https://login.example.invalid/authorize';
  }

  /** 登记一个可用的授权码。 */
  registerCode(code: string, identity: FakeIdentity): void {
    this.codes.set(code, identity);
  }

  buildAuthorizeUrl(params: { state: string; codeChallenge: string }): string {
    const url = new URL(this.#authorizeBase);
    url.searchParams.set('state', params.state);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async exchangeCode(params: { code: string; codeVerifier: string }): Promise<TokenResponse> {
    this.exchangeCalls.push(params);
    if (this.nextExchangeError !== null) {
      const error = this.nextExchangeError;
      this.nextExchangeError = null;
      throw error;
    }
    const identity = this.codes.get(params.code);
    if (identity === undefined) {
      throw new OAuthRequestError(400, 'invalid_grant', '授权码无效或已使用');
    }
    return makeFakeTokenResponse(identity);
  }

  async refresh(params: { refreshToken: string }): Promise<TokenResponse> {
    this.refreshCalls.push(params);
    if (this.refreshDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.refreshDelayMs));
    }
    if (this.nextRefreshError !== null) {
      const error = this.nextRefreshError;
      this.nextRefreshError = null;
      throw error;
    }

    const identity =
      this.refreshIdentity ??
      [...this.codes.values()].find((candidate) =>
        params.refreshToken.includes(candidate.oid),
      ) ?? { tid: 'fake-tid', oid: 'fake-oid', email: 'fake@example.invalid' };

    this.#refreshCounter += 1;
    return makeFakeTokenResponse(identity, {
      marker: `refreshed-${this.#refreshCounter}`,
      withRefresh: this.refreshIssuesNewRefreshToken,
    });
  }

  get refreshCount(): number {
    return this.refreshCalls.length;
  }
}

/** 构造一个 nativeclient 形态的回调地址，和用户助手里粘贴的格式一致。 */
export function makeCallbackUrl(code: string, state: string): string {
  const url = new URL('https://login.microsoftonline.com/common/oauth2/nativeclient');
  url.searchParams.set('code', code);
  url.searchParams.set('state', state);
  return url.toString();
}
