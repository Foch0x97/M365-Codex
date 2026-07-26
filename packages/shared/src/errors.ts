/**
 * 统一错误体（对应实施计划 §4.4）。
 *
 * 约定：
 * - `type` 表达语义分类，客户端据此做分支处理；
 * - `code` 为 HTTP 状态码的字符串形式，便于与 OpenAI 兼容客户端对齐；
 * - `request_id` 贯穿日志与响应头 `x-request-id`，用于问题定位。
 */

export const API_ERROR_TYPES = [
  /** 请求本身不合法（字段缺失、类型错误、JSON 解析失败等） */
  'invalid_request_error',
  /** 缺少或无效的 API Key / 管理会话 */
  'authentication_error',
  /** 已认证但无权访问该端点、模型或资源 */
  'permission_error',
  /** 资源不存在 */
  'not_found_error',
  /** 触发本网关侧的限流（RPM / 日配额 / 并发） */
  'rate_limit_error',
  /** 幂等键冲突：同一 Key 复用幂等键但请求体不一致 */
  'idempotency_error',
  /** 参数被识别但当前上游无法支持，且影响语义，不做静默降级 */
  'unsupported_parameter',
  /** 功能明确不在本项目能力范围内（见实施计划 §7） */
  'unsupported_feature',
  /** 账号池中没有可用的 Microsoft 账号 */
  'account_pool_exhausted',
  /** 上游（Sydney / BizChat）返回错误或协议异常 */
  'upstream_error',
  /** 上游超时或连接中断 */
  'upstream_timeout',
  /** 服务尚未就绪（主密钥无效、迁移未完成等） */
  'service_not_ready',
  /** 未归类的内部错误 */
  'internal_error',
] as const;

export type ApiErrorType = (typeof API_ERROR_TYPES)[number];

export interface ApiErrorBody {
  error: {
    type: ApiErrorType;
    code: string;
    message: string;
    param: string | null;
    request_id: string | null;
  };
}

export interface ApiErrorInit {
  type: ApiErrorType;
  status: number;
  message: string;
  param?: string | null;
  /** 附加信息，只写日志，不返回给客户端 */
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** 业务异常基类：抛出后由全局错误处理器转换为统一错误体。 */
export class ApiError extends Error {
  readonly type: ApiErrorType;
  readonly status: number;
  readonly param: string | null;
  readonly details: Record<string, unknown> | undefined;

  constructor(init: ApiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ApiError';
    this.type = init.type;
    this.status = init.status;
    this.param = init.param ?? null;
    this.details = init.details;
  }

  toBody(requestId: string | null): ApiErrorBody {
    return {
      error: {
        type: this.type,
        code: String(this.status),
        message: this.message,
        param: this.param,
        request_id: requestId,
      },
    };
  }

  static badRequest(message: string, param?: string): ApiError {
    return new ApiError({ type: 'invalid_request_error', status: 400, message, param: param ?? null });
  }

  static unauthorized(message = 'Missing or invalid credentials'): ApiError {
    return new ApiError({ type: 'authentication_error', status: 401, message });
  }

  static forbidden(message = 'Not allowed'): ApiError {
    return new ApiError({ type: 'permission_error', status: 403, message });
  }

  static notFound(message = 'Resource not found'): ApiError {
    return new ApiError({ type: 'not_found_error', status: 404, message });
  }

  static rateLimited(message = 'Rate limit exceeded'): ApiError {
    return new ApiError({ type: 'rate_limit_error', status: 429, message });
  }

  static notReady(message = 'Service is not ready'): ApiError {
    return new ApiError({ type: 'service_not_ready', status: 503, message });
  }

  static internal(message = 'Internal server error', cause?: unknown): ApiError {
    return new ApiError({ type: 'internal_error', status: 500, message, cause });
  }
}

/** 构造统一错误体，供不便抛异常的场景（如 SSE 中途失败）直接序列化。 */
export function buildErrorBody(
  type: ApiErrorType,
  status: number,
  message: string,
  options: { param?: string | null; requestId?: string | null } = {},
): ApiErrorBody {
  return {
    error: {
      type,
      code: String(status),
      message,
      param: options.param ?? null,
      request_id: options.requestId ?? null,
    },
  };
}
