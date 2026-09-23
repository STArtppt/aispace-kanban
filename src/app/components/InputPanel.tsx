import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, AppWindow, ArrowUpDown, ChevronDown, ChevronRight, CodeXml, Copy, Database, EyeOff, FileOutput, FileText, FolderOpen, Image, Key, ListFilter, Loader2, RefreshCw, Star, StarOff, Table, X } from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ExpandableSearch } from '@/components/ExpandableSearch';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AssetGalleryStack } from '@/components/AssetGalleryStack';
import { ImageLightbox } from '@/components/ImageLightbox';
import {
  EmptyState,
  HeaderIconButton,
  HeaderTooltip,
  ListPager,
  Row,
  RowActions,
  PanelTitle,
  TruncatedHint,
  writeClipboard,
  type RowAction,
} from '@/components/Primitives';
import { ApiKeyDialog, DatabaseSourceDialog, type EnvConfigKind } from '@/components/EnvConfigDialog';
import { DirActions, FileTree, ViewModeToggle, readViewMode, type ViewMode } from '@/components/FileTree';
import { codePreviewLanguage } from '@/components/CodeFileView';
import { useFileManagerName, usePathSeparator } from '@/hooks/useFileManager';
import { useSourceIngestJob, type IngestControl, type SourceIngestControl } from '@/hooks/useIngestJob';
import { usePins } from '@/hooks/usePins';
import {
  api,
  type ConvertedItem,
  type DatabaseSource,
  type DatabaseSourceItem,
  type FileItem,
  type IngestJob,
  type Scan,
} from '@/lib/api';
import { absolutePath, formatBytes, formatRelative, markdownLink } from '@/lib/format';
import { cn } from '@/lib/utils';

/** 待转换 / 转换产物列表一页条数 */
const LIST_PAGE_SIZE = 12;

function KindIcon({ item }: { item: { reader: string; isDir?: boolean; ext?: string; path?: string } }) {
  if (item.reader === 'html') return <AppWindow className="size-4 text-muted-foreground" />;
  if (item.isDir || item.reader === 'table') return <Table className="size-4 text-muted-foreground" />;
  if (item.reader === 'image') return <Image className="size-4 text-muted-foreground" />;
  if (codePreviewLanguage(item.ext || item.path || '')) {
    return <CodeXml className="size-4 text-muted-foreground" />;
  }
  return <FileText className="size-4 text-muted-foreground" />;
}

/** 待转换区说明的纯文本，给 tooltip 用；可见行是同一套句子，路径还带 code 标记 */
function pendingIntroText(pending: number, ignored: number, canIngest: boolean): string {
  let text = pending
    ? '这些文件还没有对应的转换产物，AI 读不到它们的内容。'
    : '原始资料放进 input/raw/ 后会出现在这里。';
  if (ignored) {
    text += `另有 ${ignored} 份按 input/.ingestignore 忽略，不算待转换。`;
  }
  if (pending) {
    text += '某一行「更多」里可以忽略此文件（或整目录），写进忽略清单，文件还在。';
  }
  text += canIngest
    ? '点「开始转换」会一次处理全部；某一行点「转换」只转那一份（大 PDF 可能要几分钟）。'
    : '在工作空间里跑一次 python3 scripts/ingest.py 即可。';
  return text;
}

/** 展示相对 raw/ 的路径，同名文件在不同子目录时能区分 */
function pendingLabel(item: FileItem): string {
  const prefix = 'input/raw/';
  if (item.path.startsWith(prefix)) {
    const rel = item.path.slice(prefix.length);
    return rel || item.name;
  }
  return item.name;
}

/** 名称模糊：空格分词，每段都要在标题/文件名/来源/路径里出现（大小写不敏感） */
function matchConverted(item: ConvertedItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [item.title, item.name, item.source, item.path, item.convertedBy]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return q.split(/\s+/).every((part) => hay.includes(part));
}

/** 待转换区搜索：文件名 / 相对 raw/ 的路径 */
function matchPending(item: FileItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [item.name, item.path, pendingLabel(item)].join('\n').toLowerCase();
  return q.split(/\s+/).every((part) => hay.includes(part));
}

/**
 * 「有几篇产出提到过它」。
 * hasOutputs 为 false 时一律不显示：一份产出都还没写的工作空间里，所有资料当然都是
 * 零引用，那时候提示只是噪音。referencedBy 缺失说明服务进程比前端旧，同样不显示。
 */
function referenceLabel(item: ConvertedItem, hasOutputs: boolean): string {
  if (!hasOutputs || !item.referencedBy) return '';
  return item.referencedBy.length ? ` · 被 ${item.referencedBy.length} 篇产出引用` : ' · 还没有产出引用它';
}

/** 没记来源的产物在树里的落脚处 */
const UNKNOWN_SOURCE = '未知来源';

/**
 * 产物在树里的位置。
 *
 * 服务端给了 treePath 就用它：新布局下 input/converted/ 与 input/raw/ 同构，产物自己的
 * 路径就是资料的整理方式，最准。旧布局（产物平铺在 converted/ 根下）没有这层结构，
 * 按产物自己的路径建树等于没建，退回跟着**原件**在 input/raw/ 下的目录走。
 * 两条路都认不出来时整棵树平铺，不平白多出一层「未知来源」。
 */
function convertedTreePath(item: ConvertedItem, hasAnySource: boolean): string {
  if (item.treePath && item.treePath.includes('/')) return item.treePath;
  const prefix = 'input/raw/';
  const source = item.source || '';
  // 来源不在 input/raw/ 下（理论上不该有）一并算「未知来源」：目录行的动作要按
  // input/raw/<树内路径> 反推真实目录，认不回去的就别给动作，免得指到不存在的路径
  if (!source.startsWith(prefix)) {
    return item.treePath || (hasAnySource ? `${UNKNOWN_SOURCE}/${item.name}` : item.name);
  }
  const rel = source.slice(prefix.length);
  const cut = rel.lastIndexOf('/');
  return cut > 0 ? `${rel.slice(0, cut)}/${item.name}` : item.treePath || item.name;
}

