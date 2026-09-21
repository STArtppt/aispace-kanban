import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, type QuestionDetail, type QuestionIndex } from '@/lib/api';

/**
 * 未决问题索引。**挂在 App 级，不挂任何视图的生命周期上** ——
 * 弹窗要能在任意视图瞬时打开，不等网络。
 *
 * `unsupported` 与 `error` 分开：前者是「老服务进程没有这个接口」，要提示重启服务；
 * 后者是真出错了，如实报。两者都不能退化成空列表 ——
 * 空列表会被读成「这个工作空间没有未决问题」，那是假消息。
 */
export function useQuestions(projectId: string, changeToken: number) {
  const [index, setIndex] = useState<QuestionIndex | null>(null);
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
        const data = await api.questions(projectId);
        setIndex(data);
        setError('');
        setUnsupported(false);
      } catch (err) {
        // 404 只可能是老服务进程：路由在就算工作空间没有 questions/ 目录也返回 200 + 空列表
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

  // 目录有变动就静默重取：agent 在终端里改了问题文件，看板要能感知
  useEffect(() => {
    if (!changeToken) return;
    void load(true);
  }, [changeToken, load]);

  return { index, loading, error, unsupported, reload: load };
}

/**
 * 单条问题的正文。清单只带 front-matter，正文按需单独取 ——
 * 两百多条的正文一次拉下来没人看得完，也会把弹窗打开的那一下拖慢。
 *
 * 取过的留在缓存里：方向键连着翻页时来回走是常态，不该每次都打一趟网络。
 * **这个 hook 必须挂在翻页时不重挂的组件上** —— 挂在按 `key={id}` 重挂的卡片里，
 * 缓存会跟着卡片一起被扔掉，等于没有缓存，每翻一条都闪一下「正在读正文…」。
 *
 * `prefetch` 是「下一步可能翻到哪几条」（通常是上一条与下一条）：先悄悄取回来放缓存，
 * 落上去的时候就没有空白期。取失败不报错 —— 它只是预读，真落上去时主流程会再取一次。
 */
export function useQuestionDetail(
  projectId: string,
  questionId: string,
  changeToken: number,
  prefetch: string[] = [],
) {
  const cacheRef = useRef(new Map<string, QuestionDetail>());
  const inflightRef = useRef(new Set<string>());
  const [detail, setDetail] = useState<QuestionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // 文件变了，之前取的正文就不作数了
  useEffect(() => {
    cacheRef.current.clear();
  }, [projectId, changeToken]);

  // 预读相邻两条。只填缓存，不碰任何 state —— 它不该让界面闪一下
  useEffect(() => {
    if (!projectId) return;
    for (const id of prefetch) {
      if (!id || id === questionId) continue;
      if (cacheRef.current.has(id) || inflightRef.current.has(id)) continue;
      inflightRef.current.add(id);
      void api
        .question(projectId, id)
        .then((data) => {
          cacheRef.current.set(id, data);
        })
        .catch(() => {})
        .finally(() => {
          inflightRef.current.delete(id);
        });
    }
  }, [projectId, questionId, prefetch, changeToken]);

  useEffect(() => {
    if (!projectId || !questionId) {
      setDetail(null);
      setError('');
      return undefined;
    }
    const cached = cacheRef.current.get(questionId);
    if (cached) {
      setDetail(cached);
      setError('');
      return undefined;
    }
    let alive = true;
    setLoading(true);
    api
      .question(projectId, questionId)
      .then((data) => {
        cacheRef.current.set(questionId, data);
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
  }, [projectId, questionId, changeToken]);

  /**
   * 保存成功后把服务端返回的那一份塞回缓存。
   * 不这么做就得等 SSE 绕一圈回来才刷新正文 —— 而人点完保存会立刻翻到下一条，
   * 等翻回来时看到的还是旧的「## 人工反馈」，像是没保存上。
   */
  const put = useCallback((next: QuestionDetail) => {
    cacheRef.current.set(next.id, next);
    setDetail((cur) => (cur && cur.id === next.id ? next : cur));
  }, []);

  /*
   * 渲染期就从缓存里取当前这条，不等 effect 里的 setState。
   * 等一轮的话，切过去的那一帧显示的还是上一条的正文（或者一片空白），
   * 方向键连着按时那就是肉眼可见的闪烁。命中缓存也就不该有「正在读正文…」。
   */
  const shown = detail && detail.id === questionId ? detail : cacheRef.current.get(questionId) || null;

  return { detail: shown, loading: shown ? false : loading, error: shown ? '' : error, put };
}
