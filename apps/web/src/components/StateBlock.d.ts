import type { ReactNode } from 'react';
export declare function LoadingBlock({ label }: {
    label?: string;
}): import("react").JSX.Element;
export declare function EmptyBlock({ title, hint }: {
    title: string;
    hint?: string;
}): import("react").JSX.Element;
/**
 * 加载 / 错误 / 空 / 有数据 四态的统一入口，页面只需要关心「有数据时怎么画」。
 */
export declare function AsyncSection<T>({ loading, error, data, isEmpty, emptyTitle, emptyHint, onRetry, loadingLabel, children, }: {
    loading: boolean;
    error: unknown;
    data: T | null;
    isEmpty?: (data: T) => boolean;
    emptyTitle?: string;
    emptyHint?: string;
    onRetry?: () => void;
    loadingLabel?: string;
    children: (data: T) => ReactNode;
}): import("react").JSX.Element;
