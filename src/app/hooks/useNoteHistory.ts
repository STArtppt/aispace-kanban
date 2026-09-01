import { useCallback, useEffect, useState } from 'react';
import { api, type NoteHistoryBatch, type NoteHistoryItem } from '@/lib/api';

/**
 * 一篇文档上已经归档的批注批次。
 * 旧服务没有接口时退回空列表，清单里不出现历史、也不报错。
 */
export function useNoteHistory(projectId: string, file: string) {
  const [batches, setBatches] = useState<NoteHistoryBatch[]>([]);

  const load = useCallback(async () => {
    if (!projectId || !file) {
      setBatches([]);
      return;
    }
    try {
      const data = await api.noteHistory(projectId, file);
      setBatches(data.batches ?? []);
    } catch {
      setBatches([]);
    }
  }, [projectId, file]);

  useEffect(() => {
    void load();
  }, [load]);

  const append = useCallback(
    async (notes: NoteHistoryItem[]) => {
      const data = await api.appendNoteHistory(projectId, file, notes);
      setBatches(data.batches ?? []);
      return data;
    },
    [projectId, file],
  );

  const clear = useCallback(async () => {
    const data = await api.clearNoteHistory(projectId, file);
    setBatches(data.batches ?? []);
  }, [projectId, file]);

  return { batches, load, append, clear };
}
