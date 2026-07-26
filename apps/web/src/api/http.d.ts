export declare function setAuthToken(token: string | null): void;
export declare function getAuthToken(): string | null;
/** AuthContext 在挂载时注册：收到 401 就清空会话、跳转登录页。 */
export declare function setUnauthorizedHandler(handler: (() => void) | null): void;
export interface RequestOptions {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
}
export declare function request<T>(path: string, options?: RequestOptions): Promise<T>;