function ConvertedRow({
  item,
  indent,
  hasOutputs,
  pinned,
  absPath,
  onTogglePin,
  openPath,
  onOpen,
  canIngest,
  ingestRunning,
  ingestingPath,
  onIngest,
}: {
  item: ConvertedItem;
  /** 树形视图里的层级；列表视图不传 */
  indent?: number;
  hasOutputs: boolean;
  pinned: boolean;
  /** 拼好的取绝对路径函数，「复制绝对路径」用 */
  absPath: (relPath: string) => string;
  onTogglePin: (path: string) => void;
  openPath: string;
  onOpen: (item: FileItem) => void;
  canIngest: boolean;
  ingestRunning: boolean;
  ingestingPath: string;
  onIngest: (filePath: string) => void;
}) {
  // 原件动过才给「重新转换」：原件已不在（missing）重转不了，没动过也没必要重跑一遍。
  // ingest.py 按 sha256 幂等，对着原件再跑一次就会重出这份产物。
  const canReconvert = canIngest && item.sourceState === 'stale' && Boolean(item.source);
  return (
    <Row indent={indent} onClick={() => onOpen(item)} active={openPath === item.path}>
      <KindIcon item={item} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm">{item.title || item.name}</span>
          {pinned ? (
            <Star className="size-3.5 shrink-0 fill-current text-muted-foreground" />
          ) : null}
        </div>
        {/* 产物自身的相对路径：单文件产物到文件，目录型产物到目录 */}
        <span className="truncate text-xs text-muted-foreground" title={item.path}>
          {item.path}
          {item.reader === 'html' ? ' · HTML 原型' : ''}
          {item.sheets?.length ? ` · ${item.sheets.length} 张表` : ''}
          {item.sqlitePath ? ' · 可 SQL 检索' : ''}
          {item.extractedImages ? ` · ${item.extractedImages} 张图` : ''}
          {/* 转完删原件是正当用法，所以只如实标一句，不上 orange、不催人处理 */}
          {item.sourceState === 'missing' ? ' · 原件已不在' : ''}
          {/* 原件动过则产物可能已经不对，这是真要人重转一次的 —— 唯一上 orange 的一处 */}
          {item.sourceState === 'stale' ? (
            <span className="text-destructive"> · 原件转换后动过</span>
          ) : null}
          {referenceLabel(item, hasOutputs)}
        </span>
      </div>
      <RowActions
        busy={ingestRunning && ingestingPath === item.source}
        actions={[
          {
            label: pinned ? '取消收藏' : '收藏置顶',
            icon: pinned ? StarOff : Star,
            onSelect: () => onTogglePin(item.path),
          },
          ...(canReconvert
            ? [
                {
                  label: '重新转换',
                  icon: RefreshCw,
                  disabled: ingestRunning,
                  onSelect: () => onIngest(item.source || ''),
                },
              ]
            : []),
          {
            label: '复制路径',
            icon: Copy,
            onSelect: () => {
              void writeClipboard(markdownLink(item.title || item.name, item.path));
            },
          },
          {
            label: '复制绝对路径',
            icon: Copy,
            onSelect: () => {
              void writeClipboard(absPath(item.path));
            },
          },
        ]}
      />
    </Row>
  );
}

function useListPage(total: number, pageSize: number, resetKey: string) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const [page, setPage] = useState(0);

  useEffect(() => {
    setPage(0);
  }, [resetKey]);

  useEffect(() => {
    setPage((p) => Math.min(p, totalPages - 1));
  }, [totalPages]);

  return { page, setPage, totalPages };
}

function PendingRow({
  item,
  indent,
  projectId,
  fileManager,
  pinned,
  absPath,
  onTogglePin,
  openPath,
  onOpen,
  canIngest,
  ingestRunning,
  ingestingPath,
  onIngest,
  ignoring,
  onIgnore,
}: {
  item: FileItem;
  /** 树形视图里的层级；列表视图不传 */
  indent?: number;
  projectId: string;
  fileManager: string;
  pinned: boolean;
  /** 拼好的取绝对路径函数，「复制绝对路径」用 */
  absPath: (relPath: string) => string;
  onTogglePin: (path: string) => void;
  openPath: string;
  onOpen: (item: FileItem) => void;
  canIngest: boolean;
  ingestRunning: boolean;
  ingestingPath: string;
  onIngest: (filePath: string) => void;
  ignoring: boolean;
  onIgnore: (targetPath: string) => void;
}) {
  const thisRowRunning = (ingestRunning && ingestingPath === item.path) || ignoring;
  // 树里目录已经画在上一层了，行内只留文件名；列表里仍显示相对 raw/ 的路径
  const label = indent === undefined ? pendingLabel(item) : item.name;
  return (
    <Row indent={indent} onClick={() => onOpen(item)} active={openPath === item.path}>
      <KindIcon item={item} />
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm" title={item.path}>
          {label}
        </span>
        {pinned ? (
          <Star className="size-3.5 shrink-0 fill-current text-muted-foreground" />
        ) : null}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(item.size)}</span>
      <RowActions
        busy={thisRowRunning}
        actions={[
          {
            label: pinned ? '取消收藏' : '收藏置顶',
            icon: pinned ? StarOff : Star,
            onSelect: () => onTogglePin(item.path),
          },
          ...(canIngest
            ? [
                {
                  label: '转成AI易读',
                  icon: FileOutput,
                  disabled: ingestRunning,
                  onSelect: () => onIngest(item.path),
                },
              ]
            : []),
          {
            label: '忽略此文件',
            icon: EyeOff,
            disabled: ignoring,
            onSelect: () => onIgnore(item.path),
          },
          {
            label: '复制路径',
            icon: Copy,
            onSelect: () => {
              void writeClipboard(markdownLink(pendingLabel(item), item.path));
            },
          },
          {
            label: '复制绝对路径',
            icon: Copy,
            onSelect: () => {
              void writeClipboard(absPath(item.path));
            },
          },
          {
            label: `在${fileManager}中显示`,
            icon: FolderOpen,
            onSelect: () => {
              void api.reveal(projectId, item.path);
            },
          },
        ]}
      />
    </Row>
  );
}

