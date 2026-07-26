import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiRequestError } from '../api';

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

  // reload 体内引用的 setLoading/setError/setData 是 useState 的 setter、loaderRef 是 useRef 的
  // 引用对象，二者在组件生命周期内标识恒定，React 视为稳定依赖；真正会变化、需要触发 reload
  // 重新生成的只有调用方传入的 deps，因此这里的依赖数组就是 deps 本身，没有遗漏。
  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    loaderRef
      .current()
      .then((result) => setData(result))
      .catch((err: unknown) => setError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => setLoading(false));
  }, deps);

  // reload 是这个效果体内唯一引用的外部值，[reload] 已经完整。
  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}
