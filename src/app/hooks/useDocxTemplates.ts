import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type DocxTemplateIndex } from '@/lib/api';

/**
 * docx 模板目录的清单。挂在工作台上（浏览页的模板数与模版洗炼页共用一份）。
 * 404 是旧服务：列表提示重启，卡片不显示计数。
 */
export function useDocxTemplates(projectId: string, changeToken: number) {
  const [index, setIndex] = useState<DocxTemplateIndex | null>(null);
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
        const data = await api.docxTemplates(projectId);
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
