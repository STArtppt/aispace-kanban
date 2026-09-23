import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type NoteHistory, type NoteHistoryBatch, type NoteHistoryItem, type NoteSaveResult } from '@/lib/api';

/**
 * 一篇文档上已经落盘的批注。工作空间的批注文件和看板缓存合并在同一份列表里。
 * 旧服务没有接口、或返回里没有新字段时，退回空列表 / 不显示来源，批注本身仍可用。
 */
export function useNoteHistory(projectId: string, file: string) {
  const [batches, setBatches] = useState<NoteHistoryBatch[]>([]);
  const [recordId, setRecordId] = useState<string | null | undefined>(undefined);
  const [noteFile, setNoteFile] = useState<string | undefined>(undefined);
  const [noteFileBroken, setNoteFileBroken] = useState(false);
  const [noteFileReason, setNoteFileReason] = useState<string | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const recordIdRef = useRef(recordId);
  recordIdRef.current = recordId;

  const apply = useCallback((data: NoteHistory) => {
    setBatches(data.batches ?? []);
    setRecordId('recordId' in data ? data.recordId : undefined);
    setNoteFile(data.noteFile);
    setNoteFileBroken(Boolean(data.noteFileBroken));
    setNoteFileReason(data.noteFileReason);
  }, []);

  const load = useCallback(async () => {
    if (!projectId || !file) {
      setBatches([]);
      setRecordId(undefined);
      setNoteFile(undefined);
      setNoteFileBroken(false);
      setNoteFileReason(undefined);
      return null;
    }
    try {
      const data = await api.noteHistory(projectId, file);
      apply(data);
      return data;
    } catch {
      setBatches([]);
      setRecordId(undefined);
      setNoteFile(undefined);
      setNoteFileBroken(false);
      setNoteFileReason(undefined);
      return null;
    }
  }, [apply, projectId, file]);

  useEffect(() => {
    let cancel = false;
    setReady(false);
    void load().finally(() => {
      if (!cancel) setReady(true);
    });
    return () => {
      cancel = true;
    };
  }, [load]);

  const append = useCallback(
    async (notes: NoteHistoryItem[]) => {
      const data = await api.appendNoteHistory(projectId, file, notes);
      apply(data);
      return data;
    },
    [apply, projectId, file],
  );

  const save = useCallback(
    async (notes: NoteHistoryItem[], explicitId?: string): Promise<NoteSaveResult> => {
      // 允许调用方传入刚 load 到的编号。只读 state 会晚一拍，点复制时会误判成没有记录
      const id = explicitId || recordIdRef.current;
      if (!id) {
        throw new Error('这份文件还没有产出物记录，不能写入批注文件。');
      }
      const data = await api.saveNotes(projectId, id, notes);
      await load();
      return data;
    },
    [load, projectId],
  );

  const clear = useCallback(async () => {
    const data = await api.clearNoteHistory(projectId, file);
    apply(data);
  }, [apply, projectId, file]);

  return {
    batches,
    recordId,
    noteFile,
    noteFileBroken,
    noteFileReason,
    ready,
    load,
    append,
    save,
    clear,
  };
}
