import { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpDown,
  Copy,
  FileText,
  FolderOpen,
  MonitorPlay,
  ScrollText,
  Search,
  Stamp,
  Star,
  StarOff,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, Row, RowActions, Stat, writeClipboard } from '@/components/Primitives';
import { useFileManagerName } from '@/hooks/useFileManager';
import { useOutputPins } from '@/hooks/useOutputPins';
import { api, type FileItem, type Scan } from '@/lib/api';
import { datePrefix, formatRelative, formatWords, markdownLink } from '@/lib/format';
import { cn } from '@/lib/utils';

const GROUPS = [
  {
    key: 'analysis' as const,
    title: '分析中间产物',
    hint: '现状基线、需求拆解、澄清问题清单',
    icon: ScrollText,
  },
  { key: 'docs' as const, title: '对外交付文档', hint: 'PRD、需求规格、评审材料', icon: FileText },
  { key: 'decisions' as const, title: '决策记录', hint: '一个决策一个文件，只追加不改历史', icon: Stamp },
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

function OutputRow({
  item,
  icon: Icon,
  pinned,
  onTogglePin,
  projectId,
  fileManager,
  openPath,
  onOpen,
}: {
  item: FileItem;
  icon: LucideIcon;
  pinned: boolean;
  onTogglePin: (path: string) => void;
  projectId: string;
  fileManager: string;
  openPath: string;
  onOpen: (item: FileItem) => void;
}) {
  return (
    <Row onClick={() => onOpen(item)} active={openPath === item.path}>
      {isPresentable(item) ? (
        <MonitorPlay className="size-4 text-muted-foreground" />
      ) : (
        <Icon className="size-4 text-muted-foreground" />
      )}
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
  icon,
  files,
  total,
  searching,
  pins,
  onTogglePin,
  projectId,
  fileManager,
  openPath,
  onOpen,
}: {
  title: string;
  hint: string;
  dir: GroupKey;
  icon: LucideIcon;
  /** 已按收藏置顶 + 搜索过滤 + 排序 */
  files: FileItem[];
  /** 过滤前的总数，用来区分「这组本来就空」和「没搜到」 */
  total: number;
  searching: boolean;
  pins: Set<string>;
  onTogglePin: (path: string) => void;
  projectId: string;
  fileManager: string;
  openPath: string;
  onOpen: (item: FileItem) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        {searching ? (files.length ? `匹配 ${files.length} 项` : `没有匹配的${title}`) : hint}
      </p>
      {files.length ? (
        <div className="overflow-hidden rounded-lg border border-border">
          {files.map((item) => (
            <OutputRow
              key={item.path}
              item={item}
              icon={icon}
              pinned={pins.has(item.path)}
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
  // 预览头部也有同一个收藏按钮，两处共用一份状态
  const { pins, togglePin } = useOutputPins(projectId);
  // 旧服务进程不返回 annotations，那时候退回只显示字数
  const marks = output.stats.annotations ?? 0;
  const wordsHint = formatWords(output.stats.words);
  const [sortKey, setSortKey] = useState<SortKey>(readOutputSort);
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
    <div className="flex flex-col gap-6">
      {/* 固定 3 列 + 固定间距：预览开合时高度稳定 */}
      <div className="grid grid-cols-3 gap-2">
        <Stat
          label="产出文件"
          value={output.stats.total}
          hint={marks ? `${wordsHint} · ${marks} 处标注` : wordsHint}
        />
        <Stat label="分析产物" value={output.stats.analysis} />
        <Stat
          label="交付文档"
          value={output.stats.docs}
          hint={
            output.stats.lastUpdated
              ? `更新于 ${formatRelative(output.stats.lastUpdated)}${
                  output.stats.decisions ? ` · ${output.stats.decisions} 条决策` : ''
                }`
              : output.stats.decisions
                ? `${output.stats.decisions} 条决策记录`
                : undefined
          }
        />
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (GROUPS.some((group) => group.key === value)) setTab(value as GroupKey);
        }}
        className="gap-4"
      >
        {/*
          标签条与工具栏共用一条下边框，视觉上是同一行。
          开着预览时看板只有 28rem，搜索框一展开就挤不下三个标签 ——
          让标签条自己横向滚（超出的标签划一下就出来），不换行，行高始终一致。
        */}
        <div className="flex min-w-0 items-center gap-3 border-b border-border">
          <TabsList variant="line" className="min-w-0 flex-1 border-b-0">
            {groups.map(({ key, title, files, total }) => (
              <TabsTrigger key={key} value={key} className="px-2">
                <span className="truncate">{title}</span>
                <span className="shrink-0 text-xs font-normal text-muted-foreground">
                  {searching ? files.length : total}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="flex shrink-0 items-center gap-2 pb-1">
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

        {groups.map(({ key, title, hint, icon, files, total }) => (
          <TabsContent key={key} value={key}>
            <OutputGroup
              title={title}
              hint={hint}
              dir={key}
              icon={icon}
              files={files}
              total={total}
              searching={searching}
              pins={pins}
              onTogglePin={togglePin}
              projectId={projectId}
              fileManager={fileManager}
              openPath={openPath}
              onOpen={onOpen}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
