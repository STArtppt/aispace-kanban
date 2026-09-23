import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArrowUpDown,
  ChevronRight,
  CodeXml,
  Copy,
  FileText,
  FolderOpen,
  Image,
  MonitorPlay,
  Star,
  StarOff,
  Table,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBackdrop,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/dialog';
import { ExpandableSearch } from '@/components/ExpandableSearch';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, HeaderTooltip, PanelTitle, Row, RowActions, TruncatedHint, writeClipboard } from '@/components/Primitives';
import { DirActions, FileTree, ViewModeToggle, readViewMode, type ViewMode } from '@/components/FileTree';
import { codePreviewLanguage } from '@/components/CodeFileView';
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

function KindIcon({ item }: { item: { reader: string; ext?: string; path?: string } }) {
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
  if (codePreviewLanguage(item.ext || item.path || '')) {
    return <CodeXml className="size-4 text-muted-foreground" />;
  }
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

/**
 * 「归档」为什么不能点；能点时返回空串。
 * 判据全用服务端下发的字段（archived / nested / canArchive），前端不从 path 里自己找「一次归档」。
 */
function archiveBlockedReason(item: FileItem, canArchive: boolean | undefined): string {
  if (item.archived) return '已经在归档区里了';
  if (item.nested) return '本轮只能归档组根目录下的文件；子目录里的要挪，请在终端里自己移';
  // 旧服务进程没有 canArchive：不置灰，点了会撞 404「未知接口」，提示重启服务
  if (canArchive === false) {
    return '这个工作空间没有 scripts/archive_output.py。用模板新建的工作空间自带；自己建的目录需要自己装脚本';
  }
  return '';
}

/**
 * 已归档区按堆排：交接单 README 最前，然后是二次归档分出来的各堆（每堆的 INDEX.md 排第一），
 * 最后是还平铺在归档根上、没分堆的。堆和角色都是服务端算好的，这里只排序。
 */
function archiveSections(files: FileItem[]): { pile: string; items: FileItem[] }[] {
  const piles = new Map<string, FileItem[]>();
  const loose: FileItem[] = [];
  const handoff: FileItem[] = [];
  for (const item of files) {
    if (item.archiveRole === 'handoff') handoff.push(item);
    else if (item.archivePile) {
      if (!piles.has(item.archivePile)) piles.set(item.archivePile, []);
      piles.get(item.archivePile)!.push(item);
    } else loose.push(item);
  }
  const sections = [...piles.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'zh'))
    .map(([pile, items]) => ({
      pile,
      // 稳定排序：堆索引提到最前，其余保持外面给的顺序（收藏 / 排序方式照旧生效）
      items: [...items].sort((a, b) => Number(b.archiveRole === 'index') - Number(a.archiveRole === 'index')),
    }));
  const flat = [...handoff, ...loose];
  return flat.length ? [{ pile: '', items: flat }, ...sections] : sections;
}

