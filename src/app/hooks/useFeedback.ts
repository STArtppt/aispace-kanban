import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, type FeedbackDetail, type FeedbackIndex } from '@/lib/api';

/**
 * 反馈单索引。挂在 App 级，和工作台弹窗的开关无关 ——
 * 浏览页上的待发送计数要在弹窗打开之前就有。
 *
 * `unsupported` 与 `error` 分开：前者是老服务没有这个接口，浏览页藏掉计数、
 * 反馈单页提示重启；两者都不能退化成空列表。
 */
export function useFeedback(projectId: string, changeToken: number) {
  const [index, setIndex] = useState<FeedbackIndex | null>(null);
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
        const data = await api.feedbackIndex(projectId);
        setIndex(data);
        setError('');
        setUnsupported(false);
      } catch (err) {
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

  useEffect(() => {
    if (!changeToken) return;
    void load(true);
  }, [changeToken, load]);

  return { index, loading, error, unsupported, reload: load };
}

/**
 * 单条反馈单的正文。清单不带各节，点开才取。
 * 缓存挂在换选中项时不重挂的组件上，来回点不重复打网络。
 */
export function useFeedbackDetail(projectId: string, feedbackId: string, changeToken: number) {
  const cacheRef = useRef(new Map<string, FeedbackDetail>());
  const [detail, setDetail] = useState<FeedbackDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    cacheRef.current.clear();
  }, [projectId, changeToken]);

  useEffect(() => {
    if (!projectId || !feedbackId) {
      setDetail(null);
      setError('');
      return undefined;
    }
    const cached = cacheRef.current.get(feedbackId);
    if (cached) {
      setDetail(cached);
      setError('');
      return undefined;
    }
    let alive = true;
    setLoading(true);
    api
      .feedbackDetail(projectId, feedbackId)
      .then((data) => {
        cacheRef.current.set(feedbackId, data);
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
  }, [projectId, feedbackId, changeToken]);

  const put = useCallback((next: FeedbackDetail) => {
    if (!next.id) return;
    cacheRef.current.set(next.id, next);
    setDetail((cur) => (cur && cur.id === next.id ? next : cur));
  }, []);

  const shown = detail && detail.id === feedbackId ? detail : cacheRef.current.get(feedbackId) || null;
  return { detail: shown, loading: shown ? false : loading, error: shown ? '' : error, put };
}
