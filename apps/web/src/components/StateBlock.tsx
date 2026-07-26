import type { ReactNode } from 'react';
import { ErrorBanner } from './ErrorBanner';

export function LoadingBlock({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="state-block" role="status">
      <span className="spinner" aria-hidden="true" />
      <div style={{ marginTop: 10 }}>{label}</div>
    </div>
  );
}

export function EmptyBlock({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="state-block">
      <div className="state-title">{title}</div>
      {hint !== undefined && <div>{hint}</div>}
    </div>
  );
}

/**
 * 加载 / 错误 / 空 / 有数据 四态的统一入口，页面只需要关心「有数据时怎么画」。
 */
export function AsyncSection<T>({
  loading,
  error,
  data,
  isEmpty,
  emptyTitle,
  emptyHint,
  onRetry,
  loadingLabel,
  children,
}: {
  loading: boolean;
  error: unknown;
  data: T | null;
  isEmpty?: (data: T) => boolean;
  emptyTitle?: string;
  emptyHint?: string;
  onRetry?: () => void;
  loadingLabel?: string;
  children: (data: T) => ReactNode;
}) {
  if (loading) return <LoadingBlock label={loadingLabel} />;
  if (error !== null && error !== undefined) return <ErrorBanner error={error} onRetry={onRetry} />;
  if (data === null) return <EmptyBlock title={emptyTitle ?? '暂无数据'} hint={emptyHint} />;
  if (isEmpty?.(data) === true) return <EmptyBlock title={emptyTitle ?? '暂无数据'} hint={emptyHint} />;
  return <>{children(data)}</>;
}
