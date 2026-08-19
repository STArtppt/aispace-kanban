import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppWindow, ArrowUpDown, Copy, EyeOff, FileOutput, FileText, FolderOpen, Image, Loader2, Quote, Search, Table } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { AssetGalleryStack } from '@/components/AssetGalleryStack';
import { ImageLightbox } from '@/components/ImageLightbox';
import {
  EmptyState,
  ListPager,
  Row,
  RowActions,
  SectionTitle,
  Stat,
  writeClipboard,
  type RowAction,
} from '@/components/Primitives';
import { DirActions, FileTree, ViewModeToggle, readViewMode, type ViewMode } from '@/components/FileTree';
import { useFileManagerName } from '@/hooks/useFileManager';
import { api, type ConvertedItem, type FileItem, type IngestJob, type Scan } from '@/lib/api';
import { formatBytes, formatRelative, formatWords, markdownLink } from '@/lib/format';
import { cn } from '@/lib/utils';

/** 待转换 / 转换产物列表一页条数 */
const LIST_PAGE_SIZE = 12;
/** 转换任务状态轮询间隔；大 PDF 可能跑几分钟，1.5s 足够且不刷接口 */
const INGEST_POLL_MS = 1500;

function KindIcon({ item }: { item: { reader: string; isDir?: boolean } }) {
  if (item.reader === 'html') return <AppWindow className="size-4 text-muted-foreground" />;
  if (item.isDir || item.reader === 'table') return <Table className="size-4 text-muted-foreground" />;
  if (item.reader === 'image') return <Image className="size-4 text-muted-foreground" />;
  return <FileText className="size-4 text-muted-foreground" />;
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
 * 产物在树里的位置：跟着**原件**在 input/raw/ 下的目录走。
 * input/converted/ 本身是平的（服务端只扫一层），按产物自己的路径建树等于没建；
 * 按原件目录建，树形结构就是自己在 raw/ 里的整理方式。
 * 一份产物都没记来源时（旧 ingest.py 的产物）整棵树平铺，不平白多出一层「未知来源」。
 */
function convertedTreePath(item: ConvertedItem, hasAnySource: boolean): string {
  const prefix = 'input/raw/';
  const source = item.source || '';
  // 来源不在 input/raw/ 下（理论上不该有）一并算「未知来源」：目录行的动作要按
  // input/raw/<树内路径> 反推真实目录，认不回去的就别给动作，免得指到不存在的路径
  if (!source.startsWith(prefix)) return hasAnySource ? `${UNKNOWN_SOURCE}/${item.name}` : item.name;
  const rel = source.slice(prefix.length);
  const cut = rel.lastIndexOf('/');
  return cut > 0 ? `${rel.slice(0, cut)}/${item.name}` : item.name;
}

function ConvertedRow({
  item,
  indent,
  hasOutputs,
  openPath,
  onOpen,
}: {
  item: ConvertedItem;
  /** 树形视图里的层级；列表视图不传 */
  indent?: number;
  hasOutputs: boolean;
  openPath: string;
  onOpen: (item: FileItem) => void;
}) {
  return (
    <Row indent={indent} onClick={() => onOpen(item)} active={openPath === item.path}>
      <KindIcon item={item} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm">{item.title || item.name}</span>
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
        actions={[
          {
            label: '复制路径',
            icon: Copy,
            onSelect: () => {
              void writeClipboard(markdownLink(item.title || item.name, item.path));
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
      <span className="min-w-0 flex-1 truncate text-sm" title={item.path}>
        {label}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(item.size)}</span>
      <RowActions
        busy={thisRowRunning}
        actions={[
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
  projectId,
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
  projectId: string;
  openPath: string;
  onOpen: (item: FileItem) => void;
  canIngest: boolean;
  ingestRunning: boolean;
  ingestingPath: string;
  onIngest: (filePath: string) => void;
  ignoringPath: string;
  onIgnore: (targetPath: string) => void;
}) {
  const { page, setPage } = useListPage(items.length, LIST_PAGE_SIZE, String(items.length));
  const pageItems = items.slice(page * LIST_PAGE_SIZE, (page + 1) * LIST_PAGE_SIZE);
  const fileManager = useFileManagerName();

  const rowProps = {
    projectId,
    fileManager,
    openPath,
    onOpen,
    canIngest,
    ingestRunning,
    ingestingPath,
    onIngest,
    onIgnore,
  };

  // 树形视图不分页：目录折起来就够收敛了，再切页反而找不到东西
  if (viewMode === 'tree') {
    return (
      <FileTree
        items={items}
        treePathOf={pendingLabel}
        keyOf={(item) => item.path}
        renderFile={(item, indent) => (
          <PendingRow
            item={item}
            indent={indent}
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
              extra={extra}
              busy={(ingestRunning && ingestingPath === dirPath) || ignoringPath === dirPath}
            />
          );
        }}
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {pageItems.map((item) => (
        <PendingRow
          key={item.path}
          item={item}
          ignoring={ignoringPath === item.path}
          {...rowProps}
        />
      ))}
      <ListPager page={page} pageSize={LIST_PAGE_SIZE} total={items.length} onPageChange={setPage} />
    </div>
  );
}

const REF_FILTERS = {
  all: '全部',
  unreferenced: '未被引用',
} as const;

type RefFilter = keyof typeof REF_FILTERS;

const SORTS = {
  name: '按名称',
  mtimeAsc: '按时间正序',
  mtimeDesc: '按时间倒序',
} as const;

type SortKey = keyof typeof SORTS;

const CONVERTED_SORT_KEY = 'aispace-kanban:converted-sort';
/** 列表 / 树形是整个「输入资料」视图共用的偏好，待转换和转换产物一起切 */
const INPUT_VIEW_KEY = 'aispace-kanban:input-view';

function readConvertedSort(): SortKey {
  const raw = localStorage.getItem(CONVERTED_SORT_KEY);
  return raw === 'name' || raw === 'mtimeAsc' || raw === 'mtimeDesc' ? raw : 'name';
}

/** 图标选择器：正方形触发器，藏掉默认文案和下拉箭头 */
const ICON_SELECT_TRIGGER =
  'size-8 min-h-8 w-8 justify-center gap-0 px-0 py-0 [&_.lucide-chevron-down]:hidden';

function ConvertedList({
  items,
  hasOutputs,
  viewMode,
  viewToggle,
  projectId,
  openPath,
  onOpen,
}: {
  items: ConvertedItem[];
  hasOutputs: boolean;
  viewMode: ViewMode;
  /** 视图开关只挂在本视图的第一个清单上；不是第一个时不传 */
  viewToggle?: ReactNode;
  projectId: string;
  openPath: string;
  onOpen: (item: FileItem) => void;
}) {
  const fileManager = useFileManagerName();
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [refFilter, setRefFilter] = useState<RefFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>(readConvertedSort);

  useEffect(() => {
    localStorage.setItem(CONVERTED_SORT_KEY, sortKey);
  }, [sortKey]);
  // 没产出、或旧服务没给 referencedBy：筛「未被引用」没意义，控件也不出
  const canFilterUnreferenced = hasOutputs && items.some((item) => Array.isArray(item.referencedBy));
  const activeFilter = canFilterUnreferenced ? refFilter : 'all';
  const filtered = useMemo(() => {
    const list = items.filter((item) => {
      if (activeFilter === 'unreferenced' && item.referencedBy?.length !== 0) return false;
      return matchConverted(item, query);
    });
    return list.sort((a, b) => {
      if (sortKey === 'name') {
        return (a.title || a.name).localeCompare(b.title || b.name, 'zh');
      }
      const cmp = (a.mtime || '').localeCompare(b.mtime || '');
      return sortKey === 'mtimeAsc' ? cmp : -cmp;
    });
  }, [items, query, activeFilter, sortKey]);
  const { page, setPage } = useListPage(
    filtered.length,
    LIST_PAGE_SIZE,
    `${query}\0${activeFilter}\0${sortKey}\0${items.length}`,
  );
  const pageItems = filtered.slice(page * LIST_PAGE_SIZE, (page + 1) * LIST_PAGE_SIZE);
  const searching = query.trim().length > 0;
  const searchExpanded = searchOpen || searching;
  const hasAnySource = useMemo(() => items.some((item) => item.source), [items]);
  const treePathOf = useCallback(
    (item: ConvertedItem) => convertedTreePath(item, hasAnySource),
    [hasAnySource],
  );

  return (
    <div className="flex flex-col gap-2">
      {/* 标题左、排序+筛选+搜索右：同一行，避免再占一整行高度 */}
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0 shrink">
          <SectionTitle count={items.length}>转换产物</SectionTitle>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {viewToggle}
          <Select
            value={sortKey}
            onValueChange={(value) => {
              if (value === 'name' || value === 'mtimeAsc' || value === 'mtimeDesc') {
                setSortKey(value);
              }
            }}
          >
            <SelectTrigger
              className={ICON_SELECT_TRIGGER}
              aria-label="排序转换产物"
              title="排序"
            >
              <ArrowUpDown
                className={cn(
                  'size-3.5',
                  sortKey === 'name' ? 'text-muted-foreground' : 'text-foreground',
                )}
              />
            </SelectTrigger>
            <SelectContent align="end" className="min-w-36 w-max">
              <SelectItem value="name">{SORTS.name}</SelectItem>
              <SelectItem value="mtimeAsc">{SORTS.mtimeAsc}</SelectItem>
              <SelectItem value="mtimeDesc">{SORTS.mtimeDesc}</SelectItem>
            </SelectContent>
          </Select>
          {canFilterUnreferenced ? (
            <Select
              value={refFilter}
              onValueChange={(value) => {
                if (value === 'all' || value === 'unreferenced') setRefFilter(value);
              }}
            >
              <SelectTrigger
                className={ICON_SELECT_TRIGGER}
                aria-label="筛选转换产物"
                title="筛选引用"
              >
                <Quote
                  className={cn(
                    'size-3.5',
                    refFilter === 'all' ? 'text-muted-foreground' : 'text-foreground',
                  )}
                />
              </SelectTrigger>
              <SelectContent align="end" className="min-w-36 w-max">
                <SelectItem value="all">{REF_FILTERS.all}</SelectItem>
                <SelectItem value="unreferenced">{REF_FILTERS.unreferenced}</SelectItem>
              </SelectContent>
            </Select>
          ) : null}
          <div
            className={cn(
              'relative h-8 transition-[width] duration-200 ease-out',
              searchExpanded ? 'w-[12rem] sm:w-[14rem]' : 'w-8',
            )}
          >
            <span className="pointer-events-none absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground">
              <Search className="size-3.5" />
            </span>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => setSearchOpen(false)}
              placeholder={searchExpanded ? '按名称搜索…' : ''}
              className={cn('h-8 text-xs', searchExpanded ? 'pr-8 pl-2.5' : 'px-0 caret-transparent')}
              aria-label="搜索转换产物"
              title="搜索"
            />
          </div>
        </div>
      </div>
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
              />
            )
          }
          renderFile={(item, indent) => (
            <ConvertedRow
              item={item}
              indent={indent}
              hasOutputs={hasOutputs}
              openPath={openPath}
              onOpen={onOpen}
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
              openPath={openPath}
              onOpen={onOpen}
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
      ) : null}
    </div>
  );
}

/**
 * 在看板里触发 scripts/ingest.py。
 * canIngest 缺失（旧服务）时整块不渲染，退回文案里的终端命令提示。
 * 写盘由工作空间脚本完成，看板只负责 spawn + 轮询状态；文件变化走已有 SSE。
 * 状态提到 InputPanel 是为了让待转换列表的单行「转换」和整目录按钮共用同一轮任务。
 */
function useIngestJob(projectId: string, canIngest?: boolean) {
  const [job, setJob] = useState<IngestJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 为 true 时 effect 持续轮询，直到状态离开 running */
  const [polling, setPolling] = useState(false);

  const applyJob = useCallback((next: IngestJob) => {
    setJob(next);
    if (next.status === 'running') setPolling(true);
    else setPolling(false);
    if (next.status === 'error') setError(next.message || '转换失败');
    else if (next.status === 'done') setError('');
  }, []);

  // 切项目：清状态，并查一次是否已有进行中的任务（刷新页面后还能接上）
  useEffect(() => {
    if (!canIngest || !projectId) {
      setJob(null);
      setError('');
      setBusy(false);
      setPolling(false);
      return undefined;
    }
    let cancelled = false;
    void api
      .ingestStatus(projectId)
      .then((status) => {
        if (!cancelled) applyJob(status);
      })
      .catch(() => {
        // 旧服务没有这个接口：静默；点「开始转换」时再报错
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, canIngest, applyJob]);

  useEffect(() => {
    if (!polling || !projectId) return undefined;
    let cancelled = false;
    const timer = setInterval(() => {
      void api
        .ingestStatus(projectId)
        .then((status) => {
          if (!cancelled) applyJob(status);
        })
        .catch((err) => {
          if (!cancelled) {
            setPolling(false);
            setError((err as Error).message);
          }
        });
    }, INGEST_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [polling, projectId, applyJob]);

  const start = useCallback(
    async (filePath?: string) => {
      setBusy(true);
      setError('');
      try {
        const started = await api.startIngest(projectId, filePath);
        applyJob(started);
      } catch (err) {
        setError((err as Error).message);
        setPolling(false);
      } finally {
        setBusy(false);
      }
    },
    [projectId, applyJob],
  );

  return {
    job,
    running: job?.status === 'running' || busy,
    error,
    start,
  };
}

function IngestControls({
  job,
  running,
  error,
  onStart,
}: {
  job: IngestJob | null;
  running: boolean;
  error: string;
  onStart: () => void;
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
      {error ? <p className="whitespace-pre-wrap text-xs text-destructive">{error}</p> : null}
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

export function InputPanel({
  scan,
  projectId,
  openPath,
  onOpen,
}: {
  scan: Scan;
  projectId: string;
  openPath: string;
  onOpen: (item: FileItem) => void;
}) {
  const { input } = scan;
  const hasOutputs = scan.output.stats.total > 0;
  // 旧服务进程没有 canIngest：整块按钮不出现，只保留终端命令提示
  const canIngest = Boolean(input.canIngest);
  const ingest = useIngestJob(projectId, canIngest);
  const [ignoringPath, setIgnoringPath] = useState('');
  const [ignoreError, setIgnoreError] = useState('');
  // 旧服务进程没有 assetGroups：退回平铺网格
  const galleries = input.assetGroups || [];
  const [viewMode, setViewMode] = useState<ViewMode>(() => readViewMode(INPUT_VIEW_KEY));

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
  }, [projectId]);

  useEffect(() => {
    localStorage.setItem(INPUT_VIEW_KEY, viewMode);
  }, [viewMode]);

  // 待转换清单为空时它只剩一个空态，开关就落到下一个清单「转换产物」上
  const viewToggle = <ViewModeToggle mode={viewMode} onChange={setViewMode} label="资料清单" />;

  return (
    <div className="flex flex-col gap-6">
      {/* 固定 3 列 + 固定间距：预览开合时高度稳定 */}
      <div className="grid grid-cols-3 gap-2">
        <Stat
          label="原始资料"
          value={input.stats.raw}
          // 忽略的仍计入总量，否则「资料总共多少份」会跟磁盘上对不上；
          // 但要在 hint 里点明，不然人会奇怪为什么待转换比总量少一大截
          hint={
            input.stats.ignored
              ? `${formatBytes(input.stats.bytes)} · ${input.stats.ignored} 份已忽略`
              : formatBytes(input.stats.bytes)
          }
        />
        <Stat
          label="已转换"
          value={input.stats.converted}
          // 这格宽度只放得下一句，按「要人动手的排前面」取舍（字数概览页也有）：
          // stale 是产物可能已经不对，orphaned 只是溯源断了、产物本身还好好的
          hint={
            input.stats.stale
              ? `${input.stats.stale} 份原件动过`
              : input.stats.orphaned
                ? `${input.stats.orphaned} 份原件已不在`
                : formatWords(input.stats.words)
          }
          tone={input.stats.stale ? 'attention' : 'default'}
        />
        <Stat
          label="待转换"
          value={input.stats.pending}
          hint={
            input.stats.warnings
              ? `${input.stats.pending ? '还没进入可读状态' : '资料都已入库'} · ${input.stats.warnings} 份存疑`
              : input.stats.pending
                ? '还没进入可读状态'
                : '资料都已入库'
          }
          tone={input.stats.pending || input.stats.warnings ? 'attention' : 'default'}
        />
      </div>

      <section className="flex flex-col gap-2">
        {/* 视图开关只挂在本视图的第一个清单上，切一次两个清单一起变 */}
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0 shrink">
            <SectionTitle count={input.pending.length}>待转换的原始资料</SectionTitle>
          </div>
          {input.pending.length ? viewToggle : null}
        </div>
        <p className="text-xs text-muted-foreground">
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
        </p>
        {canIngest ? (
          <IngestControls
            job={ingest.job}
            running={ingest.running}
            error={ingest.error}
            onStart={() => void ingest.start()}
          />
        ) : null}
        {ignoreError ? (
          <p className="whitespace-pre-wrap text-xs text-destructive">{ignoreError}</p>
        ) : null}
        {input.pending.length ? (
          <PendingList
            items={input.pending}
            viewMode={viewMode}
            projectId={projectId}
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
      </section>

      <section className="flex flex-col gap-2">
        {input.converted.length ? (
          <ConvertedList
            items={input.converted}
            hasOutputs={hasOutputs}
            viewMode={viewMode}
            viewToggle={input.pending.length ? undefined : viewToggle}
            projectId={projectId}
            openPath={openPath}
            onOpen={onOpen}
          />
        ) : (
          <>
            <SectionTitle count={0}>转换产物</SectionTitle>
            <EmptyState
              title="还没有转换产物"
              hint={
                canIngest
                  ? '把资料放进 input/raw/，再点「开始转换」'
                  : '把资料放进 input/raw/，然后在工作空间里跑 scripts/ingest.py'
              }
            />
          </>
        )}
      </section>

      {input.assets.length ? (
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <SectionTitle count={input.assets.length}>图片资料</SectionTitle>
            {galleries.length ? (
              <p className="text-xs text-muted-foreground">
                每份文档抽出的图算一摞，直接放进 input/raw/ 的图归到「未分类」。点开在右侧看缩略图。
              </p>
            ) : null}
          </div>
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
        </section>
      ) : null}

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
    </div>
  );
}
