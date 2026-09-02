import { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpDown,
  Copy,
  FileText,
  FolderOpen,
  Image,
  MonitorPlay,
  Search,
  Star,
  StarOff,
  Table,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, PanelTitle, Row, RowActions, TruncatedHint, writeClipboard } from '@/components/Primitives';
import { DirActions, FileTree, ViewModeToggle, readViewMode, type ViewMode } from '@/components/FileTree';
import { useFileManagerName, usePathSeparator } from '@/hooks/useFileManager';
import { usePins } from '@/hooks/usePins';
import { api, type FileItem, type Scan } from '@/lib/api';
import { absolutePath, datePrefix, formatRelative, markdownLink } from '@/lib/format';
import { cn } from '@/lib/utils';

const GROUPS = [
  {
    key: 'analysis' as const,
    title: '分析中间产物',
    // 三栏是流水线位置，不是岗位：调研笔记、口径、大纲和需求拆解都算「想清楚」
    hint: '给自己和 AI 看的中间产物，还不对外发。摸底、拆解、待确认问题、口径、大纲都放这里。',
  },
  {
    key: 'docs' as const,
    title: '对外交付文档',
    hint: '交出去的成稿。报告、方案、PRD、稿件、演示材料都放这里。',
  },
  {
    key: 'decisions' as const,
    title: '决策记录',
    hint: '一事一档，只追加不改历史。选型、口径、范围取舍都记在这里，以后能追问为什么。',
  },
];

type GroupKey = (typeof GROUPS)[number]['key'];

const SORTS = {
  name: '按名称',
  mtimeAsc: '按时间正序',
  mtimeDesc: '按时间倒序',
} as const;

type SortKey = keyof typeof SORTS;

const OUTPUT_SORT_KEY = 'aispace-kanban:output-sort';
/** 当前停在哪一组：产出多了以后不想每次进来都从头翻 */
const OUTPUT_TAB_KEY = 'aispace-kanban:output-tab';
/** 列表 / 树形是整个「产出文档」视图共用的偏好，三组一起切 */
const OUTPUT_VIEW_KEY = 'aispace-kanban:output-view';

function readOutputSort(): SortKey {
  const raw = localStorage.getItem(OUTPUT_SORT_KEY);
  return raw === 'name' || raw === 'mtimeAsc' || raw === 'mtimeDesc' ? raw : 'name';
}

function readOutputTab(): GroupKey | null {
  const raw = localStorage.getItem(OUTPUT_TAB_KEY);
  return GROUPS.some((group) => group.key === raw) ? (raw as GroupKey) : null;
}

/** 图标选择器：正方形触发器，藏掉默认文案和下拉箭头 */
const ICON_SELECT_TRIGGER =
  'size-8 min-h-8 w-8 justify-center gap-0 px-0 py-0 [&_.lucide-chevron-down]:hidden';

/** 名称模糊：空格分词，每段都要在标题/文件名/路径里出现（大小写不敏感） */
function matchOutput(item: FileItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [item.title, item.name, item.path].filter(Boolean).join('\n').toLowerCase();
  return q.split(/\s+/).every((part) => hay.includes(part));
}

function KindIcon({ item }: { item: { reader: string; ext?: string } }) {
  if (item.reader === 'html') return <MonitorPlay className="size-4 text-muted-foreground" />;
  if (
    item.reader === 'table' ||
    item.ext === '.xlsx' ||
    item.ext === '.xls' ||
    item.ext === '.csv' ||
    item.ext === '.tsv'
  ) {
    return <Table className="size-4 text-muted-foreground" />;
  }
  if (item.reader === 'image') return <Image className="size-4 text-muted-foreground" />;
  return <FileText className="size-4 text-muted-foreground" />;
}

/**
 * 汇报 / 演示用的 HTML 产出：能在预览里直接全屏放给客户看，
 * 和同名的 .md 源文并排躺在 output/docs/。列表里认得出来才不会临上场翻半天。
 */
function isPresentable(item: FileItem): boolean {
  return item.reader === 'html';
}

/**
 * 这份产出里有多少内容还没有资料支撑。
 * 中性灰而不是 orange —— 标注是 AI 老实交代的产出，不是要人去修的缺口；
 * 标红只会让人学会把标注写少，正好跟溯源纪律反着来。
 */
