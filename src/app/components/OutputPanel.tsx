import { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpDown,
  FileText,
  MonitorPlay,
  ScrollText,
  Search,
  Stamp,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { CopyButton, EmptyState, Row, SectionTitle, Stat } from '@/components/Primitives';
import type { FileItem, Scan } from '@/lib/api';
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

const SORTS = {
  name: '按名称',
  mtimeAsc: '按时间正序',
  mtimeDesc: '按时间倒序',
} as const;

type SortKey = keyof typeof SORTS;

const OUTPUT_SORT_KEY = 'aispace-kanban:output-sort';

function readOutputSort(): SortKey {
  const raw = localStorage.getItem(OUTPUT_SORT_KEY);
  return raw === 'name' || raw === 'mtimeAsc' || raw === 'mtimeDesc' ? raw : 'name';
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

function OutputGroup({
  title,
  hint,
  dir,
  icon: Icon,
  files,
  sortKey,
  onSortChange,
  openPath,
  onOpen,
}: {
  title: string;
  hint: string;
  dir: string;
  icon: LucideIcon;
  files: FileItem[];
  sortKey: SortKey;
  onSortChange: (key: SortKey) => void;
  openPath: string;
  onOpen: (item: FileItem) => void;
}) {
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const filtered = useMemo(() => {
    const list = files.filter((item) => matchOutput(item, query));
    return list.sort((a, b) => {
      if (sortKey === 'name') {
        return (a.title || a.name).localeCompare(b.title || b.name, 'zh');
      }
      const cmp = (a.mtime || '').localeCompare(b.mtime || '');
      return sortKey === 'mtimeAsc' ? cmp : -cmp;
    });
  }, [files, query, sortKey]);
  const searching = query.trim().length > 0;
  const searchExpanded = searchOpen || searching;

  if (!files.length) {
    return (
      <section className="flex flex-col gap-2">
        <SectionTitle count={0}>{title}</SectionTitle>
        <p className="text-xs text-muted-foreground">{hint}</p>
        <EmptyState title={`output/${dir}/ 还是空的`} />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-2">
      {/* 标题左、排序+搜索右：与输入资料「转换产物」同一行布局 */}
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0 shrink">
          <SectionTitle count={files.length}>{title}</SectionTitle>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Select
            value={sortKey}
            onValueChange={(value) => {
              if (value === 'name' || value === 'mtimeAsc' || value === 'mtimeDesc') {
                onSortChange(value);
              }
            }}
          >
            <SelectTrigger
              className={ICON_SELECT_TRIGGER}
              aria-label={`排序${title}`}
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
              aria-label={`搜索${title}`}
              title="搜索"
            />
          </div>
        </div>
      </div>
      {searching ? (
        <p className="text-xs text-muted-foreground">
          {filtered.length ? `匹配 ${filtered.length} 项` : `没有匹配的${title}`}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
      {filtered.length ? (
        <div className="overflow-hidden rounded-lg border border-border">
          {filtered.map((item) => (
            <Row key={item.path} onClick={() => onOpen(item)} active={openPath === item.path}>
              {isPresentable(item) ? (
                <MonitorPlay className="size-4 text-muted-foreground" />
              ) : (
                <Icon className="size-4 text-muted-foreground" />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm">{item.title || item.name}</span>
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
              <CopyButton value={markdownLink(item.title || item.name, item.path)} />
            </Row>
          ))}
        </div>
      ) : (
        <EmptyState title={`没有匹配的${title}`} hint="试试更短的关键词，或清空搜索" />
      )}
    </section>
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
  // 旧服务进程不返回 annotations，那时候退回只显示字数
  const marks = output.stats.annotations ?? 0;
  const wordsHint = formatWords(output.stats.words);
  const [sortKey, setSortKey] = useState<SortKey>(readOutputSort);

  useEffect(() => {
    localStorage.setItem(OUTPUT_SORT_KEY, sortKey);
  }, [sortKey]);

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

      {GROUPS.map(({ key, title, hint, icon }) => (
        <OutputGroup
          key={key}
          title={title}
          hint={hint}
          dir={key}
          icon={icon}
          files={output[key]}
          sortKey={sortKey}
          onSortChange={setSortKey}
          openPath={openPath}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}