const ARCHIVE_ROLE_LABEL = { handoff: '交接单', index: '堆索引' } as const;

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
  archiveBlocked,
  onArchive,
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
  /** 「归档」不能点的理由；空串 = 可以归档 */
  archiveBlocked: string;
  onArchive: (item: FileItem) => void;
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
          {/* 中性灰，不用 orange：归档是正常流转，不是需要注意的缺口 */}
          {item.archiveRole ? (
            <Badge variant="muted" className="shrink-0 text-[10px]">
              {ARCHIVE_ROLE_LABEL[item.archiveRole]}
            </Badge>
          ) : item.archived ? (
            <Badge variant="muted" className="shrink-0 text-[10px]">
              已归档
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
          {
            label: '归档',
            icon: Archive,
            disabled: Boolean(archiveBlocked),
            hint: archiveBlocked || undefined,
            onSelect: () => onArchive(item),
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
  archivedFiles,
  archivedTotal,
  canArchive,
  onArchive,
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
  /** 已归档的，同样按搜索过滤 + 排序；从主列表分出来单独一块 */
  archivedFiles: FileItem[];
  /** 已归档份数（不含交接单与堆索引），与主列表数一起显示 */
  archivedTotal: number;
  canArchive: boolean | undefined;
  onArchive: (item: FileItem) => void;
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
  const [showArchived, setShowArchived] = useState(false);
  const rowProps = (item: FileItem) => ({
    item,
    pinned: pins.has(item.path),
    absPath,
    onTogglePin,
    projectId,
    fileManager,
    openPath,
    onOpen,
    archiveBlocked: archiveBlockedReason(item, canArchive),
    onArchive,
  });
  // 搜索时自动展开：归档项要能被搜到，藏在折叠里等于没搜到
  const archivedOpen = showArchived || (searching && archivedFiles.length > 0);
  const hasArchive = archivedTotal > 0 || archivedFiles.length > 0;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <TruncatedHint
        text={
          searching
            ? files.length
              ? `匹配 ${files.length} 项`
              : archivedFiles.length
                ? '主列表里没有匹配的，命中都在已归档里'
                : `没有匹配的${title}`
            : hint
        }
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
          renderFile={(item, indent) => <OutputRow {...rowProps(item)} indent={indent} />}
        />
      ) : files.length ? (
        <div className="overflow-hidden rounded-lg border border-border">
          {files.map((item) => (
            <OutputRow key={item.path} {...rowProps(item)} />
          ))}
        </div>
      ) : searching && archivedFiles.length ? null : total ? (
        <EmptyState title={`没有匹配的${title}`} hint="试试更短的关键词，或清空搜索" />
      ) : hasArchive ? (
        searching ? null : <EmptyState title="主列表是空的" hint={`${archivedTotal} 份在下面的已归档里`} />
      ) : (
        <EmptyState title={`output/${dir}/ 还是空的`} />
      )}

      {/* 已归档分区：从主列表分出来，但不藏 —— 标题行一直在，一眼看得出少掉的那些去哪了 */}
      {hasArchive ? (
        <div className="mt-2 flex min-w-0 flex-col gap-2">
          <button
            type="button"
            onClick={() => setShowArchived((open) => !open)}
            aria-expanded={archivedOpen}
            className="flex min-w-0 items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', archivedOpen && 'rotate-90')} />
            <Archive className="size-3.5 shrink-0" />
            <span className="shrink-0">
              已归档 {searching ? `· 匹配 ${archivedFiles.filter((f) => !f.archiveRole).length}` : archivedTotal}
            </span>
            <span className="truncate">· output/{dir}/一次归档/，仍可搜索和预览</span>
          </button>
          {archivedOpen && archivedFiles.length ? (
            <div className="overflow-hidden rounded-lg border border-border">
              {archiveSections(archivedFiles).map(({ pile, items }) => (
                <div key={pile || '(平铺)'}>
                  {pile ? (
                    <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                      堆 · {pile}
                    </div>
                  ) : null}
                  {items.map((item) => (
                    <OutputRow key={item.path} {...rowProps(item)} indent={pile ? 1 : undefined} />
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
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
  const [archiving, setArchiving] = useState<{ item: FileItem; group: GroupKey } | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState('');
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
  // 没存过偏好时停在第一组有东西的，省得一进来就看空态
  const [tab, setTab] = useState<GroupKey>(
    () => readOutputTab() || GROUPS.find(({ key }) => output[key].some((f) => !f.archived))?.key || 'analysis',
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
        // 旧服务进程不给 archived：全部落在主列表里，等于功能没启用
        const all = output[group.key].filter((item) => !item.archived);
        const archivedAll = output[group.key].filter((item) => item.archived);
        const order = (a: FileItem, b: FileItem) => {
          // 收藏的一律在前，排序方式只在组内生效
          const pin = Number(pins.has(b.path)) - Number(pins.has(a.path));
          if (pin) return pin;
          if (sortKey === 'name') {
            return (a.title || a.name).localeCompare(b.title || b.name, 'zh');
          }
          const cmp = (a.mtime || '').localeCompare(b.mtime || '');
          return sortKey === 'mtimeAsc' ? cmp : -cmp;
        };
        const files = all.filter((item) => matchOutput(item, query)).sort(order);
        const archivedFiles = archivedAll.filter((item) => matchOutput(item, query)).sort(order);
        return {
          ...group,
          files,
          total: all.length,
          archivedFiles,
          archivedTotal: output.stats.archived?.[group.key] ?? 0,
        };
      }),
    [output, query, sortKey, pins],
  );

  const searching = query.trim().length > 0;

  const confirmArchive = async () => {
    if (!archiving) return;
    const { item, group } = archiving;
    setArchiveBusy(true);
    setArchiveError('');
    try {
      // 只带组名与文件名，不带路径：服务端对带路径的一律 400
      const result = await api.archiveOutput(projectId, { group, name: item.name });
      setArchiving(null);
      toast.success(`已归档到 ${result.to || `output/${group}/一次归档/`}`, {
        description: result.records.length
          ? `记录 ${result.records.join('、')} 的 target 还指着旧路径，工作台会标「指向丢失」，让 agent 跟进（pm-output-record）`
          : undefined,
      });
      // 正开着的就是这份：跟到新位置，免得预览停在一个已经不在的路径上
      if (openPath === item.path && result.to) {
        onOpen({ ...item, path: result.to, name: result.to.split('/').pop() || item.name, archived: true });
      }
      // 列表不用手动刷新：脚本写盘会被工作空间监听捕获，SSE 推一轮新扫描
    } catch (err) {
      // 照原文显示（脚本的中文说明 / 400 / 403 / 旧进程 404 的「重启 serve」），这一行留在主列表里
      setArchiveError(err instanceof Error ? err.message : String(err));
    } finally {
      setArchiveBusy(false);
    }
  };

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
              <HeaderTooltip label="排序">
                <SelectTrigger className={ICON_SELECT_TRIGGER} aria-label="排序产出文档">
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
            <ExpandableSearch
              key={projectId}
              value={query}
              onChange={setQuery}
              expandedClassName="w-[10rem] sm:w-[12rem]"
              aria-label="搜索产出文档"
            />
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
            {groups.map(({ key, title, files, total, archivedFiles, archivedTotal }) => (
              <TabsTrigger key={key} value={key} className="px-2">
                <span className="truncate">{title}</span>
                {/* 主列表数与已归档数一起报：只报主列表，总数突然变小看起来像文件没了 */}
                <span className="shrink-0 text-xs font-normal text-muted-foreground">
                  {searching
                    ? files.length + archivedFiles.filter((f) => !f.archiveRole).length
                    : archivedTotal
                      ? `${total} · 归档 ${archivedTotal}`
                      : total}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>

          {groups.map(({ key, title, hint, files, total, archivedFiles, archivedTotal }) => (
            <TabsContent key={key} value={key}>
              <OutputGroup
                title={title}
                hint={hint}
                dir={key}
                files={files}
                total={total}
                archivedFiles={archivedFiles}
                archivedTotal={archivedTotal}
                canArchive={output.canArchive}
                onArchive={(item) => {
                  setArchiveError('');
                  setArchiving({ item, group: key });
                }}
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

      <Dialog
        open={Boolean(archiving)}
        onOpenChange={(open) => {
          if (!open && !archiveBusy) setArchiving(null);
        }}
      >
        <DialogPortal>
          <DialogBackdrop />
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>归档「{archiving?.item.title || archiving?.item.name}」？</DialogTitle>
              <DialogDescription>
                它会移到 output/{archiving?.group}/一次归档/，不再占主列表的位置。
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-2 text-sm">
              <p>
                <strong>文件不会被删除</strong>，归档后仍然可以搜到和预览，AI 需要时照样能读。
                内容一个字节不变，产出物记录的状态也不变。
              </p>
              <p className="text-xs text-muted-foreground">
                同目录的 README.md 交接单会追加一行原路径与新路径；攒多了可以把里面的提示词粘给 agent 做二次归档。
              </p>
              {archiveError ? <p className="whitespace-pre-wrap text-xs text-destructive">{archiveError}</p> : null}
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" disabled={archiveBusy} onClick={() => setArchiving(null)}>
                取消
              </Button>
              <Button disabled={archiveBusy} onClick={() => void confirmArchive()}>
                <Archive className="size-3.5" />
                归档
              </Button>
            </DialogFooter>
          </DialogPopup>
        </DialogPortal>
      </Dialog>
    </div>
  );
}
