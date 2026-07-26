import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError } from '../api';

/**
 * 页面级数据加载的公共骨架：统一 loading / error / data 三态，
 * 避免十几个页面各写一套 try/catch。`reload` 供操作完成后手动刷新。
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiRequestError | Error | null>(null);
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    loaderRef
      .current()
      .then((result) => setData(result))
      .catch((err: unknown) => setError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  return { data, error, loading, reload, setData };
}
