import { ApiError, API_KEY_PREFIX } from '@m365-codex/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { apiKeyLookupPrefix, isWellFormedApiKey, verifyApiKey } from '../crypto/apiKey.js';
import type { AppContext } from '../context.js';
import { evaluateApiKeyUsability, type ApiKeyRow } from '../repo/apiKeys.js';
import type { AdminSessionRow } from '../repo/adminSessions.js';

/** 鉴权：对外 API Key 与管理端会话两条独立通道。 */

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyRow?: ApiKeyRow;
    adminSession?: AdminSessionRow;
  }
}

/** 同时支持 `Authorization: Bearer sk-…` 与 `X-API-Key: sk-…`。 */
export function extractApiKey(request: FastifyRequest): string | null {
  const header = request.headers['x-api-key'];
  if (typeof header === 'string' && header.trim() !== '') {
    return header.trim();
  }
  const auth = request.headers.authorization;
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1] !== undefined) return match[1].trim();
  }
  return null;
}

export function extractBearerToken(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (typeof auth !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return match?.[1]?.trim() ?? null;
}

/**
 * 校验对外 API Key。
 * 前缀命中后仍逐个做恒定时间哈希比较，避免通过响应时间区分 Key 是否存在。
 */
export function createApiKeyGuard(context: AppContext) {
  return async function apiKeyGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const presented = extractApiKey(request);
    if (presented === null) {
      throw ApiError.unauthorized(
        `缺少 API Key，请通过 Authorization: Bearer ${API_KEY_PREFIX}… 或 X-API-Key 提供`,
      );
    }
    if (!isWellFormedApiKey(presented)) {
      throw ApiError.unauthorized('API Key 格式不正确');
    }

    const candidates = context.apiKeys.findByPrefix(apiKeyLookupPrefix(presented));
    let matched: ApiKeyRow | undefined;
    for (const candidate of candidates) {
      if (verifyApiKey(presented, candidate.salt, candidate.hash)) {
        matched = candidate;
        break;
      }
    }
    if (matched === undefined) {
      throw ApiError.unauthorized('API Key 无效');
    }

    const usability = evaluateApiKeyUsability(matched);
    if (!usability.usable) {
      throw ApiError.forbidden(usability.reason);
    }

    request.apiKeyRow = matched;
    context.apiKeys.touch(matched.id, clientIpFor(context, request));
  };
}

/** 校验管理端会话令牌。 */
export function createAdminGuard(context: AppContext) {
  return async function adminGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = extractBearerToken(request);
    if (token === null) {
      throw ApiError.unauthorized('缺少管理端会话令牌');
    }
    const session = context.adminSessions.verify(token);
    if (session === undefined) {
      throw ApiError.unauthorized('管理端会话无效或已过期');
    }
    request.adminSession = session;
  };
}

/** 取客户端 IP：未开启 TRUST_PROXY 时忽略 X-Forwarded-*。 */
export function clientIpFor(context: AppContext, request: FastifyRequest): string | null {
  if (context.config.trustProxy) {
    return request.ip;
  }
  return request.socket.remoteAddress ?? null;
}

/** 登录失败节流：按 IP 计数，防止在线暴力破解管理密码。 */
export class LoginThrottle {
  readonly #attempts = new Map<string, { count: number; resetAt: number }>();
  readonly #maxAttempts: number;
  readonly #windowMs: number;

  constructor(maxAttempts = 8, windowMs = 15 * 60 * 1000) {
    this.#maxAttempts = maxAttempts;
    this.#windowMs = windowMs;
  }

  check(key: string, now = Date.now()): void {
    const entry = this.#attempts.get(key);
    if (entry === undefined) return;
    if (entry.resetAt <= now) {
      this.#attempts.delete(key);
      return;
    }
    if (entry.count >= this.#maxAttempts) {
      const seconds = Math.ceil((entry.resetAt - now) / 1000);
      throw ApiError.rateLimited(`登录失败次数过多，请在 ${seconds} 秒后重试`);
    }
  }

  recordFailure(key: string, now = Date.now()): void {
    const entry = this.#attempts.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      this.#attempts.set(key, { count: 1, resetAt: now + this.#windowMs });
      return;
    }
    entry.count += 1;
  }

  reset(key: string): void {
    this.#attempts.delete(key);
  }
}