function annotationLabel(item: FileItem): string {
  const marks = item.annotations;
  if (!marks?.total) return '';
  const parts: string[] = [];
  if (marks.inferred) parts.push(`${marks.inferred} 处推断`);
  if (marks.verbal) parts.push(`${marks.verbal} 处待确认`);
  if (marks.blank) parts.push(`${marks.blank} 处空白`);
  return ` · ${parts.join('、')}`;
}

/** 产出在树里的位置：剥掉 output/<组>/，剩下的目录结构就是整理方式 */
function outputTreePath(item: FileItem, dir: GroupKey): string {
  const prefix = `output/${dir}/`;
  return item.path.startsWith(prefix) ? item.path.slice(prefix.length) : item.name;
}

function OutputRow({
  item,
  indent,
  pinned,
  absPath,
  onTogglePin,
  projectId,
  fileManager,
  openPath,
  onOpen,
}: {
  item: FileItem;
  /** 树形视图里的层级；列表视图不传 */
  indent?: number;
  pinned: boolean;
  /** 拼好的取绝对路径函数，「复制绝对路径」用 */
  absPath: (relPath: string) => string;
  onTogglePin: (path: string) => void;
  projectId: string;
  fileManager: string;
  openPath: string;
  onOpen: (item: FileItem) => void;
}) {
  return (
    <Row indent={indent} onClick={() => onOpen(item)} active={openPath === item.path}>
      <KindIcon item={item} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm">{item.title || item.name}</span>
          {pinned ? (
            <Star className="size-3.5 shrink-0 fill-current text-muted-foreground" />
          ) : null}
          {isPresentable(item) ? (
            <Badge variant="muted" className="shrink-0 text-[10px]">
              可演示
            </Badge>
          ) : null}
        </span>
        {/* 文档自身的相对路径，方便直接喂给 AI / 命令行 */}
        <span className="truncate text-xs text-muted-foreground" title={item.path}>
          {item.path}
          {datePrefix(item.name) ? '' : ` · ${formatRelative(item.mtime)}`}
          {annotationLabel(item)}
        </span>
      </div>
      <RowActions
        actions={[
          {
            label: pinned ? '取消收藏' : '收藏置顶',
            icon: pinned ? StarOff : Star,
            onSelect: () => onTogglePin(item.path),
          },
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

function OutputGroup({
  title,
  hint,
  dir,
  files,
  total,
  searching,
  viewMode,
  pins,
  absPath,
  onTogglePin,
  projectId,
  fileManager,
  openPath,
  onOpen,
}: {
  title: string;
  hint: string;
  dir: GroupKey;
  /** 已按收藏置顶 + 搜索过滤 + 排序 */
  files: FileItem[];
  /** 过滤前的总数，用来区分「这组本来就空」和「没搜到」 */
  total: number;
  searching: boolean;
  viewMode: ViewMode;
  pins: Set<string>;
  /** 拼好的取绝对路径函数，「复制绝对路径」用 */
  absPath: (relPath: string) => string;
  onTogglePin: (path: string) => void;
  projectId: string;
  fileManager: string;
  openPath: string;
  onOpen: (item: FileItem) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <TruncatedHint
        text={searching ? (files.length ? `匹配 ${files.length} 项` : `没有匹配的${title}`) : hint}
      />
      {files.length && viewMode === 'tree' ? (
        <FileTree
          items={files}
          treePathOf={(item) => outputTreePath(item, dir)}
          keyOf={(item) => item.path}
          expandAll={searching}
          renderDirActions={(dirKey) => (
            <DirActions
              projectId={projectId}
              fileManager={fileManager}
              dirPath={`output/${dir}/${dirKey}`}
              absPath={absPath}
            />
          )}
          renderFile={(item, indent) => (
            <OutputRow
              item={item}
              indent={indent}
              pinned={pins.has(item.path)}
              absPath={absPath}
              onTogglePin={onTogglePin}
              projectId={projectId}
              fileManager={fileManager}
              openPath={openPath}
              onOpen={onOpen}
            />
          )}
        />
      ) : files.length ? (
        <div className="overflow-hidden rounded-lg border border-border">
          {files.map((item) => (
            <OutputRow
              key={item.path}
              item={item}
              pinned={pins.has(item.path)}
              absPath={absPath}
              onTogglePin={onTogglePin}
              projectId={projectId}
              fileManager={fileManager}
              openPath={openPath}
              onOpen={onOpen}
            />
          ))}
        </div>
      ) : total ? (
        <EmptyState title={`没有匹配的${title}`} hint="试试更短的关键词，或清空搜索" />
      ) : (
        <EmptyState title={`output/${dir}/ 还是空的`} />
      )}
    </div>
  );
}

export function OutputPanel({
  scan,
  openPath,
  onOpen,
}: {
  scan: Scan;
  openPath: string;
  onOpen: (item: FileItem) => void;
}) {
  const { output } = scan;
  const projectId = scan.project.id;
  const fileManager = useFileManagerName();
  // 「复制绝对路径」要工作空间在磁盘上的位置，scan.project.root 里带着；拿不到时 absolutePath 自己退回相对路径
  const sep = usePathSeparator();
  const absPath = useMemo(
    () => (relPath: string) => absolutePath(scan.project.root, relPath, sep),
    [scan.project.root, sep],
  );
  // 预览头部也有同一个收藏按钮，两处共用一份状态
  const { pins, togglePin } = usePins(projectId);
  const [sortKey, setSortKey] = useState<SortKey>(readOutputSort);
  const [viewMode, setViewMode] = useState<ViewMode>(() => readViewMode(OUTPUT_VIEW_KEY));
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  // 没存过偏好时停在第一组有东西的，省得一进来就看空态
  const [tab, setTab] = useState<GroupKey>(
    () => readOutputTab() || GROUPS.find(({ key }) => output[key].length)?.key || 'analysis',
  );

  useEffect(() => {
    localStorage.setItem(OUTPUT_SORT_KEY, sortKey);
  }, [sortKey]);

  useEffect(() => {
    localStorage.setItem(OUTPUT_TAB_KEY, tab);
  }, [tab]);

  useEffect(() => {
    localStorage.setItem(OUTPUT_VIEW_KEY, viewMode);
  }, [viewMode]);

  // 三组一起算：搜索时每个标签上挂的是「这组有几条命中」，
  // 才知道要找的东西是不是躺在另一个标签里。
  const groups = useMemo(
    () =>
      GROUPS.map((group) => {
        const all = output[group.key];
        const files = all.filter((item) => matchOutput(item, query)).sort((a, b) => {
          // 收藏的一律在前，排序方式只在组内生效
          const pin = Number(pins.has(b.path)) - Number(pins.has(a.path));
          if (pin) return pin;
          if (sortKey === 'name') {
            return (a.title || a.name).localeCompare(b.title || b.name, 'zh');
          }
          const cmp = (a.mtime || '').localeCompare(b.mtime || '');
          return sortKey === 'mtimeAsc' ? cmp : -cmp;
        });
        return { ...group, files, total: all.length };
      }),
    [output, query, sortKey, pins],
  );

  const searching = query.trim().length > 0;
  const searchExpanded = searchOpen || searching;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section className="flex min-w-0 flex-col gap-2">
        <div className="flex min-h-8 min-w-0 items-center justify-between gap-3">
          <div className="min-w-0 shrink">
            <PanelTitle>产出列表</PanelTitle>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ViewModeToggle mode={viewMode} onChange={setViewMode} label="产出清单" />
            <Select
              value={sortKey}
              onValueChange={(value) => {
                if (value === 'name' || value === 'mtimeAsc' || value === 'mtimeDesc') {
                  setSortKey(value);
                }
              }}
            >
              <SelectTrigger className={ICON_SELECT_TRIGGER} aria-label="排序产出文档" title="排序">
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
            <div
              className={cn(
                'relative h-8 transition-[width] duration-200 ease-out',
                searchExpanded ? 'w-[10rem] sm:w-[12rem]' : 'w-8',
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
                aria-label="搜索产出文档"
                title="搜索"
              />
            </div>
          </div>
        </div>

        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (GROUPS.some((group) => group.key === value)) setTab(value as GroupKey);
          }}
          className="gap-4"
        >
          <TabsList variant="line">
            {groups.map(({ key, title, files, total }) => (
              <TabsTrigger key={key} value={key} className="px-2">
                <span className="truncate">{title}</span>
                <span className="shrink-0 text-xs font-normal text-muted-foreground">
                  {searching ? files.length : total}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>

          {groups.map(({ key, title, hint, files, total }) => (
            <TabsContent key={key} value={key}>
              <OutputGroup
                title={title}
                hint={hint}
                dir={key}
                files={files}
                total={total}
                searching={searching}
                viewMode={viewMode}
                pins={pins}
                absPath={absPath}
                onTogglePin={togglePin}
                projectId={projectId}
                fileManager={fileManager}
                openPath={openPath}
                onOpen={onOpen}
              />
            </TabsContent>
          ))}
        </Tabs>
      </section>
    </div>
  );
}
