/**
 * 统一错误体的展示组件：把 request_id 显眼地露出来，方便用户报障时提供给排查方。
 * 兼容非 ApiRequestError 的普通异常（例如网络层完全没连上）。
 */
export declare function ErrorBanner({ error, onRetry }: {
    error: unknown;
    onRetry?: () => void;
}): import("react").JSX.Element | null;
