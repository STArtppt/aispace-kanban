import { useCallback, useEffect, useState } from 'react';
import { api, type Project, type Scan } from '@/lib/api';

const LAST_PROJECT_KEY = 'aispace-kanban:last-project';

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      const data = await api.projects();
      setProjects(data.projects);
      setActiveId((current) => {
        if (current && data.projects.some((p) => p.id === current)) return current;
        const remembered = localStorage.getItem(LAST_PROJECT_KEY) || '';
        if (data.projects.some((p) => p.id === remembered)) return remembered;
        return data.activeProjectId || data.projects[0]?.id || '';
      });
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const select = useCallback((id: string) => {
    setActiveId(id);
    localStorage.setItem(LAST_PROJECT_KEY, id);
  }, []);

  return { projects, activeId, select, loading, error, reload };
}

/** 拉扫描结果，并订阅工作空间文件变化自动刷新。 */
export function useScan(projectId: string) {
  const [scan, setScan] = useState<Scan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshedAt, setRefreshedAt] = useState('');
  // 工作空间目录变动的计数器。扫描自己会刷新，但不走 scan 的数据（未决问题清单）
  // 也要跟着动 —— 与其各开一条 EventSource，不如把这一路变动广播出去。
  const [changeToken, setChangeToken] = useState(0);

  const load = useCallback(
    async (silent = false) => {
      if (!projectId) {
        setScan(null);
        setError('');
        return;
      }
      if (!silent) setLoading(true);
      try {
        const data = await api.scan(projectId);
        setScan(data);
        setRefreshedAt(new Date().toISOString());
        setError('');
      } catch (err) {
        setError((err as Error).message);
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
    if (!projectId) return undefined;
    const source = new EventSource(`/api/projects/${projectId}/events`);
    source.addEventListener('change', () => {
      setChangeToken((n) => n + 1);
      void load(true);
    });
    return () => source.close();
  }, [projectId, load]);

  return { scan, loading, error, reload: load, refreshedAt, changeToken };
}
