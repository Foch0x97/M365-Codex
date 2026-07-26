import { ApiRequestError, type ApiErrorBody } from './types';

/**
 * 极简 fetch 封装：统一带 Authorization、统一解析错误体、401 时通知上层回登录页。
 *
 * 令牌只保存在这个模块的内存变量里（外加 AuthContext 同步写 sessionStorage 做刷新恢复），
 * 绝不写 localStorage、绝不出现在任何 console.* 调用里。
 */

let authToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

/** AuthContext 在挂载时注册：收到 401 就清空会话、跳转登录页。 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

function buildFallbackError(status: number, message: string): ApiErrorBody {
  return {
    error: {
      type: status === 401 ? 'authentication_error' : 'internal_error',
      message,
      param: null,
      request_id: null,
    },
  };
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

function buildQuery(query: RequestOptions['query']): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs.length > 0 ? `?${qs}` : '';
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (authToken !== null) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let res: Response;
  try {
    res = await fetch(`${path}${buildQuery(options.query)}`, {
      method: options.method ?? 'GET',
      headers,
      body,
    });
  } catch {
    throw new ApiRequestError(0, buildFallbackError(0, '无法连接到服务端，请检查网络或服务是否在运行'));
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  const payload: unknown = text.length > 0 ? safeJsonParse(text) : undefined;

  if (!res.ok) {
    const errorBody = isApiErrorBody(payload)
      ? payload
      : buildFallbackError(res.status, `请求失败（HTTP ${res.status}）`);
    if (res.status === 401) {
      unauthorizedHandler?.();
    }
    throw new ApiRequestError(res.status, errorBody);
  }

  return payload as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const err = (value as { error?: unknown }).error;
  return typeof err === 'object' && err !== null && 'type' in err && 'message' in err;
}
