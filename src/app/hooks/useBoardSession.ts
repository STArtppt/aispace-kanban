import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FileItem, Scan } from '@/lib/api';
import { CODE_LANG_BY_EXT } from '../../shared/codeLang.mjs';

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

/**
 * 当次扫描里所有能直接打开的路径，口径与下面的 `findFileInScan` 一致。
 * 行内代码自动成链只认这里面的精确命中 —— 两处口径分叉，就会出现「能成链、点了打不开」。
 */
export function scanPathSet(scan: Scan | null): Set<string> {
  const out = new Set<string>();
  if (!scan || scan.available === false) return out;
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
    for (const item of list) out.add(item.path);
  }
  for (const item of scan.input.converted) {
    if (item.manifestPath) out.add(item.manifestPath);
    for (const sheet of item.sheets || []) out.add(sheet.path);
  }
  for (const group of scan.input.assetGroups || []) {
    out.add(group.path);
    for (const image of group.images) out.add(image.path);
  }
  if (scan.meta.exists && scan.meta.path) out.add(scan.meta.path);
  if (scan.input.indexPath) out.add(scan.input.indexPath);
  return out;
}

/**
 * 扫描清单之外的文件（`output/README.md`、`scripts/*.py`……）按扩展名合成最小条目，
 * 形态同 `findFileInScan` 给 `project.yaml` 的兜底。
 * 只认 markdown 与文本 / 代码：csv、图片、html 在扫描范围外时多是杂项，
 * 合成成表格或 iframe 容易踩到那些阅读器的其他前提，宁可交还给浏览器。
 */
function synthesizeFileItem(path: string): FileItem | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
  if (!ext) return null;
  const reader =
    ext === '.md' || ext === '.markdown'
      ? 'markdown'
      : ext === '.txt' || ext in CODE_LANG_BY_EXT
        ? 'text'
        : null;
  if (!reader) return null;
  return { path, name, ext, reader, size: 0, mtime: '' };
}

/** 扫描里有就用扫描的条目，没有再按扩展名合成。 */
function resolveFile(scan: Scan | null, path: string): FileItem | null {
  const found = scan && scan.available !== false ? findFileInScan(scan, path) : null;
  return found ?? synthesizeFileItem(path);
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
    // 文档里链的往往是摘要 `_manifest_<名>.md`，它代表的是整份产物
    if (item.manifestPath === path) return item;
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
 *
 * 后退链：经文档里的链接切换预览时记下跳转前的路径。只存路径、只在内存 ——
 * 存 FileItem 回去时 mtime 可能已过期；刷新后恢复「最后看的那一份」已有预览记录负责。
 */
export function useBoardSession(activeId: string, scan: Scan | null) {
  const [view, setView] = useState<View>(readView);
  const [openFile, setOpenFile] = useState<FileItem | null>(null);
  const [backStack, setBackStack] = useState<string[]>([]);

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  const showFile = useCallback(
    (item: FileItem | null) => {
      setOpenFile(item);
      if (!activeId) return;
      writePreviewPath(activeId, item?.path ?? null);
    },
    [activeId],
  );

  /** 清单、概览、搜索等链接以外的入口，以及关闭预览：都从头开始，后退链清空 */
  const selectFile = useCallback(
    (item: FileItem | null) => {
      setBackStack([]);
      showFile(item);
    },
    [showFile],
  );

  /**
   * 按路径打开：扫描命中 → 按扩展名合成 → 都不行返回 `external`，由调用方交给浏览器。
   * 问题单不在这里判：它归工作台，由 App 在调这个之前先查问题清单。
   */
  const openPath = useCallback(
    (path: string, options?: { viaLink?: boolean }): 'opened' | 'external' => {
      const item = resolveFile(scan, path);
      if (!item) return 'external';
      if (openFile?.path === item.path) return 'opened';
      if (options?.viaLink && openFile) {
        const from = openFile.path;
        setBackStack((stack) => [...stack, from]);
      } else {
        setBackStack([]);
      }
      showFile(item);
      return 'opened';
    },
    [scan, openFile, showFile],
  );

  /** 用最新扫描重新解析栈顶；回不去的（被删、被移走）跳过继续弹 */
  const goBack = useCallback(() => {
    const stack = [...backStack];
    while (stack.length) {
      const path = stack.pop()!;
      const item = resolveFile(scan, path);
      if (!item) continue;
      setBackStack(stack);
      showFile(item);
      return;
    }
    setBackStack([]);
  }, [backStack, scan, showFile]);

  const pathSet = useMemo(() => scanPathSet(scan), [scan]);

  useEffect(() => {
    setOpenFile(null);
    setBackStack([]);
  }, [activeId]);

  useEffect(() => {
    if (!scan || !activeId || scan.available === false) return;
    if (scan.project.id !== activeId) return;
    const path = readPreviewStore()[activeId];
    if (!path) return;
    // 扫描外的 .md / 代码（经链接打开过的 README、脚本）也要能恢复，所以走同一个兜底
    const item = resolveFile(scan, path);
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

  return {
    view,
    setView,
    openFile,
    selectFile,
    openPath,
    goBack,
    canGoBack: backStack.length > 0,
    pathSet,
  };
}