function PendingList({
  items,
  viewMode,
  query,
  sortKey,
  projectId,
  absPath,
  openPath,
  onOpen,
  canIngest,
  ingestRunning,
  ingestingPath,
  onIngest,
  ignoringPath,
  onIgnore,
}: {
  items: FileItem[];
  viewMode: ViewMode;
  query: string;
  sortKey: SortKey;
  projectId: string;
  /** 拼好的取绝对路径函数，「复制绝对路径」用 */
  absPath: (relPath: string) => string;
  openPath: string;
  onOpen: (item: FileItem) => void;
  canIngest: boolean;
  ingestRunning: boolean;
  ingestingPath: string;
  onIngest: (filePath: string) => void;
  ignoringPath: string;
  onIgnore: (targetPath: string) => void;
}) {
  const { pins, togglePin } = usePins(projectId);
  const ordered = useMemo(() => {
    const list = items.filter((item) => matchPending(item, query));
    return list.sort((a, b) => {
      const pin = Number(pins.has(b.path)) - Number(pins.has(a.path));
      if (pin) return pin;
      if (sortKey === 'name') {
        return pendingLabel(a).localeCompare(pendingLabel(b), 'zh');
      }
      const cmp = (a.mtime || '').localeCompare(b.mtime || '');
      return sortKey === 'mtimeAsc' ? cmp : -cmp;
    });
  }, [items, query, sortKey, pins]);
  const searching = query.trim().length > 0;
  const { page, setPage } = useListPage(
    ordered.length,
    LIST_PAGE_SIZE,
    `${query}\0${sortKey}\0${ordered.length}\0${[...pins].join('\0')}`,
  );
  const pageItems = ordered.slice(page * LIST_PAGE_SIZE, (page + 1) * LIST_PAGE_SIZE);
  const fileManager = useFileManagerName();

  const rowProps = {
    projectId,
    fileManager,
    absPath,
    onTogglePin: togglePin,
    openPath,
    onOpen,
    canIngest,
    ingestRunning,
    ingestingPath,
    onIngest,
    onIgnore,
  };

  if (!ordered.length) {
    return searching ? (
      <EmptyState title="没有匹配的原始资料" hint="试试更短的关键词，或清空搜索" />
    ) : null;
  }

  const matchHint = searching ? (
    <p className="text-xs text-muted-foreground">匹配 {ordered.length} 项</p>
  ) : null;

  // 树形视图不分页：目录折起来就够收敛了，再切页反而找不到东西
  if (viewMode === 'tree') {
    return (
      <div className="flex flex-col gap-2">
        {matchHint}
        <FileTree
          items={ordered}
          treePathOf={pendingLabel}
          keyOf={(item) => item.path}
          expandAll={searching}
          renderFile={(item, indent) => (
            <PendingRow
              item={item}
              indent={indent}
              pinned={pins.has(item.path)}
              ignoring={ignoringPath === item.path}
              {...rowProps}
            />
          )}
          renderDirActions={(dirKey) => {
            const dirPath = `input/raw/${dirKey}`;
            const extra: RowAction[] = [
              ...(canIngest
                ? [
                    {
                      label: '转这一整个目录',
                      icon: FileOutput,
                      disabled: ingestRunning,
                      onSelect: () => onIngest(dirPath),
                    },
                  ]
                : []),
              {
                label: '忽略此目录',
                icon: EyeOff,
                disabled: Boolean(ignoringPath),
                onSelect: () => onIgnore(dirPath),
              },
            ];
            return (
              <DirActions
                projectId={projectId}
                fileManager={fileManager}
                dirPath={dirPath}
                absPath={absPath}
                extra={extra}
                busy={(ingestRunning && ingestingPath === dirPath) || ignoringPath === dirPath}
              />
            );
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {matchHint}
      <div className="overflow-hidden rounded-lg border border-border">
        {pageItems.map((item) => (
          <PendingRow
            key={item.path}
            item={item}
            pinned={pins.has(item.path)}
            ignoring={ignoringPath === item.path}
            {...rowProps}
          />
        ))}
        <ListPager page={page} pageSize={LIST_PAGE_SIZE} total={ordered.length} onPageChange={setPage} />
      </div>
    </div>
  );
}

const CONVERTED_FILTERS = {
  all: '全部',
  unreferenced: '未被引用',
  stale: '原件动过',
} as const;

type ConvertedFilter = keyof typeof CONVERTED_FILTERS;

const SORTS = {
  name: '按名称',
  mtimeAsc: '按时间正序',
  mtimeDesc: '按时间倒序',
} as const;

type SortKey = keyof typeof SORTS;

const CONVERTED_SORT_KEY = 'aispace-kanban:converted-sort';
/** 列表 / 树形是整个「输入资料」视图共用的偏好，待转换和转换产物一起切 */
const INPUT_VIEW_KEY = 'aispace-kanban:input-view';
/** 当前停在哪一类资料：默认转换产物，资料多了以后不想每次进来都先滚过待转换 */
const INPUT_TAB_KEY = 'aispace-kanban:input-tab';

const INPUT_TABS = [
  { key: 'pending' as const, title: '原始资料' },
  { key: 'converted' as const, title: '转换产物' },
  { key: 'assets' as const, title: '图片资料' },
  // 数据库源排在三个已有 tab **之后**，有 input/sources/ 目录才出现（见 showSources）
  { key: 'sources' as const, title: '数据库源' },
];

type InputTab = (typeof INPUT_TABS)[number]['key'];

const INPUT_TAB_KEYS: readonly string[] = INPUT_TABS.map((tab) => tab.key);

function isInputTab(value: string): value is InputTab {
  return INPUT_TAB_KEYS.includes(value);
}

/**
 * schema 快照多久算旧。写死一个默认值，先看用起来什么感觉 ——
 * 库结构不是天天改，一个月没采过才值得提醒一次。
 */
const SNAPSHOT_STALE_DAYS = 30;

function snapshotIsStale(iso?: string): boolean {
  if (!iso) return false;
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return false;
  return Date.now() - at > SNAPSHOT_STALE_DAYS * 24 * 60 * 60 * 1000;
}

function readConvertedSort(): SortKey {
  const raw = localStorage.getItem(CONVERTED_SORT_KEY);
  return raw === 'name' || raw === 'mtimeAsc' || raw === 'mtimeDesc' ? raw : 'name';
}

function readInputTab(): InputTab {
  const raw = localStorage.getItem(INPUT_TAB_KEY) || '';
  return isInputTab(raw) ? raw : 'converted';
}

/** 图标选择器：正方形触发器，藏掉默认文案和下拉箭头 */
const ICON_SELECT_TRIGGER =
  'size-8 min-h-8 w-8 justify-center gap-0 px-0 py-0 [&_.lucide-chevron-down]:hidden';
/** 标题栏描边方钮：与排序 / 筛选 SelectTrigger、搜索框同一套 size-8 + shadow-sm */
const TOOLBAR_ICON_BUTTON = 'size-8 shadow-sm';

function ConvertedList({
  items,
  hasOutputs,
  viewMode,
  query,
  activeFilter,
  sortKey,
  projectId,
  absPath,
  openPath,
  onOpen,
  canIngest,
  ingestRunning,
  ingestingPath,
  onIngest,
}: {
  items: ConvertedItem[];
  hasOutputs: boolean;
  viewMode: ViewMode;
  query: string;
  activeFilter: ConvertedFilter;
  sortKey: SortKey;
  projectId: string;
  /** 拼好的取绝对路径函数，「复制绝对路径」用 */
  absPath: (relPath: string) => string;
  openPath: string;
  onOpen: (item: FileItem) => void;
  canIngest: boolean;
  ingestRunning: boolean;
  ingestingPath: string;
  onIngest: (filePath: string) => void;
}) {
  const fileManager = useFileManagerName();
  const { pins, togglePin } = usePins(projectId);
  // 一份都没动过时不给这一档：清单里筛出来必然是空的
  const staleCount = items.filter((item) => item.sourceState === 'stale').length;
  const filtered = useMemo(() => {
    const list = items.filter((item) => {
      if (activeFilter === 'unreferenced' && item.referencedBy?.length !== 0) return false;
      if (activeFilter === 'stale' && item.sourceState !== 'stale') return false;
      return matchConverted(item, query);
    });
    return list.sort((a, b) => {
      // 收藏的一律在前，名称 / 时间排序只在收藏内外各自生效
      const pin = Number(pins.has(b.path)) - Number(pins.has(a.path));
      if (pin) return pin;
      if (sortKey === 'name') {
        return (a.title || a.name).localeCompare(b.title || b.name, 'zh');
      }
      const cmp = (a.mtime || '').localeCompare(b.mtime || '');
      return sortKey === 'mtimeAsc' ? cmp : -cmp;
    });
  }, [items, query, activeFilter, sortKey, pins]);
  const { page, setPage } = useListPage(
    filtered.length,
    LIST_PAGE_SIZE,
    `${query}\0${activeFilter}\0${sortKey}\0${items.length}\0${[...pins].join('\0')}`,
  );
  const pageItems = filtered.slice(page * LIST_PAGE_SIZE, (page + 1) * LIST_PAGE_SIZE);
  const searching = query.trim().length > 0;
  const hasAnySource = useMemo(() => items.some((item) => item.source), [items]);
  const treePathOf = useCallback(
    (item: ConvertedItem) => convertedTreePath(item, hasAnySource),
    [hasAnySource],
  );

  return (
    <div className="flex flex-col gap-2">
      {/* 原件动过的产物「已经转过」，所以不会回到待转换列表 —— 不说这句，人会在那边一直找不到它 */}
      {staleCount ? (
        <p className="text-xs text-muted-foreground">
          有 <span className="text-destructive">{staleCount} 份原件在转换后动过</span>
          ，产物可能已经不对。它们已经有产物，不会回到待转换列表；右上角筛选可以只看这些。
          {canIngest
            ? '行内「更多」点「重新转换」只重转那一份；「原始资料」里的「开始转换」会把动过的一起重跑。'
            : '在工作空间里重跑一次 scripts/ingest.py 即可，只有动过的会重转。'}
        </p>
      ) : null}
      {searching ? (
        <p className="text-xs text-muted-foreground">
          {filtered.length ? `匹配 ${filtered.length} 项` : '没有匹配的转换产物'}
        </p>
      ) : null}
      {filtered.length && viewMode === 'tree' ? (
        // 树形视图不分页：目录折起来就够收敛了，再切页反而找不到东西
        <FileTree
          items={filtered}
          treePathOf={treePathOf}
          keyOf={(item) => item.path}
          expandAll={searching}
          renderDirActions={(dirKey) =>
            // 「未知来源」是前端为没记来源的产物造的一档，磁盘上没有这个目录，不给动作
            dirKey === UNKNOWN_SOURCE ? null : (
              <DirActions
                projectId={projectId}
                fileManager={fileManager}
                dirPath={`input/raw/${dirKey}`}
                absPath={absPath}
              />
            )
          }
          renderFile={(item, indent) => (
            <ConvertedRow
              item={item}
              indent={indent}
              hasOutputs={hasOutputs}
              pinned={pins.has(item.path)}
              absPath={absPath}
              onTogglePin={togglePin}
              openPath={openPath}
              onOpen={onOpen}
              canIngest={canIngest}
              ingestRunning={ingestRunning}
              ingestingPath={ingestingPath}
              onIngest={onIngest}
            />
          )}
        />
      ) : filtered.length ? (
        <div className="overflow-hidden rounded-lg border border-border">
          {pageItems.map((item) => (
            <ConvertedRow
              key={item.path}
              item={item}
              hasOutputs={hasOutputs}
              pinned={pins.has(item.path)}
              absPath={absPath}
              onTogglePin={togglePin}
              openPath={openPath}
              onOpen={onOpen}
              canIngest={canIngest}
              ingestRunning={ingestRunning}
              ingestingPath={ingestingPath}
              onIngest={onIngest}
            />
          ))}
          <ListPager
            page={page}
            pageSize={LIST_PAGE_SIZE}
            total={filtered.length}
            onPageChange={setPage}
          />
        </div>
      ) : searching ? (
        <EmptyState title="没有匹配的转换产物" hint="试试更短的关键词，或清空搜索" />
      ) : activeFilter === 'unreferenced' ? (
        <EmptyState
          title="没有未被引用的资料"
          hint="产出正文里出现它的路径或文件名就算引用"
        />
      ) : activeFilter === 'stale' ? (
        <EmptyState title="没有原件动过的产物" hint="每份产物都还对得上转换时的原件" />
      ) : (
        <EmptyState
          title="还没有转换产物"
          hint={
            canIngest
              ? '把资料放进 input/raw/，再到「原始资料」点「开始转换」'
              : '把资料放进 input/raw/，然后在工作空间里跑 scripts/ingest.py'
          }
        />
      )}
    </div>
  );
}

function IngestControls({
  job,
  running,
  error,
  onStart,
  onDismissError,
}: {
  job: IngestJob | null;
  running: boolean;
  error: string;
  onStart: () => void;
  onDismissError: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={running} onClick={onStart}>
          {running ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              转换中…
            </>
          ) : (
            '开始转换'
          )}
        </Button>
        {running ? (
          <span className="text-xs text-muted-foreground">
            {job?.message || '正在转换 input/raw/ …'}
          </span>
        ) : null}
        {job?.status === 'done' && !running ? (
          <span className="text-xs text-muted-foreground">{job.message || '转换完成'}</span>
        ) : null}
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>转换失败</AlertTitle>
          <AlertDescription className="max-h-72 overflow-auto whitespace-pre-wrap">
            {error}
          </AlertDescription>
          <AlertAction>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="关闭"
              onClick={onDismissError}
            >
              <X className="size-3.5" />
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
    </div>
  );
}

/**
 * 平铺网格：只在旧服务进程没给 assetGroups 时兜底（改动前的行为）。
 * 有图库分组时走 AssetGalleryStack —— 一份 PDF 几十张图全摞在一起没法找。
 */
function AssetGrid({ items, projectId }: { items: FileItem[]; projectId: string }) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const openIndex = openPath ? items.findIndex((item) => item.path === openPath) : -1;

  useEffect(() => {
    setOpenPath(null);
  }, [projectId]);

  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {items.map((item) => (
          <button
            key={item.path}
            type="button"
            onClick={() => setOpenPath(item.path)}
            className="group cursor-zoom-in overflow-hidden rounded-lg border border-border bg-muted/40 transition-colors hover:border-foreground/30"
          >
            <img
              src={api.fileUrl(projectId, item.path)}
              alt={item.name}
              loading="lazy"
              className="aspect-[4/3] w-full object-cover"
            />
            <span className="block truncate px-2 py-1.5 text-left text-[11px] text-muted-foreground">
              {item.name}
            </span>
          </button>
        ))}
      </div>
      {openIndex >= 0 ? (
        <ImageLightbox
          key={openPath}
          items={items.map((item) => ({
            src: api.fileUrl(projectId, item.path),
            alt: item.name,
          }))}
          initialIndex={openIndex}
          onClose={() => setOpenPath(null)}
        />
      ) : null}
    </>
  );
}

