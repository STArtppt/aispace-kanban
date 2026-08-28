import { useCallback, useEffect, useState } from 'react';
import type { FileItem, Scan } from '@/lib/api';

export type View = 'overview' | 'input' | 'output' | 'prototypes';

const VIEWS: readonly View[] = ['overview', 'input', 'output', 'prototypes'];
const VIEW_KEY = 'aispace-kanban:last-view';
const PREVIEW_KEY = 'aispace-kanban:last-preview';

function isView(value: string): value is View {
  return (VIEWS as readonly string[]).includes(value);
}

function readView(): View {
  try {
    const raw = localStorage.getItem(VIEW_KEY) || '';
    return isView(raw) ? raw : 'overview';
  } catch {
    return 'overview';
  }
}

function readPreviewStore(): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PREVIEW_KEY) || '{}');
    if (!raw || typeof raw !== 'object') return {};
    const next: Record<string, string> = {};
    for (const [id, path] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof path === 'string' && path) next[id] = path;
    }
    return next;
  } catch {
    // 存坏了当作没打开过预览：少恢复一页，也好过整页崩掉
    return {};
  }
}

function writePreviewPath(projectId: string, path: string | null) {
  const store = readPreviewStore();
  if (path) store[projectId] = path;
  else delete store[projectId];
  localStorage.setItem(PREVIEW_KEY, JSON.stringify(store));
}

/** 按相对路径从当次扫描里找回 FileItem。找不到就放弃，不造假条目。 */
function findFileInScan(scan: Scan, path: string): FileItem | null {
  const lists: FileItem[][] = [
    scan.input.raw,
    scan.input.converted,
    scan.input.assets,
    scan.input.pending,
    scan.output.analysis,
    scan.output.docs,
    scan.output.decisions,
  ];
  for (const list of lists) {
    for (const item of list) {
      if (item.path === path) return item;
    }
  }
  for (const item of scan.input.converted) {
    const sheet = item.sheets?.find((entry) => entry.path === path);
    if (sheet) return sheet;
  }
  for (const group of scan.input.assetGroups || []) {
    if (group.path === path) return group;
    const image = group.images.find((entry) => entry.path === path);
    if (image) return image;
  }
  if (scan.meta.exists && scan.meta.path === path) {
    return {
      path: scan.meta.path,
      name: scan.meta.path,
      reader: 'text',
      size: 0,
      mtime: scan.meta.mtime || '',
    };
  }
  if (scan.input.indexPath === path) {
    return {
      path: scan.input.indexPath,
      name: 'INDEX.md',
      reader: 'markdown',
      size: 0,
      mtime: '',
    };
  }
  return null;
}

/**
 * 记住当前视图和当前预览页：刷新后还停在离开时的位置。
 * 视图是全局偏好（切工作空间本来也不重置）；预览路径按工作空间存，
 * 避免模板同构路径在另一个空间被误打开。
 * 切工作空间时清掉预览是界面行为，不能当成「用户关掉了」写进存储。
 */
export function useBoardSession(activeId: string, scan: Scan | null) {
  const [view, setView] = useState<View>(readView);
  const [openFile, setOpenFile] = useState<FileItem | null>(null);

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  const selectFile = useCallback(
    (item: FileItem | null) => {
      setOpenFile(item);
      if (!activeId) return;
      writePreviewPath(activeId, item?.path ?? null);
    },
    [activeId],
  );

  useEffect(() => {
    setOpenFile(null);
  }, [activeId]);

  useEffect(() => {
    if (!scan || !activeId || scan.available === false) return;
    if (scan.project.id !== activeId) return;
    const path = readPreviewStore()[activeId];
    if (!path) return;
    const item = findFileInScan(scan, path);
    if (!item) return;
    setOpenFile((current) => {
      if (!current) return item;
      if (current.path !== item.path) return current;
      // 同一篇：换上当次扫描的条目，mtime 才能进 Reader 触发正文重读。
      // 磁盘没变就保住原引用，避免无谓重渲。
      if (current.mtime === item.mtime && current.size === item.size) return current;
      return item;
    });
  }, [scan, activeId]);

  return { view, setView, openFile, selectFile };
}
