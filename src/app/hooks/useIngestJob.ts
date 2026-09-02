import { useCallback, useEffect, useState } from 'react';
import { api, type IngestJob, type IngestStatus, type SourceIngestJob } from '@/lib/api';

/** 任务状态轮询间隔；大 PDF 可能跑几分钟，1.5s 足够且不刷接口 */
const INGEST_POLL_MS = 1500;

/** 一个工作空间至多一轮转换任务，界面各处共用这一份状态 */
export interface IngestControl {
  job: IngestJob | null;
  running: boolean;
  error: string;
  start: (filePath?: string) => Promise<void>;
  /** 关掉后不再因刷新 / 切项目弹回来；下次点「开始转换」失败才会再出现 */
  dismissError: () => void;
}

/** 数据源采集的同一套三件套，只是启动时传的是源名 */
export interface SourceIngestControl {
  job: SourceIngestJob | null;
  running: boolean;
  error: string;
  start: (source: string) => Promise<void>;
  dismissError: () => void;
}

/** 两种任务共用的最小形状：轮询逻辑只依赖这两个字段 */
interface JobLike {
  status: IngestStatus;
  message: string;
}

/**
 * 「起个子进程，然后轮询它」的公共实现。转换（ingest.py）和数据源采集（db_ingest.py）
 * 在服务端是两把独立的锁，但**前端这套状态机完全一样**，所以只写一份：
 * 切项目时接回进行中的任务、running 期间定时轮、失败提示只在本次点击时弹。
 *
 * 服务端两个 job 互不相干（正在转大 PDF 时照样能刷 schema），这里也就各用各的实例。
 */
function useSpawnJob<J extends JobLike, A>(
  projectId: string,
  enabled: boolean | undefined,
  fetchStatus: (id: string) => Promise<J>,
  startJob: (id: string, arg: A) => Promise<J>,
  fallbackError: string,
) {
  const [job, setJob] = useState<J | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 为 true 时 effect 持续轮询，直到状态离开 running */
  const [polling, setPolling] = useState(false);

  const applyJob = useCallback((next: J, opts?: { hydrate?: boolean }) => {
    setJob(next);
    if (next.status === 'running') setPolling(true);
    else setPolling(false);
    // 失败提示是这次点击的反馈，不是服务端还记着的上一轮 error。
    // 刷新 / 切项目只接回进行中的任务；已经结束的失败不自动再弹。
    if (next.status === 'error') {
      if (!opts?.hydrate) setError(next.message || fallbackError);
    } else if (next.status === 'done') setError('');
  }, [fallbackError]);

  // 切项目：清状态，并查一次是否已有进行中的任务（刷新页面后还能接上）
  useEffect(() => {
    setJob(null);
    setError('');
    setBusy(false);
    setPolling(false);
    if (!enabled || !projectId) return undefined;
    let cancelled = false;
    void fetchStatus(projectId)
      .then((status) => {
        if (!cancelled) applyJob(status, { hydrate: true });
      })
      .catch(() => {
        // 旧服务没有这个接口：静默；点按钮时再报错
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, enabled, applyJob, fetchStatus]);

  useEffect(() => {
    if (!polling || !projectId) return undefined;
    let cancelled = false;
    const timer = setInterval(() => {
      void fetchStatus(projectId)
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
  }, [polling, projectId, applyJob, fetchStatus]);

  const start = useCallback(
    async (arg: A) => {
      setBusy(true);
      setError('');
      try {
        applyJob(await startJob(projectId, arg));
      } catch (err) {
        setError((err as Error).message);
        setPolling(false);
      } finally {
        setBusy(false);
      }
    },
    [projectId, applyJob, startJob],
  );

  const dismissError = useCallback(() => setError(''), []);

  return { job, running: job?.status === 'running' || busy, error, start, dismissError };
}

const ingestStatus = (id: string) => api.ingestStatus(id);
const startIngest = (id: string, filePath?: string) => api.startIngest(id, filePath);

/**
 * 在看板里触发 scripts/ingest.py。
 * canIngest 缺失（旧服务）时不轮询也不查状态，退回文案里的终端命令提示。
 * 写盘由工作空间脚本完成，看板只负责 spawn + 轮询状态；文件变化走已有 SSE。
 * 状态提到 App 是因为服务端每个项目只允许一轮任务：待转换列表的「转换」、整目录转换、
 * 预览页的「重新转换」必须看到同一份进度，否则第二处会撞上 409 却显示成「没反应」。
 */
export function useIngestJob(projectId: string, canIngest?: boolean): IngestControl {
  return useSpawnJob<IngestJob, string | undefined>(
    projectId, canIngest, ingestStatus, startIngest, '转换失败',
  );
}

const sourceStatus = (id: string) => api.sourceIngestStatus(id);
const startSource = (id: string, source: string) => api.startSourceIngest(id, source);

/**
 * 在看板里触发 scripts/db_ingest.py 采一次 schema 快照。
 * canIngestSources 缺失（没配数据源 / 老工作空间没这个脚本 / 旧服务进程）时不轮询也不查状态。
 * 看板自己不连数据库 —— 连库整个发生在子进程里。
 */
export function useSourceIngestJob(projectId: string, canIngest?: boolean): SourceIngestControl {
  return useSpawnJob<SourceIngestJob, string>(
    projectId, canIngest, sourceStatus, startSource, '采集失败',
  );
}