/** 一个数据源的状态说明。'ok' 之外的都要人处理，所以都走 orange。 */
function sourceStateNote(source: DatabaseSource): string {
  if (source.state === 'ok') return '';
  return source.stateReason
    || (source.state === 'unsupported' ? '暂不支持这个引擎'
      : source.state === 'orphan' ? '只剩产物，没有配置' : '配置读不出来');
}

/** 数据源下面挂的一份产物：schema 快照或查询结果。点了在右侧预览。 */
function SourceItemRow({
  item,
  openPath,
  onOpen,
}: {
  item: DatabaseSourceItem | FileItem;
  openPath: string;
  onOpen: (item: FileItem) => void;
}) {
  const sourceItem = item as DatabaseSourceItem;
  const sheets = sourceItem.sheets || [];
  const tableCount = typeof sourceItem.tableCount === 'number'
    ? sourceItem.tableCount
    : sourceItem.tables?.length;
  // 查询产物点开直接看结果表；schema 快照点开看摘要本身
  const target = sheets.length ? sheets[0] : item;
  const detail = [
    sheets.length ? `结果表 ${sheets[0].name}` : '',
    typeof tableCount === 'number' && tableCount > 0 ? `${tableCount} 张表的明细` : '',
    item.mtime ? formatRelative(item.mtime) : '',
  ].filter(Boolean).join(' · ');
  return (
    <Row indent={1} onClick={() => onOpen(target)} active={openPath === target.path}>
      <KindIcon item={item} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm">{item.title || item.name}</span>
        {detail ? (
          <span className="truncate text-xs text-muted-foreground">{detail}</span>
        ) : null}
      </div>
    </Row>
  );
}

