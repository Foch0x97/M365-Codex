import { ApiError, API_KEY_PREFIX } from '@m365-codex/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { apiKeyLookupPrefix, isWellFormedApiKey, verifyApiKey } from '../crypto/apiKey.js';
import type { AppContext } from '../context.js';
import { evaluateApiKeyUsability, parseList, type ApiKeyRow } from '../repo/apiKeys.js';
import type { AdminSessionRow } from '../repo/adminSessions.js';
import { maskIp } from '../observability/logger.js';
import { clampToCeiling } from './rateLimit.js';

/** 鉴权：对外 API Key 与管理端会话两条独立通道。 */

/**
 * API Key 级、已按全局天花板裁剪过的有效限额（§10.1）：`max_tool_calls`/
 * `max_file_bytes` 挂在这里供后续路由直接读取，不必再查一次库或重算一次
 * `clampToCeiling`——与 rpm/daily/concurrency（`gateway/rateLimit.ts`）走的
 * 是同一条「只能更严、不能突破全局上限」的规则。
 */
export interface ApiKeyEffectiveLimits {
  maxToolCalls: number;
  maxFileBytes: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyRow?: ApiKeyRow;
    apiKeyLimits?: ApiKeyEffectiveLimits;
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

/** 从请求里取出本次调用的端点标识（`METHOD /route/pattern`），用于限额白名单与幂等作用域。 */
export function endpointTagFor(request: FastifyRequest): string {
  const pattern = request.routeOptions.url ?? request.url;
  return `${request.method} ${pattern}`;
}

/** 从已解析的请求体里取出 `model` 字段（仅 Responses / Chat Completions 请求有意义）。 */
function modelFromBody(request: FastifyRequest): string | null {
  const body = request.body;
  if (body !== null && typeof body === 'object' && 'model' in body) {
    const model = (body as { model?: unknown }).model;
    return typeof model === 'string' && model !== '' ? model : null;
  }
  return null;
}

/**
 * 校验对外 API Key，并施加 §10 的限额（接口/模型白名单、RPM/日配额/最大并发）。
 * 前缀命中后仍逐个做恒定时间哈希比较，避免通过响应时间区分 Key 是否存在。
 */
export function createApiKeyGuard(context: AppContext) {
  return async function apiKeyGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
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

    const endpoint = endpointTagFor(request);
    const model = modelFromBody(request);

    try {
      context.rateLimiter.checkEndpointAndModel(
        { endpoints: parseList(matched.allowed_endpoints), models: parseList(matched.allowed_models) },
        endpoint,
        model,
      );
    } catch (error) {
      recordRestrictionHit(context, matched.id, endpoint, 'api_key.access_denied', 'endpoint_or_model', clientIpFor(context, request));
      throw error;
    }

    const limits = context.rateLimiter.effectiveLimits(matched);
    const consumed = context.rateLimiter.consume(matched.id, limits);
    if (!consumed.ok) {
      recordRestrictionHit(context, matched.id, endpoint, 'api_key.rate_limited', consumed.reason, clientIpFor(context, request));
      reply.header('Retry-After', String(consumed.retryAfterSeconds));
      throw ApiError.rateLimited(
        `已达到该 API Key 的${rateLimitReasonLabel(consumed.reason)}限额，请在 ${consumed.retryAfterSeconds} 秒后重试`,
      );
    }
    // 并发额度用 HTTP 连接的 close 事件释放：流式（SSE）响应会 hijack，Fastify 的
    // onResponse 钩子对 hijack 后的连接不生效，raw 的 close 事件则无论是否 hijack 都可靠触发
    // （路由里客户端断线取消上游用的是同一个事件，已验证可靠）。
    reply.raw.once('close', consumed.release);

    request.apiKeyRow = matched;
    // §10.1：工具调用次数、单文件/上传分片大小这两项按 Key 收紧的限额，同样
    // 遵守「不得突破全局天花板」——在这里统一裁剪好，供 responses/service.ts
    // 与 files 路由直接读取，不必各自再查一次库
    request.apiKeyLimits = {
      maxToolCalls: clampToCeiling(matched.max_tool_calls, context.config.tools.maxTotalCalls),
      maxFileBytes: clampToCeiling(matched.max_file_bytes, context.config.files.maxFileBytes),
    };
    context.apiKeys.touch(matched.id, clientIpFor(context, request));
  };
}

function rateLimitReasonLabel(reason: 'rpm' | 'daily' | 'concurrency'): string {
  switch (reason) {
    case 'rpm':
      return '每分钟请求数';
    case 'daily':
      return '每日请求';
    case 'concurrency':
      return '并发请求数';
  }
}

/** 限额/白名单命中要留痕，但绝不能把请求内容（model 之外的任何字段）写进审计或指标。 */
function recordRestrictionHit(
  context: AppContext,
  apiKeyId: string,
  endpoint: string,
  action: string,
  reason: string,
  clientIp: string | null,
): void {
  context.metrics.rateLimitRejections.inc({ reason });
  context.auditLogs.record({
    actor: 'api_key',
    action,
    target: apiKeyId,
    detail: { endpoint, reason },
    clientIp: maskIp(clientIp ?? undefined, context.privacyMode.current),
  });
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
