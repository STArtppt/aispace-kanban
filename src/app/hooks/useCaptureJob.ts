import { useCallback, useEffect, useState } from 'react';
import { api, type CaptureJob, type CapturePlane } from '@/lib/api';

/** 采集任务轮询间隔。抓页面 + 三张截图通常十几秒到一分钟，1.5s 够用又不刷接口 */
const CAPTURE_POLL_MS = 1500;

export interface CaptureControl {
  job: CaptureJob | null;
  running: boolean;
  error: string;
  /**
   * 接口不存在（服务进程比前端旧）。为 true 时两个 tab 都禁用采集按钮并提示重启，
   * 清单照常显示 —— 不白屏、不报错。
   */
  unsupported: boolean;
  start: (plane: CapturePlane, url: string) => Promise<void>;
  dismissError: () => void;
}

/**
 * 贴 URL 采集 / 导入的任务状态，**参考 tab 与原型 tab 共用这一份**。
 *
 * 服务端每个工作空间只允许一轮采集，两个 tab 各自存一份状态的话，
 * 第二处会撞上 409 却显示成「没反应」—— 所以提到 VisualPanel 一层。
 * 写盘由服务端完成，落盘后靠 visualization/ 的 SSE 刷新清单，这里不管清单。
 */
export function useCaptureJob(projectId: string): CaptureControl {
  const [job, setJob] = useState<CaptureJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [polling, setPolling] = useState(false);

  const applyJob = useCallback((next: CaptureJob, opts?: { hydrate?: boolean }) => {
    setJob(next);
    setPolling(next.status === 'running');
    // 失败提示是这次点击的反馈，不是服务端还记着的上一轮 error：
    // 刷新 / 切项目只接回进行中的任务，已经结束的失败不自动再弹（与 useIngestJob 同规矩）
    if (next.status === 'error') {
      if (!opts?.hydrate) setError(next.message || '采集失败');
    } else if (next.status === 'done') setError('');
  }, []);

  // 切项目：清状态，并查一次是否已有进行中的任务（刷新页面后还能接上）
  useEffect(() => {
    setJob(null);
    setError('');
    setBusy(false);
    setPolling(false);
    setUnsupported(false);
    if (!projectId) return undefined;
    let cancelled = false;
    void api
      .captureStatus(projectId)
      .then((status) => {
        if (!cancelled) applyJob(status, { hydrate: true });
      })
      .catch(() => {
        // 旧服务进程没有这个接口：禁用按钮并提示重启，两个清单照常显示
        if (!cancelled) setUnsupported(true);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, applyJob]);

  useEffect(() => {
    if (!polling || !projectId) return undefined;
    let cancelled = false;
    const timer = setInterval(() => {
      void api
        .captureStatus(projectId)
        .then((status) => {
          if (!cancelled) applyJob(status);
        })
        .catch((err) => {
          if (!cancelled) {
            setPolling(false);
            setError((err as Error).message);
          }
        });
    }, CAPTURE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [polling, projectId, applyJob]);

  const start = useCallback(
    async (plane: CapturePlane, url: string) => {
      setBusy(true);
      setError('');
      try {
        applyJob(await api.startCapture(projectId, plane, url));
      } catch (err) {
        // 409（已有采集在进行中）、400（地址不合法）、403（非环回 / 跨站）都走这里，
        // 服务端那句话已经说清了原因，原样显示
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
    unsupported,
    start,
    dismissError,
  };
}
