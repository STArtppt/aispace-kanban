import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppWindow, CodeXml, Copy, CopyPlus, FileText, Image, PencilLine, RefreshCw, Star, StarOff, Table } from 'lucide-react';
import { EmptyState, ListPager, Row, RowActions, writeClipboard } from '@/components/Primitives';
import { DirActions, FileTree, type ViewMode } from '@/components/FileTree';
import { codePreviewLanguage } from '@/components/CodeFileView';
import { useFileManagerName } from '@/hooks/useFileManager';
import { usePins } from '@/hooks/usePins';
import type { ConvertedItem, FileItem, Scan } from '@/lib/api';
import { markdownLink } from '@/lib/format';

/**
 * 转换产物清单。原来是「输入资料」的一个页签，产物搬到 `output/converted/` 后挪到「产出文档」下，
 * 作为独立一栏（不进产出三组）；原始资料的行图标、分页也从这里取。
 */

/** 原始资料 / 转换产物列表一页条数 */
export const LIST_PAGE_SIZE = 12;

export type ListSortKey = 'name' | 'mtimeAsc' | 'mtimeDesc';

export function KindIcon({ item }: { item: { reader: string; isDir?: boolean; ext?: string; path?: string } }) {
  if (item.reader === 'html') return <AppWindow className="size-4 text-muted-foreground" />;
  if (item.isDir || item.reader === 'table') return <Table className="size-4 text-muted-foreground" />;
  if (item.reader === 'image') return <Image className="size-4 text-muted-foreground" />;
  if (codePreviewLanguage(item.ext || item.path || '')) {
    return <CodeXml className="size-4 text-muted-foreground" />;
  }
  return <FileText className="size-4 text-muted-foreground" />;
}

/** 名称模糊：空格分词，每段都要在标题/文件名/来源/路径里出现（大小写不敏感） */
export function matchConverted(item: ConvertedItem, query: string): boolean {
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
 * 产物在树里的位置。
 *
 * 服务端给了 treePath 就用它：converted/ 与 input/raw/ 同构，产物自己的
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

/**
 * 「复制到…」能不能用：`missing` = 工作空间目录不见了；undefined = 旧服务进程没给字段。
 * 能点时返回空串。只对带 docKey 的单文件 .md 有意义，调用方先判断 docKey。
 */
export type CanCopyConverted = boolean | 'missing' | undefined;

function copyBlockedReason(canCopy: CanCopyConverted): string {
  if (canCopy === 'missing') return '工作空间目录找不到了，重新关联之后才能复制';
  if (canCopy === undefined) return '看板服务是旧版本，重启后可用';
  if (canCopy === false) return '这个工作空间没有复制脚本 scripts/copy_converted.py，更新模板后可用';
  return '';
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
  canCopy,
  onCopy,
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
  canCopy: CanCopyConverted;
  onCopy: (item: ConvertedItem) => void;
}) {
  const copyBlocked = copyBlockedReason(canCopy);
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
          // 只有单文件 .md（带 docKey，与「转成 Word」同一批）能复制进产出三组
          ...(item.docKey
            ? [
                {
                  label: '复制到…',
                  icon: CopyPlus,
                  disabled: Boolean(copyBlocked),
                  hint: copyBlocked || undefined,
                  onSelect: () => onCopy(item),
                },
              ]
            : []),
          // 产物名字跟着原件走：在这里改名会和原件对不上。置灰并指路，免得人回文件夹手改
          {
            label: '重命名',
            icon: PencilLine,
            disabled: true,
            hint: '到「输入资料 → 原始资料」里重命名或移动原件，产物、台账和链接会一起更新',
            onSelect: () => {},
          },
        ]}
      />
    </Row>
  );
}

export function useListPage(total: number, pageSize: number, resetKey: string) {
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

export const CONVERTED_FILTERS = {
  all: '全部',
  unreferenced: '未被引用',
  stale: '原件动过',
} as const;

export type ConvertedFilter = keyof typeof CONVERTED_FILTERS;


/**
 * 当前能用的筛选档。没产出、或旧服务没给 referencedBy：筛「未被引用」没意义，那一档就不出；
 * 一份都没动过时不给「原件动过」：筛出来必然是空的。
 */
export function convertedFilterOptions(items: ConvertedItem[], hasOutputs: boolean): ConvertedFilter[] {
  const canFilterUnreferenced = hasOutputs && items.some((item) => Array.isArray(item.referencedBy));
  const canFilterStale = items.some((item) => item.sourceState === 'stale');
  return [
    'all',
    ...(canFilterUnreferenced ? (['unreferenced'] as const) : []),
    ...(canFilterStale ? (['stale'] as const) : []),
  ];
}

/** 归档项照样计入溯源反链，所以「有没有产出」也要算上它们（total 只数主列表） */
export function hasAnyOutput(scan: Scan): boolean {
  const archived = scan.output.stats.archived;
  return scan.output.stats.total + (archived ? archived.analysis + archived.docs + archived.decisions : 0) > 0;
}

/**
 * 旧布局 / 残留提示。旧服务进程不给 layout：什么都不显示。
 * 迁移由工作空间的一次性脚本做，看板不提供按钮（不新增写入例外）。
 */
export function ConvertedLayoutNotice({ scan }: { scan: Scan }) {
  const { layout, convertedLeftover } = scan.input;
  if (layout === 'input') {
    return (
      <p className="text-xs text-muted-foreground">
        这个工作空间还是旧目录布局（产物在 input/converted/），更新模板后执行迁移脚本
        <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
          python3 scripts/migrate_converted_to_output.py --dry-run
        </code>
        。迁移前这里照常可用。
      </p>
    );
  }
  if (convertedLeftover) {
    return (
      <p className="text-xs text-destructive">
        input/converted/ 下还有残留文件，这里显示的是 output/converted/。请人工确认残留是否还要，再手动处理。
      </p>
    );
  }
  return null;
}

export function ConvertedList({
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
  canCopy,
  onCopy,
}: {
  items: ConvertedItem[];
  hasOutputs: boolean;
  viewMode: ViewMode;
  query: string;
  activeFilter: ConvertedFilter;
  sortKey: ListSortKey;
  projectId: string;
  /** 拼好的取绝对路径函数，「复制绝对路径」用 */
  absPath: (relPath: string) => string;
  openPath: string;
  onOpen: (item: FileItem) => void;
  canIngest: boolean;
  ingestRunning: boolean;
  ingestingPath: string;
  onIngest: (filePath: string) => void;
  canCopy: CanCopyConverted;
  onCopy: (item: ConvertedItem) => void;
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
        return (a.title || a.name).localeCompare(b.title || b.name, 'zh', { numeric: true });
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
      {staleCount ? (
        <p className="text-xs text-muted-foreground">
          有 <span className="text-destructive">{staleCount} 份原件在转换后动过</span>
          ，产物可能已经不对。右上角筛选可以只看这些；「输入资料 → 原始资料」里它们标着「改动」。
          {canIngest
            ? '行内「更多」点「重新转换」只重转那一份；「原始资料」里标着「改动」的那一行也可以重新转换。'
            : '在工作空间里重跑 python3 scripts/ingest.py <文件或目录>，只有动过的会重转。'}
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
              canCopy={canCopy}
              onCopy={onCopy}
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
              canCopy={canCopy}
              onCopy={onCopy}
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
              ? '把资料放进 input/raw/，再到「输入资料 → 原始资料」对那一行点「转成AI易读」'
              : '把资料放进 input/raw/，然后在工作空间里跑 python3 scripts/ingest.py <文件或目录>'
          }
        />
      )}
    </div>
  );
}

