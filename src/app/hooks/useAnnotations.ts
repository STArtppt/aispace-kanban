import { useCallback, useSyncExternalStore } from 'react';
import type { StructureHint } from '@/lib/sourceAnchor';

/**
 * 预览批注批次。纯前端偏好（不写工作空间、不写服务端），按工作空间 + 文档分键。
 * 清单式操作要在阅读器和面板同时看见，所以状态放模块级，useSyncExternalStore 广播。
 *
 * 键名 aispace-kanban:preview-notes：一次性评审批次，改键会丢掉未发送的批注。
 */
const NOTE_KEY = 'aispace-kanban:preview-notes';

export interface Annotation {
  id: string;
  file: string;
  start: number;
  end: number;
  quote: string;
  comment: string;
  structure: StructureHint;
  createdAt: string;
}

type FileBucket = {
  notes: Annotation[];
  seenMtime?: string;
};

type Store = Record<string, Record<string, FileBucket>>;

const STRUCTURES = new Set<StructureHint>(['段落', '表格行', '列表项', '跨块']);
const EMPTY_NOTES: Annotation[] = [];

let cache: Store | null = null;
let generation = 0;
const listeners = new Set<() => void>();

function isNote(value: unknown): value is Annotation {
  if (!value || typeof value !== 'object') return false;
  const note = value as Record<string, unknown>;
  return (
    typeof note.id === 'string' &&
    typeof note.file === 'string' &&
    typeof note.start === 'number' &&
    Number.isFinite(note.start) &&
    typeof note.end === 'number' &&
    Number.isFinite(note.end) &&
    note.end >= note.start &&
    typeof note.quote === 'string' &&
    typeof note.comment === 'string' &&
    typeof note.createdAt === 'string' &&
    typeof note.structure === 'string' &&
    STRUCTURES.has(note.structure as StructureHint)
  );
}

function readStore(): Store {
  if (cache) return cache;
  const next: Store = {};
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(NOTE_KEY) || '{}');
    if (!raw || typeof raw !== 'object') {
      cache = next;
      return cache;
    }
    for (const [projectId, files] of Object.entries(raw as Record<string, unknown>)) {
      if (!files || typeof files !== 'object') continue;
      const bucket: Record<string, FileBucket> = {};
      for (const [file, entry] of Object.entries(files as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object') continue;
        const rec = entry as Record<string, unknown>;
        const notes = Array.isArray(rec.notes) ? rec.notes.filter(isNote) : [];
        const seenMtime = typeof rec.seenMtime === 'string' ? rec.seenMtime : undefined;
        if (notes.length) bucket[file] = { notes, seenMtime };
      }
      if (Object.keys(bucket).length) next[projectId] = bucket;
    }
  } catch {
    // 存坏了当作没有批注：少一批意见，也好过整个预览崩掉
  }
  cache = next;
  return cache;
}

function persist() {
  const store = readStore();
  localStorage.setItem(NOTE_KEY, JSON.stringify(store));
  generation += 1;
  for (const notify of listeners) notify();
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `n-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function bucketOf(store: Store, projectId: string, file: string): FileBucket | undefined {
  return store[projectId]?.[file];
}

export function useAnnotations(projectId: string, file: string) {
  useSyncExternalStore(subscribe, () => generation);
  const bucket = bucketOf(readStore(), projectId, file);
  const notes = bucket?.notes ?? EMPTY_NOTES;
  const seenMtime = bucket?.seenMtime;

  const add = useCallback(
    (
      input: {
        start: number;
        end: number;
        quote: string;
        comment: string;
        structure: StructureHint;
      },
      mtime: string,
    ) => {
      const store = readStore();
      const files = store[projectId] || (store[projectId] = {});
      const current = files[file] || { notes: [] };
      const note: Annotation = {
        id: newId(),
        file,
        start: input.start,
        end: input.end,
        quote: input.quote,
        comment: input.comment,
        structure: input.structure,
        createdAt: new Date().toISOString(),
      };
      files[file] = {
        notes: [...current.notes, note],
        seenMtime: current.seenMtime ?? mtime,
      };
      persist();
    },
    [projectId, file],
  );

  const update = useCallback(
    (id: string, comment: string) => {
      const store = readStore();
      const current = bucketOf(store, projectId, file);
      if (!current) return;
      current.notes = current.notes.map((note) => (note.id === id ? { ...note, comment } : note));
      persist();
    },
    [projectId, file],
  );

  const remove = useCallback(
    (id: string) => {
      const store = readStore();
      const files = store[projectId];
      const current = files?.[file];
      if (!current) return;
      const notesNext = current.notes.filter((note) => note.id !== id);
      if (notesNext.length) files[file] = { ...current, notes: notesNext };
      else delete files[file];
      if (files && !Object.keys(files).length) delete store[projectId];
      persist();
    },
    [projectId, file],
  );

  const clear = useCallback(() => {
    const store = readStore();
    const files = store[projectId];
    if (!files?.[file]) return;
    delete files[file];
    if (!Object.keys(files).length) delete store[projectId];
    persist();
  }, [projectId, file]);

  const keep = useCallback(
    (mtime: string) => {
      const store = readStore();
      const current = bucketOf(store, projectId, file);
      if (!current?.notes.length) return;
      current.seenMtime = mtime;
      persist();
    },
    [projectId, file],
  );

  return { notes, seenMtime, add, update, remove, clear, keep };
}

export function isDocumentChanged(seenMtime: string | undefined, mtime: string, noteCount: number) {
  return Boolean(noteCount && seenMtime && seenMtime !== mtime);
}
