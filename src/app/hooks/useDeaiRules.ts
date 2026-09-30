import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type DeaiRules } from '@/lib/api';

/**
 * 去 AI 味规则库。挂在工作台上（浏览页的「v3 · 18 条」与模块页共用一份）。
 * 规则库在 `.claude/skills/` 下，不在 SSE 监听范围里：工作台每次打开重拉一次（`openToken`），
 * 产出目录有变化（交付稿、批注）也静默重拉。404 是旧服务：卡片不显示计数，模块页提示重启。
 */
export function useDeaiRules(projectId: string, changeToken: number, openToken: unknown) {
  const [rules, setRules] = useState<DeaiRules | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [unsupported, setUnsupported] = useState(false);

  const load = useCallback(
    async (silent = false) => {
      if (!projectId) {
        setRules(null);
        setError('');
        setUnsupported(false);
        return;
      }
      if (!silent) setLoading(true);
      try {
        setRules(await api.deaiRules(projectId));
        setError('');
        setUnsupported(false);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          setUnsupported(true);
          setRules(null);
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
    if (!changeToken && !openToken) return;
    void load(true);
  }, [changeToken, openToken, load]);

  return { rules, loading, error, unsupported, reload: load };
}
