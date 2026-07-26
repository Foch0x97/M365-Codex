import { Buffer } from 'node:buffer';
import { ProxyAgent, request, type Dispatcher } from 'undici';
import type { OAuthConfig } from '../config/index.js';

/**
 * 与 Microsoft identity platform 的 HTTP 交互。
 *
 * 抽成接口是为了让上层（授权流程、Token 刷新）能在测试里替换掉真实网络，
 * 集成测试不依赖任何真实凭据。
 */

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

/** Microsoft 返回的标准 OAuth 错误体。 */
export class OAuthRequestError extends Error {
  readonly status: number;
  /** 例如 `invalid_grant`、`invalid_client`、`interaction_required` */
  readonly errorCode: string;
  readonly description: string;

  constructor(status: number, errorCode: string, description: string) {
    super(`OAuth 请求失败（HTTP ${status} / ${errorCode}）：${description}`);
    this.name = 'OAuthRequestError';
    this.status = status;
    this.errorCode = errorCode;
    this.description = description;
  }

  /** refresh_token 已失效，必须重新走一次完整授权。 */
  get requiresReauth(): boolean {
    return (
      this.errorCode === 'invalid_grant' ||
      this.errorCode === 'interaction_required' ||
      this.errorCode === 'consent_required'
    );
  }
}

export interface OAuthClient {
  buildAuthorizeUrl(params: { state: string; codeChallenge: string }): string;
  exchangeCode(params: { code: string; codeVerifier: string }): Promise<TokenResponse>;
  /**
   * `proxyUrl` 可选：按账号解析出的出口代理（对应实施计划 §13.1「OAuth 与
   * Copilot 分别配置代理」）。不传则使用客户端构造时的全局默认代理。
   */
  refresh(params: { refreshToken: string; proxyUrl?: string | null }): Promise<TokenResponse>;
}

export interface HttpOAuthClientOptions {
  config: OAuthConfig;
  /** 出口代理，对应 HTTPS_PROXY / HTTP_PROXY */
  proxyUrl?: string | null;
  timeoutMs?: number;
}

export class HttpOAuthClient implements OAuthClient {
  readonly #config: OAuthConfig;
  readonly #dispatcher: Dispatcher | undefined;
  readonly #timeoutMs: number;

  constructor(options: HttpOAuthClientOptions) {
    this.#config = options.config;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#dispatcher = toDispatcher(options.proxyUrl);
  }

  buildAuthorizeUrl(params: { state: string; codeChallenge: string }): string {
    const url = new URL(this.#config.authorizeUrl);
    url.searchParams.set('client_id', this.#config.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.#config.redirectUri);
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope', this.#config.scopes.join(' '));
    url.searchParams.set('state', params.state);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    // 强制选择账号：账号池场景下要能连续授权多个账号，不能被浏览器的既有会话粘住
    url.searchParams.set('prompt', 'select_account');
    return url.toString();
  }

  async exchangeCode(params: { code: string; codeVerifier: string }): Promise<TokenResponse> {
    return this.#postToken({
      client_id: this.#config.clientId,
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: this.#config.redirectUri,
      code_verifier: params.codeVerifier,
      scope: this.#config.scopes.join(' '),
    });
  }

  async refresh(params: { refreshToken: string; proxyUrl?: string | null }): Promise<TokenResponse> {
    return this.#postToken(
      {
        client_id: this.#config.clientId,
        grant_type: 'refresh_token',
        refresh_token: params.refreshToken,
        scope: this.#config.scopes.join(' '),
      },
      params.proxyUrl,
    );
  }

  async #postToken(form: Record<string, string>, proxyUrlOverride?: string | null): Promise<TokenResponse> {
    const body = new URLSearchParams(form).toString();
    // 账号绑定了专属代理时，逐次调用临时切换 dispatcher；否则用构造时的全局默认值
    const dispatcher = proxyUrlOverride === undefined ? this.#dispatcher : toDispatcher(proxyUrlOverride);
    const response = await request(this.#config.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
      headersTimeout: this.#timeoutMs,
      bodyTimeout: this.#timeoutMs,
      ...(dispatcher === undefined ? {} : { dispatcher }),
    });

    const text = await response.body.text();
    if (response.statusCode >= 400) {
      throw parseOAuthError(response.statusCode, text);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new OAuthRequestError(response.statusCode, 'invalid_response', 'Token 端点返回的不是合法 JSON');
    }
    const tokens = parsed as TokenResponse;
    if (typeof tokens.access_token !== 'string' || tokens.access_token === '') {
      throw new OAuthRequestError(response.statusCode, 'invalid_response', 'Token 端点响应缺少 access_token');
    }
    return tokens;
  }
}

/** 代理 URL 为空/未设置时不建 dispatcher，走 undici 默认（直连）。 */
function toDispatcher(proxyUrl?: string | null): Dispatcher | undefined {
  return proxyUrl == null || proxyUrl === '' ? undefined : new ProxyAgent(proxyUrl);
}

/**
 * 解析 Microsoft 的错误响应。
 * 错误描述里可能带有内部标识，只保留首行并截断，避免噪音进日志。
 */
export function parseOAuthError(status: number, rawBody: string): OAuthRequestError {
  let errorCode = 'unknown_error';
  let description = rawBody.slice(0, 300);
  try {
    const parsed = JSON.parse(rawBody) as { error?: string; error_description?: string };
    if (typeof parsed.error === 'string') errorCode = parsed.error;
    if (typeof parsed.error_description === 'string') {
      description = parsed.error_description.split('\n')[0]?.slice(0, 300) ?? '';
    }
  } catch {
    // 非 JSON 响应（网关错误页等）保持原样截断
  }
  return new OAuthRequestError(status, errorCode, description);
}

/** 解出 JWT 的 payload。只用于读取 tid/oid/email 等声明，**不做签名校验**。 */
export function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2 || parts[1] === undefined) return {};
  try {
    const decoded = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(decoded);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface IdentityClaims {
  tid: string;
  oid: string;
  email: string | null;
  displayName: string | null;
}

/**
 * 从 id_token / access_token 中提取账号身份。
 * 优先用 id_token，它的声明更完整；两者都缺 tid 或 oid 时视为不可用。
 */
export function extractIdentity(tokens: TokenResponse): IdentityClaims | null {
  const claims = {
    ...decodeJwtClaims(tokens.access_token),
    ...(tokens.id_token === undefined ? {} : decodeJwtClaims(tokens.id_token)),
  };

  const str = (key: string): string | null => {
    const value = claims[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };

  const tid = str('tid');
  const oid = str('oid') ?? str('sub');
  if (tid === null || oid === null) return null;

  const email = str('preferred_username') ?? str('email') ?? str('upn') ?? str('unique_name');
  const displayName = str('name') ?? (email === null ? null : (email.split('@')[0] ?? null));

  return { tid, oid, email, displayName };
}
