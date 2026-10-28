import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowUpDown, BookOpen, ChevronDown, ChevronRight, Copy, Database, EyeOff, FileOutput, FolderOpen, Key, ListFilter, Loader2, RefreshCw, Star, StarOff, X } from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
import { KindIcon, LIST_PAGE_SIZE, useListPage } from '@/components/ConvertedList';
import { lastIngestAt, ledgerItem } from '@/hooks/useBoardSession';
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

/**
 * 原始资料区说明的纯文本，给 tooltip 用；可见行是同一套句子，路径还带 code 标记。
 * withState = 服务端给了 raw 的状态（全量列出）；旧服务进程只列待转。
 */
function rawIntroText(pending: number, ignored: number, canIngest: boolean, withState: boolean): string {
  let text = withState
    ? 'input/raw/ 下的全部原件，行尾标签是处理状态：「待转」的 AI 还读不到。'
    : pending
      ? '这些文件还没有对应的转换产物，AI 读不到它们的内容。'
      : '原始资料放进 input/raw/ 后会出现在这里。';
  if (ignored) {
    text += `其中 ${ignored} 份按 input/.ingestignore 忽略，不算待转换。`;
  }
  if (pending) {
    text += '某一行「更多」里可以忽略此文件（或整目录），写进忽略清单，文件还在。';
  }
  text += canIngest
    ? '点「开始转换」会一次处理全部待转的与原件已改的（与筛选无关）；某一行点「转换」只转那一份（大 PDF 可能要几分钟）。'
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

/** 原始资料区搜索：文件名 / 相对 raw/ 的路径 */
function matchPending(item: FileItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [item.name, item.path, pendingLabel(item)].join('\n').toLowerCase();
  return q.split(/\s+/).every((part) => hay.includes(part));
}

/** 原始资料的状态筛选。默认「全部」；「开始转换」的范围不随它变 */
const RAW_FILTERS = {
  all: '全部',
  pending: '待转',
  converted: '已转',
  ignored: '忽略',
  stale: '原件已改',
} as const;

type RawFilter = keyof typeof RAW_FILTERS;

const RAW_FILTER_KEY = 'aispace-kanban:raw-filter';

function isRawFilter(value: string): value is RawFilter {
  return value in RAW_FILTERS;
}

function readRawFilter(): RawFilter {
  try {
    const raw = localStorage.getItem(RAW_FILTER_KEY) || '';
    return isRawFilter(raw) ? raw : 'all';
  } catch {
    return 'all';
  }
}

function matchRawFilter(item: FileItem, filter: RawFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'stale') return Boolean(item.stale);
  return item.state === filter;
}

/** 行内标签。原件已改是唯一要人处理的，走 orange；其余中性灰 */
function RawStateTag({ item }: { item: FileItem }) {
  if (!item.state) return null;
  if (item.stale) {
    return (
      <Badge variant="outline" className="shrink-0 border-destructive/40 text-destructive" title="原件在转换后改过，产物可能已经不对">
        原件已改
      </Badge>
    );
  }
  const label = item.state === 'converted' ? '已转' : item.state === 'ignored' ? '忽略' : '待转';
  return (
    <Badge
      variant="outline"
      className="shrink-0 text-muted-foreground"
      title={
        item.state === 'ignored'
          ? '命中 input/.ingestignore。看板不提供取消忽略：要恢复，在 input/.ingestignore 里删掉对应那一行'
          : undefined
      }
    >
      {label}
    </Badge>
  );
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
  product,
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
  /** 已转的原件对应的那份产物（按产物的 source 反查；目录型 / 图片覆盖的找不到就不给「打开产物」） */
  product?: ConvertedItem;
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
  // 旧服务进程没有 state：列表里只有待转的，动作照改动前给
  const state = item.state ?? 'pending';
  const reveal: RowAction = {
    label: `在${fileManager}中显示`,
    icon: FolderOpen,
    onSelect: () => {
      void api.reveal(projectId, item.path);
    },
  };
  const copies: RowAction[] = [
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
  ];
  const pin: RowAction = {
    label: pinned ? '取消收藏' : '收藏置顶',
    icon: pinned ? StarOff : Star,
    onSelect: () => onTogglePin(item.path),
  };
  // 忽略的只给「在访达中显示」：取消忽略要删 .ingestignore 的行，不在看板的写入例外里
  const actions: RowAction[] =
    state === 'ignored'
      ? [reveal]
      : state === 'converted'
        ? [
            pin,
            ...(product
              ? [{ label: '打开产物', icon: FileOutput, onSelect: () => onOpen(product) }]
              : []),
            // 没改过的重跑一遍 ingest.py 也是「未变化」跳过，所以只在原件已改时给
            ...(canIngest && item.stale
              ? [
                  {
                    label: '重新转换',
                    icon: RefreshCw,
                    disabled: ingestRunning,
                    onSelect: () => onIngest(item.path),
                  },
                ]
              : []),
            ...copies,
            reveal,
          ]
        : [
            pin,
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
            ...copies,
            reveal,
          ];
  return (
    <Row indent={indent} onClick={() => onOpen(item)} active={openPath === item.path}>
      <KindIcon item={item} />
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className={cn('min-w-0 truncate text-sm', state === 'ignored' && 'text-muted-foreground')}
          title={item.path}
        >
          {label}
        </span>
        <RawStateTag item={item} />
        {pinned ? (
          <Star className="size-3.5 shrink-0 fill-current text-muted-foreground" />
        ) : null}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(item.size)}</span>
      <RowActions busy={thisRowRunning} actions={actions} />
    </Row>
  );
}

