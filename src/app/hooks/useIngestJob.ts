import { useCallback, useEffect, useState } from 'react';
import { api, type IngestJob } from '@/lib/api';

/** 转换任务状态轮询间隔；大 PDF 可能跑几分钟，1.5s 足够且不刷接口 */
const INGEST_POLL_MS = 1500;

/** 一个工作空间至多一轮转换任务，界面各处共用这一份状态 */
export interface IngestControl {
  job: IngestJob | null;
  running: boolean;
  error: string;
  start: (filePath?: string) => Promise<void>;
  /** 只藏这条提示；下次转换再失败会重新出现 */
  dismissError: () => void;
}

/**
 * 在看板里触发 scripts/ingest.py。
 * canIngest 缺失（旧服务）时不轮询也不查状态，退回文案里的终端命令提示。
 * 写盘由工作空间脚本完成，看板只负责 spawn + 轮询状态；文件变化走已有 SSE。
 * 状态提到 App 是因为服务端每个项目只允许一轮任务：待转换列表的「转换」、整目录转换、
 * 预览页的「重新转换」必须看到同一份进度，否则第二处会撞上 409 却显示成「没反应」。
 */
export function useIngestJob(projectId: string, canIngest?: boolean): IngestControl {
  const [job, setJob] = useState<IngestJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 为 true 时 effect 持续轮询，直到状态离开 running */
  const [polling, setPolling] = useState(false);

  const applyJob = useCallback((next: IngestJob) => {
    setJob(next);
    if (next.status === 'running') setPolling(true);
    else setPolling(false);
    if (next.status === 'error') setError(next.message || '转换失败');
    else if (next.status === 'done') setError('');
  }, []);

  // 切项目：清状态，并查一次是否已有进行中的任务（刷新页面后还能接上）
  useEffect(() => {
    if (!canIngest || !projectId) {
      setJob(null);
      setError('');
      setBusy(false);
      setPolling(false);
      return undefined;
    }
    let cancelled = false;
    void api
      .ingestStatus(projectId)
      .then((status) => {
        if (!cancelled) applyJob(status);
      })
      .catch(() => {
        // 旧服务没有这个接口：静默；点「开始转换」时再报错
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, canIngest, applyJob]);

  useEffect(() => {
    if (!polling || !projectId) return undefined;
    let cancelled = false;
    const timer = setInterval(() => {
      void api
        .ingestStatus(projectId)
        .then((status) => {
          if (!cancelled) applyJob(status);
        })
        .catch((err) => {
          if (!cancelled) {
            setPolling(false);
            setError((err as Error).message);
          }
        });
    }, INGEST_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [polling, projectId, applyJob]);

  const start = useCallback(
    async (filePath?: string) => {
      setBusy(true);
      setError('');
      try {
        const started = await api.startIngest(projectId, filePath);
        applyJob(started);
      } catch (err) {
        setError((err as Error).message);
        setPolling(false);
      } finally {
        setBusy(false);
      }
    },
    [projectId, applyJob],
  );

  const dismissError = useCallback(() => setError(''), []);

  return {
    job,
    running: job?.status === 'running' || busy,
    error,
    start,
    dismissError,
  };
}
