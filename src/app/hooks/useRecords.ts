import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, type OutputRecordDetail, type OutputRecordIndex } from '@/lib/api';

/**
 * 产出物记录索引。**挂在 App 级，不挂任何视图的生命周期上** ——
 * 工作台要能在任意视图瞬时打开、瞬时切页，不等网络。写法与 `useQuestions` 同构。
 *
 * `unsupported` 与 `error` 分开：前者是「老服务进程没有这个接口」，要提示重启服务；
 * 后者是真出错了，如实报。两者都不能退化成空列表 ——
 * 空列表会被读成「这个工作空间没有产出物记录」，那是假消息。
 */
export function useRecords(projectId: string, changeToken: number) {
  const [index, setIndex] = useState<OutputRecordIndex | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [unsupported, setUnsupported] = useState(false);

  const load = useCallback(
    async (silent = false) => {
      if (!projectId) {
        setIndex(null);
        setError('');
        setUnsupported(false);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const data = await api.records(projectId);
        setIndex(data);
        setError('');
        setUnsupported(false);
      } catch (err) {
        // 404 只可能是老服务进程：路由在就算工作空间没有 records/ 目录也返回 200 + available:false
        if (err instanceof ApiError && err.status === 404) {
          setUnsupported(true);
          setIndex(null);
          setError('');
        } else {
          setError((err as Error).message);
        }
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // 目录有变动就静默重取：agent 在终端里改了记录文件，看板要能感知
  useEffect(() => {
    if (!changeToken) return;
    void load(true);
  }, [changeToken, load]);

  return { index, loading, error, unsupported, reload: load };
}

/**
 * 单条记录的详情（状态流水 + 正文）。清单只带 front-matter，详情按需单独取 ——
 * 把流水一起下发会让打开工作台变慢，而清单根本不显示长文。
 *
 * 取过的留在缓存里：在清单里来回点是常态，不该每次都打一趟网络。
 * **这个 hook 必须挂在换选中项时不重挂的组件上**，否则缓存会跟着组件一起被扔掉。
 */
export function useRecordDetail(projectId: string, recordId: string, changeToken: number) {
  const cacheRef = useRef(new Map<string, OutputRecordDetail>());
  const [detail, setDetail] = useState<OutputRecordDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // 文件变了，之前取的详情就不作数了
  useEffect(() => {
    cacheRef.current.clear();
  }, [projectId, changeToken]);

  useEffect(() => {
    if (!projectId || !recordId) {
      setDetail(null);
      setError('');
      return undefined;
    }
    const cached = cacheRef.current.get(recordId);
    if (cached) {
      setDetail(cached);
      setError('');
      return undefined;
    }
    let alive = true;
    setLoading(true);
    api
      .record(projectId, recordId)
      .then((data) => {
        cacheRef.current.set(recordId, data);
        if (!alive) return;
        setDetail(data);
        setError('');
      })
      .catch((err: Error) => {
        if (!alive) return;
        setDetail(null);
        setError(err.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [projectId, recordId, changeToken]);

  /**
   * 保存成功后把服务端返回的那一份塞回缓存。
   * 不这么做就得等 SSE 绕一圈回来才刷新流水 —— 那一下看着像是没保存上。
   */
  const put = useCallback((next: OutputRecordDetail) => {
    cacheRef.current.set(next.id, next);
    setDetail((cur) => (cur && cur.id === next.id ? next : cur));
  }, []);

  /* 渲染期就从缓存里取当前这条，不等 effect 里的 setState —— 命中缓存不该闪一下「正在读」 */
  const shown = detail && detail.id === recordId ? detail : cacheRef.current.get(recordId) || null;

  return { detail: shown, loading: shown ? false : loading, error: shown ? '' : error, put };
}
