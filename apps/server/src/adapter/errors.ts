/**
 * 上游错误分类（对应实施计划 §M3 的 DoD）。
 *
 * 调度器根据分类决定：刷新一次 Token、冷却、有限重试、还是切账号。
 * 把「HTTP 状态 / WS 关闭码 → 处置策略」集中在这里，避免策略散落各处。
 */

export type UpstreamDisposition =
  /** 401：Token 可能过期，刷新一次后在同一账号重试；再失败才算故障 */
  | 'refresh_and_retry'
  /** 403：权限/风控问题，切账号无益，直接标记账号不可用，不无限切换 */
  | 'account_forbidden'
  /** 429：限流，读 Retry-After 冷却该账号，请求可切到别的账号 */
  | 'rate_limited'
  /** 5xx / WS 异常断开：有限次重试，可切换账号 */
  | 'retry_or_switch'
  /** 客户端请求本身有问题（4xx，非 401/403/429）：不重试，直接失败 */
  | 'fatal_client'
  /** 未分类的上游故障：有限重试 */
  | 'unknown';

export class UpstreamError extends Error {
  readonly disposition: UpstreamDisposition;
  /** 原始 HTTP 状态码或 WS 关闭码，用于日志 */
  readonly statusCode: number | null;
  /** 429 场景下解析出的冷却毫秒数 */
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    disposition: UpstreamDisposition,
    options: { statusCode?: number | null; retryAfterMs?: number | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'UpstreamError';
    this.disposition = disposition;
    this.statusCode = options.statusCode ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

/** 把 WebSocket 握手阶段的 HTTP 状态码分类。 */
export function classifyHttpStatus(status: number, retryAfterHeader?: string | null): UpstreamError {
  if (status === 401) {
    return new UpstreamError('上游返回 401，Token 可能过期', 'refresh_and_retry', { statusCode: 401 });
  }
  if (status === 403) {
    return new UpstreamError('上游返回 403，账号被拒绝', 'account_forbidden', { statusCode: 403 });
  }
  if (status === 429) {
    return new UpstreamError('上游返回 429，触发限流', 'rate_limited', {
      statusCode: 429,
      retryAfterMs: parseRetryAfter(retryAfterHeader),
    });
  }
  if (status >= 500) {
    return new UpstreamError(`上游返回 ${status}`, 'retry_or_switch', { statusCode: status });
  }
  if (status >= 400) {
    return new UpstreamError(`上游返回 ${status}`, 'fatal_client', { statusCode: status });
  }
  return new UpstreamError(`上游返回异常状态 ${status}`, 'unknown', { statusCode: status });
}

/**
 * 解析 Retry-After 头：既支持秒数，也支持 HTTP 日期。
 * 无法解析时返回 null，由调用方套用默认冷却。
 */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | null {
  if (header === null || header === undefined || header.trim() === '') return null;
  const trimmed = header.trim();

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - now);
  }
  return null;
}

/**
 * WebSocket 关闭码分类。
 * 1000 正常关闭不算错误；其余按「有限重试可切换」处理。
 */
export function classifyCloseCode(code: number, reason?: string): UpstreamError | null {
  if (code === 1000) return null;
  const detail = reason && reason !== '' ? `：${reason}` : '';
  if (code === 1008 || code === 4001 || code === 4003) {
    // 策略违规 / 鉴权类关闭码：切账号无益
    return new UpstreamError(`上游以 ${code} 关闭连接${detail}`, 'account_forbidden', { statusCode: code });
  }
  return new UpstreamError(`上游以 ${code} 关闭连接${detail}`, 'retry_or_switch', { statusCode: code });
}