/** 配置读不出 / 只剩产物的源没法采，标题栏刷新按钮也跳过它们 */
function ingestibleSources(sources: DatabaseSource[]): DatabaseSource[] {
  return sources.filter((source) => source.state !== 'unreadable' && source.state !== 'orphan');
}

/**
 * 「刷新 schema」放在「输入列表」标题栏右侧，跟排序 / 搜索同一排。
 * 只有一个可采的源就直接开采；多个源用下拉选出要刷哪一个 —— 采集接口一次只接一个源名。
 */
function SourceRefreshButton({
  sources,
  running,
  onStart,
}: {
  sources: DatabaseSource[];
  running: boolean;
  onStart: (key: string) => void;
}) {
  const eligible = ingestibleSources(sources);
  if (!eligible.length) return null;

  const icon = running ? (
    <Loader2 className="size-3.5 animate-spin" />
  ) : (
    <RefreshCw className="size-3.5" />
  );

  if (eligible.length === 1) {
    return (
      <HeaderIconButton
        label="刷新 schema"
        variant="outline"
        className={TOOLBAR_ICON_BUTTON}
        disabled={running}
        onClick={() => onStart(eligible[0].key)}
      >
        {icon}
      </HeaderIconButton>
    );
  }

  return (
    <DropdownMenu>
      <HeaderTooltip label="刷新 schema">
        <DropdownMenuTrigger
          disabled={running}
          render={
            <Button
              variant="outline"
              size="icon"
              className={TOOLBAR_ICON_BUTTON}
              aria-label="刷新 schema"
              disabled={running}
            />
          }
        >
          {icon}
        </DropdownMenuTrigger>
      </HeaderTooltip>
      <DropdownMenuContent align="end">
        {eligible.map((source) => (
          <DropdownMenuItem
            key={source.key}
            disabled={running}
            onClick={() => onStart(source.key)}
          >
            <Database />
            {source.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 「数据库源」tab 的正文：一个源一段，下面挂它的 schema 快照与查询产物。
 *
 * 这里**没有写 SQL 的地方**，刷新入口在标题栏右侧 —— 看板是只读看板，不是 SQL 客户端。
 * 按需查询由 AI 在终端里跑 `python3 scripts/db_ingest.py query …` 发起，
 * 产物写盘后由 SSE 推回来，自己出现在这个清单里。
 */
function DatabaseSourceList({
  sources,
  openPath,
  onOpen,
  canIngest,
  control,
}: {
  sources: DatabaseSource[];
  openPath: string;
  onOpen: (item: FileItem) => void;
  /** 工作空间里有 scripts/db_ingest.py 才提示点刷新；没有就只显示清单 */
  canIngest: boolean;
  control: SourceIngestControl;
}) {
  const runningSource = control.running ? control.job?.source || '' : '';
  // 记「收起了哪些」：默认展开，跟改动前一样能直接看到产物
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <TruncatedHint
        text={
          '数据库不同步到本地，只按需取：schema 快照是 KB 级摘要，查询结果才落成 csv。'
          + '这些产物不进「转换产物」清单 —— 数据库和文件是两条来源。'
          + (canIngest
            ? '点右上角刷新图标重采一次结构；按需查询在终端里跑 python3 scripts/db_ingest.py query。'
            : '这个工作空间没有 scripts/db_ingest.py，从模板里拷一份过来才能在看板上采集。')
        }
      >
        数据库不同步到本地，只按需取：schema 快照是 KB 级摘要，查询结果才落成 csv。
      </TruncatedHint>

      {control.error ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>采集失败</AlertTitle>
          <AlertDescription className="max-h-72 overflow-auto whitespace-pre-wrap">
            {control.error}
          </AlertDescription>
          <AlertAction>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="关闭"
              onClick={control.dismissError}
            >
              <X className="size-3.5" />
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {sources.map((source) => {
        const note = sourceStateNote(source);
        const stale = snapshotIsStale(source.snapshotAt);
        const running = runningSource === source.key;
        const open = !collapsed.has(source.key);
        // 上一轮采这个源失败了：跟「配置读不出来」一样是要人处理的事，一并走 orange
        const failed = !running
          && control.job?.source === source.key
          && control.job.status === 'error';
        const meta = [
          source.engine,
          source.database,
          source.schemas?.length ? source.schemas.join(' / ') : '',
        ].filter(Boolean).join(' · ');
        return (
          <section key={source.key} className="flex flex-col gap-1">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => toggle(source.key)}
              className="flex min-w-0 items-center gap-2 rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-accent"
            >
              {open ? (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <Database className="size-4 shrink-0 text-muted-foreground" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm">{source.name}</span>
                  {note ? (
                    <span className="shrink-0 text-xs text-destructive">{note}</span>
                  ) : null}
                </div>
                <span className="truncate text-xs text-muted-foreground">
                  {/* 原因已经在上一行标出来了，这里别再说一遍 */}
                  {meta || (source.configPath ?? '')}
                  {source.snapshotAt ? (
                    <>
                      {' · 结构采于 '}
                      <span className={cn(stale && 'text-destructive')}>
                        {formatRelative(source.snapshotAt)}
                        {stale ? `（超过 ${SNAPSHOT_STALE_DAYS} 天，可能已经对不上了）` : ''}
                      </span>
                    </>
                  ) : source.state === 'ok' ? ' · 还没采过结构' : ''}
                  {failed ? (
                    <span className="text-destructive">
                      {' · 上次采集失败：'}
                      {control.job?.message || ''}
                    </span>
                  ) : null}
                </span>
              </div>
              {running ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
              ) : null}
              {source.items.length ? (
                <span className="shrink-0 text-xs text-muted-foreground">{source.items.length}</span>
              ) : null}
            </button>
            {running ? (
              <p className="px-3 text-xs text-muted-foreground">
                {control.job?.message || '正在采集…'}
              </p>
            ) : null}
            {open ? (
              source.items.length ? (
                source.items.map((item) => (
                  <SourceItemRow
                    key={item.path}
                    item={item}
                    openPath={openPath}
                    onOpen={onOpen}
                  />
                ))
              ) : (
                <p className="px-3 py-1 text-xs text-muted-foreground">
                  {source.state === 'ok'
                    ? '还没有产物。点右上角刷新图标采一次结构，之后 AI 就能照着它写查询。'
                    : '没有产物。'}
                </p>
              )
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

export function InputPanel({
  scan,
  projectId,
  openPath,
  onOpen,
  ingest,
}: {
  scan: Scan;
  projectId: string;
  openPath: string;
  onOpen: (item: FileItem) => void;
  /** 转换任务状态在 App 里，待转换列表和预览页共用同一轮任务 */
  ingest: IngestControl;
}) {
  const { input } = scan;
  // 归档项照样计入溯源反链，所以「有没有产出」也要算上它们（total 只数主列表）
  const archivedOutputs = scan.output.stats.archived;
  const hasOutputs =
    scan.output.stats.total +
      (archivedOutputs ? archivedOutputs.analysis + archivedOutputs.docs + archivedOutputs.decisions : 0) >
    0;
  // 旧服务进程没有 canIngest：整块按钮不出现，只保留终端命令提示
  const canIngest = Boolean(input.canIngest);
  const [ignoringPath, setIgnoringPath] = useState('');
  const [ignoreError, setIgnoreError] = useState('');
  // 旧服务进程没有 assetGroups：退回平铺网格
  const galleries = input.assetGroups || [];
  /**
   * 「数据库源」tab 的唯一判据：服务端给了这个字段（空数组也算）。
   * 字段缺省 = 没有 input/sources/ 目录，或旧服务进程 —— 不渲染这个 tab。
   */
  const showSources = Array.isArray(input.sources);
  const sources = input.sources || [];
  const sourceIngest = useSourceIngestJob(projectId, showSources && input.canIngestSources);
  const [envKind, setEnvKind] = useState<EnvConfigKind | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(() => readViewMode(INPUT_VIEW_KEY));
  const [tab, setTab] = useState<InputTab>(readInputTab);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ConvertedFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>(readConvertedSort);
  // 「复制绝对路径」要工作空间在磁盘上的位置，scan.project.root 里带着；拿不到时 absolutePath 自己退回相对路径
  const sep = usePathSeparator();
  const absPath = useCallback(
    (relPath: string) => absolutePath(scan.project.root, relPath, sep),
    [scan.project.root, sep],
  );

  const ignore = useCallback(
    async (targetPath: string) => {
      setIgnoreError('');
      setIgnoringPath(targetPath);
      try {
        await api.addIgnore(projectId, targetPath);
      } catch (err) {
        setIgnoreError((err as Error).message);
      } finally {
        setIgnoringPath('');
      }
    },
    [projectId],
  );

  useEffect(() => {
    setIgnoreError('');
    setIgnoringPath('');
    setQuery('');
    setFilter('all');
  }, [projectId]);

  useEffect(() => {
    localStorage.setItem(INPUT_VIEW_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem(INPUT_TAB_KEY, tab);
  }, [tab]);

  useEffect(() => {
    localStorage.setItem(CONVERTED_SORT_KEY, sortKey);
  }, [sortKey]);

  // 没产出、或旧服务没给 referencedBy：筛「未被引用」没意义，那一档就不出
  const canFilterUnreferenced =
    hasOutputs && input.converted.some((item) => Array.isArray(item.referencedBy));
  const canFilterStale = input.converted.some((item) => item.sourceState === 'stale');
  const filterOptions: ConvertedFilter[] = [
    'all',
    ...(canFilterUnreferenced ? (['unreferenced'] as const) : []),
    ...(canFilterStale ? (['stale'] as const) : []),
  ];
  const activeFilter = filterOptions.includes(filter) ? filter : 'all';
  const tabCounts: Record<InputTab, number> = {
    pending: input.pending.length,
    converted: input.converted.length,
    assets: input.assets.length,
    sources: sources.length,
  };
  const visibleTabs = INPUT_TABS.filter((item) => item.key !== 'sources' || showSources);
  /**
   * localStorage 里记着的可能是「数据库源」，而这个工作空间根本没有数据源
   * （换了工作空间、或者源配置被删了）—— 那时退回默认 tab，不能渲染一个不存在的 tab。
   * 只改这里显示用的值，不动记着的偏好：源再配回来时还停在数据库源上。
   */
  const activeTab: InputTab = tab === 'sources' && !showSources ? 'converted' : tab;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section className="flex min-w-0 flex-col gap-2">
        <div className="flex min-h-8 min-w-0 items-center justify-between gap-3">
          <div className="min-w-0 shrink">
            <PanelTitle>输入列表</PanelTitle>
          </div>
          {/*
            视图切换带边框+内边距，实际约 34px，比 min-h-8 / size-8 刷新按钮都高。
            图片资料、数据库源用不到排序搜索，但仍要占着这排高度，否则标题和 tab 会往上跳。
            刷新按钮叠在同一格右对齐，不把占位卸掉。
          */}
          <div className="grid shrink-0">
            <div
              className={cn(
                'col-start-1 row-start-1 flex items-center gap-2',
                (activeTab === 'assets' || activeTab === 'sources') && 'invisible pointer-events-none',
              )}
              aria-hidden={activeTab === 'assets' || activeTab === 'sources'}
            >
              {activeTab === 'pending' ? (
                <HeaderIconButton
                  label="添加 API Key"
                  variant="outline"
                  className={TOOLBAR_ICON_BUTTON}
                  onClick={() => setEnvKind('api_key')}
                >
                  <Key className="size-3.5 text-muted-foreground" />
                </HeaderIconButton>
              ) : null}
              <ViewModeToggle mode={viewMode} onChange={setViewMode} label="资料清单" />
              <Select
                value={sortKey}
                onValueChange={(value) => {
                  if (value === 'name' || value === 'mtimeAsc' || value === 'mtimeDesc') {
                    setSortKey(value);
                  }
                }}
              >
                <HeaderTooltip label="排序">
                  <SelectTrigger className={ICON_SELECT_TRIGGER} aria-label="排序输入资料">
                    <ArrowUpDown
                      className={cn(
                        'size-3.5',
                        sortKey === 'name' ? 'text-muted-foreground' : 'text-foreground',
                      )}
                    />
                  </SelectTrigger>
                </HeaderTooltip>
                <SelectContent align="end" className="min-w-36 w-max">
                  <SelectItem value="name">{SORTS.name}</SelectItem>
                  <SelectItem value="mtimeAsc">{SORTS.mtimeAsc}</SelectItem>
                  <SelectItem value="mtimeDesc">{SORTS.mtimeDesc}</SelectItem>
                </SelectContent>
              </Select>
              {activeTab === 'converted' && filterOptions.length > 1 ? (
                <Select
                  value={activeFilter}
                  onValueChange={(value) => {
                    if (filterOptions.includes(value as ConvertedFilter)) {
                      setFilter(value as ConvertedFilter);
                    }
                  }}
                >
                  <HeaderTooltip label="筛选">
                    <SelectTrigger className={ICON_SELECT_TRIGGER} aria-label="筛选转换产物">
                      <ListFilter
                        className={cn(
                          'size-3.5',
                          activeFilter === 'all' ? 'text-muted-foreground' : 'text-foreground',
                        )}
                      />
                    </SelectTrigger>
                  </HeaderTooltip>
                  <SelectContent align="end" className="min-w-36 w-max">
                    {filterOptions.map((option) => (
                      <SelectItem key={option} value={option}>
                        {CONVERTED_FILTERS[option]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              <ExpandableSearch
                key={projectId}
                value={query}
                onChange={setQuery}
                expandedClassName="w-[12rem] sm:w-[14rem]"
                aria-label="搜索输入资料"
              />
            </div>
            {activeTab === 'sources' ? (
              <div className="col-start-1 row-start-1 flex items-center justify-end gap-2">
                <HeaderIconButton
                  label="添加数据库源"
                  variant="outline"
                  className={TOOLBAR_ICON_BUTTON}
                  onClick={() => setEnvKind('database')}
                >
                  <Database className="size-3.5 text-muted-foreground" />
                </HeaderIconButton>
                {input.canIngestSources ? (
                  <SourceRefreshButton
                    sources={sources}
                    running={sourceIngest.running}
                    onStart={(key) => void sourceIngest.start(key)}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {/* 非当前 tab 不挂载：资料多时三个清单一起画会卡，切走就把 DOM 卸掉 */}
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            if (isInputTab(value)) setTab(value);
          }}
          className="gap-4"
        >
          <TabsList variant="line">
            {visibleTabs.map(({ key, title }) => (
              <TabsTrigger key={key} value={key} className="px-2">
                <span className="truncate">{title}</span>
                <span className="shrink-0 text-xs font-normal text-muted-foreground">
                  {tabCounts[key]}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="pending" className="flex min-w-0 flex-col gap-2">
            {/* 看板变窄或预览展开时这行会顶破布局，所以单行截断，完整说明进 tooltip */}
            <TruncatedHint text={pendingIntroText(input.pending.length, input.stats.ignored || 0, canIngest)}>
              {input.pending.length
                ? '这些文件还没有对应的转换产物，AI 读不到它们的内容。'
                : '原始资料放进 input/raw/ 后会出现在这里。'}
              {input.stats.ignored ? (
                <>
                  另有 {input.stats.ignored} 份按
                  <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                    input/.ingestignore
                  </code>
                  忽略，不算待转换。
                </>
              ) : null}
              {input.pending.length
                ? '某一行「更多」里可以忽略此文件（或整目录），写进忽略清单，文件还在。'
                : null}
              {canIngest ? (
                '点「开始转换」会一次处理全部；某一行点「转换」只转那一份（大 PDF 可能要几分钟）。'
              ) : (
                <>
                  在工作空间里跑一次
                  <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                    python3 scripts/ingest.py
                  </code>
                  即可。
                </>
              )}
            </TruncatedHint>
            {canIngest ? (
              <IngestControls
                job={ingest.job}
                running={ingest.running}
                error={ingest.error}
                onStart={() => void ingest.start()}
                onDismissError={ingest.dismissError}
              />
            ) : null}
            {ignoreError ? (
              <p className="whitespace-pre-wrap text-xs text-destructive">{ignoreError}</p>
            ) : null}
            {input.pending.length ? (
              <PendingList
                items={input.pending}
                viewMode={viewMode}
                query={query}
                sortKey={sortKey}
                projectId={projectId}
                absPath={absPath}
                openPath={openPath}
                onOpen={onOpen}
                canIngest={canIngest}
                ingestRunning={ingest.running}
                ingestingPath={ingest.job?.path || ''}
                onIngest={(filePath) => void ingest.start(filePath)}
                ignoringPath={ignoringPath}
                onIgnore={(targetPath) => void ignore(targetPath)}
              />
            ) : (
              <EmptyState title="暂无待转换文件" />
            )}
          </TabsContent>

          <TabsContent value="converted">
            <ConvertedList
              items={input.converted}
              hasOutputs={hasOutputs}
              viewMode={viewMode}
              query={query}
              activeFilter={activeFilter}
              sortKey={sortKey}
              projectId={projectId}
              absPath={absPath}
              openPath={openPath}
              onOpen={onOpen}
              canIngest={canIngest}
              ingestRunning={ingest.running}
              ingestingPath={ingest.job?.path || ''}
              onIngest={(filePath) => void ingest.start(filePath)}
            />
          </TabsContent>

          <TabsContent value="assets" className="flex flex-col gap-3">
            {input.assets.length ? (
              <>
                {galleries.length ? (
                  <p className="text-xs text-muted-foreground">
                    每份文档抽出的图算一摞，直接放进 input/raw/ 的图归到「未分类」。点开在右侧看缩略图。
                  </p>
                ) : null}
                {galleries.length ? (
                  <AssetGalleryStack
                    groups={galleries}
                    projectId={projectId}
                    openPath={openPath}
                    onOpen={onOpen}
                  />
                ) : (
                  <AssetGrid items={input.assets} projectId={projectId} />
                )}
              </>
            ) : (
              <EmptyState title="还没有图片资料" hint="转换文档时抽出的图，或直接放进 input/raw/ 的图片，会出现在这里" />
            )}
          </TabsContent>

          {showSources ? (
            <TabsContent value="sources">
              {sources.length ? (
                <DatabaseSourceList
                  sources={sources}
                  openPath={openPath}
                  onOpen={onOpen}
                  canIngest={Boolean(input.canIngestSources)}
                  control={sourceIngest}
                />
              ) : (
                <div className="flex flex-col gap-3">
                  <EmptyState
                    title="还没有数据源"
                    hint="点右上角的数据库图标，填连接信息后复制 prompt 给当前 Agent。"
                  />
                  <div className="flex justify-center">
                    <Button variant="outline" size="sm" onClick={() => setEnvKind('database')}>
                      添加数据库源
                    </Button>
                  </div>
                </div>
              )}
            </TabsContent>
          ) : null}
        </Tabs>
      </section>

      {input.indexPath ? (
        <section className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
          <div className="flex flex-col">
            <span className="text-sm">资料台账 INDEX.md</span>
            <span className="text-xs text-muted-foreground">
              脚本生成的表格 + 人工批注区
              {input.converted[0]?.mtime ? ` · 资料最后入库 ${formatRelative(input.converted[0].mtime)}` : ''}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              onOpen({
                path: input.indexPath,
                name: 'INDEX.md',
                reader: 'markdown',
                size: 0,
                mtime: '',
              })
            }
          >
            打开
          </Button>
        </section>
      ) : null}
      <ApiKeyDialog
        open={envKind === 'api_key'}
        onOpenChange={(next) => {
          if (!next) setEnvKind(null);
        }}
      />
      <DatabaseSourceDialog
        open={envKind === 'database'}
        onOpenChange={(next) => {
          if (!next) setEnvKind(null);
        }}
      />
    </div>
  );
}