/**
 * 「原始资料」顶部固定的「资料台账」行：不参与搜索、筛选，不随分页移动。
 * 点开是台账预览（精简概览 + INDEX.md 正文）。
 */
function LedgerRow({ scan, openPath, onOpen }: { scan: Scan; openPath: string; onOpen: (item: FileItem) => void }) {
  const item = ledgerItem(scan);
  const last = lastIngestAt(scan);
  const hint = scan.input.indexPath
    ? `INDEX.md${last ? ` · 资料最后入库 ${formatRelative(last)}` : ''}`
    : '项目概览';
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Row onClick={() => onOpen(item)} active={openPath === item.path}>
        <BookOpen className="size-4 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm">资料台账</span>
          <span className="truncate text-xs text-muted-foreground">{hint}</span>
        </span>
      </Row>
    </div>
  );
}

function PendingList({
  items,
  converted,
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
  /** 转换产物，给已转的原件反查「打开产物」 */
  converted: ConvertedItem[];
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
  const productBySource = useMemo(() => {
    const map = new Map<string, ConvertedItem>();
    for (const item of converted) if (item.source && !map.has(item.source)) map.set(item.source, item);
    return map;
  }, [converted]);
  const ordered = useMemo(() => {
    const list = items.filter((item) => matchPending(item, query));
    return list.sort((a, b) => {
      const pin = Number(pins.has(b.path)) - Number(pins.has(a.path));
      if (pin) return pin;
      if (sortKey === 'name') {
        return pendingLabel(a).localeCompare(pendingLabel(b), 'zh', { numeric: true });
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
              product={productBySource.get(item.path)}
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
            product={productBySource.get(item.path)}
            {...rowProps}
          />
        ))}
        <ListPager page={page} pageSize={LIST_PAGE_SIZE} total={ordered.length} onPageChange={setPage} />
      </div>
    </div>
  );
}

const SORTS = {
  name: '按名称',
  mtimeAsc: '按时间正序',
  mtimeDesc: '按时间倒序',
} as const;

type SortKey = keyof typeof SORTS;

/** 键名沿用转换产物还在这里时的那个，已存的排序偏好不丢 */
const INPUT_SORT_KEY = 'aispace-kanban:converted-sort';
/** 列表 / 树形是整个「输入资料」视图共用的偏好 */
const INPUT_VIEW_KEY = 'aispace-kanban:input-view';
/**
 * 当前停在哪一类资料。转换产物已挪到「产出文档」：记着的是 `converted` 时认不出来，
 * 退回「原始资料」（台账也在那里）。
 */
const INPUT_TAB_KEY = 'aispace-kanban:input-tab';

const INPUT_TABS = [
  { key: 'pending' as const, title: '原始资料' },
  { key: 'assets' as const, title: '图片资料' },
  // 数据库源排在已有 tab **之后**，有 input/sources/ 目录才出现（见 showSources）
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

function readInputSort(): SortKey {
  const raw = localStorage.getItem(INPUT_SORT_KEY);
  return raw === 'name' || raw === 'mtimeAsc' || raw === 'mtimeDesc' ? raw : 'name';
}

function readInputTab(): InputTab {
  const raw = localStorage.getItem(INPUT_TAB_KEY) || '';
  return isInputTab(raw) ? raw : 'pending';
}

/** 图标选择器：正方形触发器，藏掉默认文案和下拉箭头 */
const ICON_SELECT_TRIGGER =
  'size-8 min-h-8 w-8 justify-center gap-0 px-0 py-0 [&_.lucide-chevron-down]:hidden';
/** 标题栏描边方钮：与排序 / 筛选 SelectTrigger、搜索框同一套 size-8 + shadow-sm */
const TOOLBAR_ICON_BUTTON = 'size-8 shadow-sm';

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
  const [rawFilter, setRawFilter] = useState<RawFilter>(readRawFilter);
  const [sortKey, setSortKey] = useState<SortKey>(readInputSort);
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
  }, [projectId]);

  useEffect(() => {
    localStorage.setItem(INPUT_VIEW_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem(INPUT_TAB_KEY, tab);
  }, [tab]);

  useEffect(() => {
    localStorage.setItem(INPUT_SORT_KEY, sortKey);
  }, [sortKey]);

  useEffect(() => {
    try {
      localStorage.setItem(RAW_FILTER_KEY, rawFilter);
    } catch {
      // 存不下就只在本次生效
    }
  }, [rawFilter]);

  /**
   * 服务端给了状态才全量列出（转换过的、忽略的都不再消失）；
   * 旧服务进程没有 state：退回只列待转、不出筛选（改动前的行为）。
   */
  // 原始资料为 0 时看不出条目上有没有 state：同一批新字段里的 layout 在，就当是新服务
  const withState = input.raw.some((item) => item.state) || Boolean(input.layout);
  const rawCounts: Record<RawFilter, number> = {
    all: input.raw.length,
    pending: input.raw.filter((item) => item.state === 'pending').length,
    converted: input.raw.filter((item) => item.state === 'converted').length,
    ignored: input.raw.filter((item) => item.state === 'ignored').length,
    stale: input.raw.filter((item) => item.stale).length,
  };
  const activeRawFilter: RawFilter = withState ? rawFilter : 'all';
  const rawItems = withState
    ? input.raw.filter((item) => matchRawFilter(item, activeRawFilter))
    : input.pending;
  const tabCounts: Record<InputTab, number> = {
    pending: withState ? input.raw.length : input.pending.length,
    assets: input.assets.length,
    sources: sources.length,
  };
  const visibleTabs = INPUT_TABS.filter((item) => item.key !== 'sources' || showSources);
  /**
   * localStorage 里记着的可能是「数据库源」，而这个工作空间根本没有数据源
   * （换了工作空间、或者源配置被删了）—— 那时退回默认 tab，不能渲染一个不存在的 tab。
   * 只改这里显示用的值，不动记着的偏好：源再配回来时还停在数据库源上。
   */
  const activeTab: InputTab = tab === 'sources' && !showSources ? 'pending' : tab;

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
              {activeTab === 'pending' && withState ? (
                <Select
                  value={activeRawFilter}
                  onValueChange={(value) => {
                    if (typeof value === 'string' && isRawFilter(value)) setRawFilter(value);
                  }}
                >
                  <HeaderTooltip label="按状态筛选">
                    <SelectTrigger className={ICON_SELECT_TRIGGER} aria-label="按状态筛选原始资料">
                      <ListFilter
                        className={cn(
                          'size-3.5',
                          activeRawFilter === 'all' ? 'text-muted-foreground' : 'text-foreground',
                        )}
                      />
                    </SelectTrigger>
                  </HeaderTooltip>
                  <SelectContent align="end" className="min-w-36 w-max">
                    {(Object.keys(RAW_FILTERS) as RawFilter[]).map((option) => (
                      <SelectItem key={option} value={option}>
                        {RAW_FILTERS[option]}
                        <span className="ml-2 text-xs text-muted-foreground">{rawCounts[option]}</span>
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
            <TruncatedHint
              text={rawIntroText(input.pending.length, input.stats.ignored || 0, canIngest, withState)}
            >
              {withState
                ? 'input/raw/ 下的全部原件，行尾标签是处理状态：「待转」的 AI 还读不到。'
                : input.pending.length
                  ? '这些文件还没有对应的转换产物，AI 读不到它们的内容。'
                  : '原始资料放进 input/raw/ 后会出现在这里。'}
              {input.stats.ignored ? (
                <>
                  其中 {input.stats.ignored} 份按
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
                '点「开始转换」会一次处理全部待转的与原件已改的（与筛选无关）；某一行点「转换」只转那一份（大 PDF 可能要几分钟）。'
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
            <LedgerRow scan={scan} openPath={openPath} onOpen={onOpen} />
            {rawItems.length ? (
              <PendingList
                items={rawItems}
                converted={input.converted}
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
            ) : query.trim() ? (
              <EmptyState title="没有匹配的原始资料" hint="试试更短的关键词，或清空搜索" />
            ) : activeRawFilter !== 'all' ? (
              <EmptyState title={`没有「${RAW_FILTERS[activeRawFilter]}」的原始资料`} hint="右上角筛选切回「全部」" />
            ) : (
              <EmptyState title={withState ? '还没有原始资料' : '暂无待转换文件'} />
            )}
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
