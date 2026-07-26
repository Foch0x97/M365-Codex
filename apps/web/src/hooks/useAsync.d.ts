import { ApiRequestError } from '../api';
/**
 * 页面级数据加载的公共骨架：统一 loading / error / data 三态，
 * 避免十几个页面各写一套 try/catch。`reload` 供操作完成后手动刷新。
 */
export declare function useAsync<T>(loader: () => Promise<T>, deps?: unknown[]): {
    data: T | null;
    error: ApiRequestError | Error | null;
    loading: boolean;
    reload: () => void;
    setData: import("react").Dispatch<import("react").SetStateAction<T | null>>;
};
