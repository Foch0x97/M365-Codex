import { ApiRequestError } from '../api';

/**
 * 统一错误体的展示组件：把 request_id 显眼地露出来，方便用户报障时提供给排查方。
 * 兼容非 ApiRequestError 的普通异常（例如网络层完全没连上）。
 */
export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (error === null || error === undefined) return null;

  const isApiError = error instanceof ApiRequestError;
  const title = isApiError ? apiErrorTypeLabel(error.body.error.type) : '发生错误';
  const message = describeUnknownError(error);
  const requestId = isApiError ? error.body.error.request_id : null;
  const param = isApiError ? error.body.error.param : null;

  return (
    <div className="error-banner" role="alert">
      <div className="error-title">{title}</div>
      <div>{message}</div>
      {(requestId !== null || param !== null) && (
        <div className="error-meta">
          {param !== null && <span>相关字段：{param}{'　'}</span>}
          {requestId !== null && <span className="mono">request_id: {requestId}</span>}
        </div>
      )}
      {onRetry !== undefined && (
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            重试
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 把任意 catch 到的值转成给人看的一行文本。`error` 类型是 `unknown`，不能无脑 String()——
 * 那样一个普通对象会渲染成没有信息量的 `[object Object]`，按真实类型分别处理。
 */
function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'number' || typeof error === 'boolean') return String(error);
  try {
    return JSON.stringify(error);
  } catch {
    return '未知错误';
  }
}

function apiErrorTypeLabel(type: string): string {
  const map: Record<string, string> = {
    invalid_request_error: '请求不合法',
    authentication_error: '认证失败',
    permission_error: '无权限',
    not_found_error: '资源不存在',
    rate_limit_error: '触发限流',
    idempotency_error: '幂等键冲突',
    unsupported_parameter: '参数暂不支持',
    unsupported_feature: '功能不在支持范围',
    account_pool_exhausted: '账号池已耗尽',
    upstream_error: '上游错误',
    upstream_timeout: '上游超时',
    service_not_ready: '服务尚未就绪',
    internal_error: '内部错误',
  };
  return map[type] ?? type;
}
