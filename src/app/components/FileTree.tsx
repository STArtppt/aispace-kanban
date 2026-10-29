import { Fragment, useMemo, useState, type DragEvent, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  FolderOpen,
  FolderTree,
  List,
  type LucideIcon,
} from 'lucide-react';
import { HeaderTooltip, Row, RowActions, writeClipboard, type RowAction, type RowDragProps } from '@/components/Primitives';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * 把一批文件按路径铺成目录树。
 *
 * 列表看得清「有哪些文件」，树看得清「它们是怎么组织的」—— 资料按客户 / 批次分目录
 * 放进 input/raw/、产出按专题分子目录时，平铺列表会把这层结构抹平。
 * 树完全由前端从已有的路径拼出来，服务端不用多给任何字段。
 */

export type ViewMode = 'list' | 'tree';

/** 视图偏好记在本地：同一个人下次进来还是他上次看的那种视图 */
export function readViewMode(storageKey: string): ViewMode {
  return localStorage.getItem(storageKey) === 'tree' ? 'tree' : 'list';
}

function ModeButton({
  icon: Icon,
  active,
  title,
  onClick,
}: {
  icon: LucideIcon;
  active: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <HeaderTooltip label={title}>
      <button
        type="button"
        aria-label={title}
        aria-pressed={active}
        onClick={onClick}
        className={cn(
          'flex size-7 items-center justify-center rounded-md transition-colors',
          active
            ? 'bg-muted text-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <Icon className="size-3.5" />
      </button>
    </HeaderTooltip>
  );
}

/**
 * 列表 / 树形切换。两个图标并排、选中的上灰底 —— 单个图标按钮看不出当前是哪种视图。
 * 这是整个视图的开关（视图里的几个清单一起切），所以放在视图顶部，不放在某个清单标题旁。
 */
export function ViewModeToggle({
  mode,
  onChange,
  label,
}: {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={`${label}显示方式`}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-input bg-background p-0.5 shadow-sm"
    >
      <ModeButton
        icon={List}
        active={mode === 'list'}
        title="平铺列表"
        onClick={() => onChange('list')}
      />
      <ModeButton
        icon={FolderTree}
        active={mode === 'tree'}
        title="按目录树查看"
        onClick={() => onChange('tree')}
      />
    </div>
  );
}

/**
 * 目录行尾的动作。复制相对路径 / 复制绝对路径 / 在文件管理器里定位是所有清单共有的，
 * 额外的（比如「转这一整个目录」）由各清单自己传 extra 进来。
 * dirPath 是工作空间内的相对路径 —— 树是前端按路径拼的，只有调用方知道它对应磁盘上的哪个目录。
 * absPath 是拼好的取绝对路径函数，可选：调用方没给（比如「未知来源」这种磁盘上没有的档）就不出这项。
 */
export function DirActions({
  projectId,
  fileManager,
  dirPath,
  absPath,
  extra,
  busy,
}: {
  projectId: string;
  fileManager: string;
  dirPath: string;
  absPath?: (relPath: string) => string;
  extra?: RowAction[];
  busy?: boolean;
}) {
  return (
    <RowActions
      busy={busy}
      actions={[
        ...(extra || []),
        {
          label: '复制路径',
          icon: Copy,
          onSelect: () => {
            void writeClipboard(dirPath);
          },
        },
        ...(absPath
          ? [
              {
                label: '复制绝对路径',
                icon: Copy,
                onSelect: () => {
                  void writeClipboard(absPath(dirPath));
                },
              },
            ]
          : []),
        {
          label: `在${fileManager}中显示`,
          icon: FolderOpen,
          onSelect: () => {
            void api.reveal(projectId, dirPath);
          },
        },
      ]}
    />
  );
}

interface TreeDir<T> {
  name: string;
  /** 树内路径，只用来当折叠状态的键 */
  key: string;
  dirs: TreeDir<T>[];
  files: T[];
  /** 递归文件数，画在目录行右侧 */
  count: number;
}

function makeDir<T>(name: string, key: string): TreeDir<T> {
  return { name, key, dirs: [], files: [], count: 0 };
}

function countFiles<T>(dir: TreeDir<T>): number {
  dir.count = dir.files.length + dir.dirs.reduce((sum, child) => sum + countFiles(child), 0);
  return dir.count;
}

/** 目录按名称自然序排（10 排在 9 之后）；文件保持调用方给的顺序（那是用户选的排序结果） */
function sortDirs<T>(dir: TreeDir<T>) {
  dir.dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }));
  for (const child of dir.dirs) sortDirs(child);
}

function buildTree<T>(items: T[], treePathOf: (item: T) => string): TreeDir<T> {
  const root = makeDir<T>('', '');
  for (const item of items) {
    const segments = treePathOf(item).split('/').filter(Boolean);
    // 最后一段是文件自己，由 renderFile 画，不建成目录
    segments.pop();
    let node = root;
    for (const segment of segments) {
      let next = node.dirs.find((d) => d.name === segment);
      if (!next) {
        next = makeDir<T>(segment, node.key ? `${node.key}/${segment}` : segment);
        node.dirs.push(next);
      }
      node = next;
    }
    node.files.push(item);
  }
  sortDirs(root);
  countFiles(root);
  return root;
}

/** 被拖的那一项：一个文件，或树里的一个目录（dirKey 相对本列表根） */
export type TreeDragSource<T> = { item: T } | { dirKey: string };

/**
 * 树的拖放。可选：不传时树与原来完全一样（产出清单、转换产物都不传）。
 * 放下只回调 onDrop，**不写盘**；能不能放（不能放进自己、子目录或原来的父目录）由树自己判断。
 */
export interface TreeDnd<T> {
  canDragFile: (item: T) => boolean;
  canDragDir: (dirKey: string) => boolean;
  /** toDirKey 相对本列表根，'' 是根 */
  onDrop: (from: TreeDragSource<T>, toDirKey: string) => void;
  /** 拖动时顶部出现的「放到根上」区域的文案 */
  rootLabel: string;
}

function parentOf(treePath: string): string {
  const cut = treePath.lastIndexOf('/');
  return cut === -1 ? '' : treePath.slice(0, cut);
}

export function FileTree<T>({
  items,
  treePathOf,
  keyOf,
  renderFile,
  renderDirActions,
  renderDirBadge,
  expandAll,
  dnd,
}: {
  items: T[];
  /** 这份文件在树里的位置，相对本列表的根目录，如 `客户版/需求说明.md` */
  treePathOf: (item: T) => string;
  keyOf: (item: T) => string;
  /** 画一行文件；indent 要透给 Row，否则层级看不出来。dragProps 有就原样挂到 Row 上 */
  renderFile: (item: T, indent: number, dragProps?: RowDragProps) => ReactNode;
  /**
   * 目录行尾的动作（复制路径、转这一整个目录…）。dirKey 是相对本列表根目录的路径。
   * 树是前端按路径拼的，只有调用方知道它对应磁盘上的哪个目录，所以由调用方来给。
   */
  renderDirActions?: (dirKey: string) => ReactNode;
  /** 文件数后、动作前的标签（如原始资料的汇总状态）。dirKey 同上 */
  renderDirBadge?: (dirKey: string) => ReactNode;
  /**
   * 无视折叠状态一律展开。给「正在搜索」用 —— 命中的文件藏在收起的目录里，
   * 看着就跟搜不到一样。搜索结束后仍回到用户自己点开的那几层。
   */
  expandAll?: boolean;
  dnd?: TreeDnd<T>;
}) {
  const root = useMemo(() => buildTree(items, treePathOf), [items, treePathOf]);
  // 正在拖的那一项（treePath 是它在树里的位置）与鼠标停在哪个目录上（'' = 根）
  const [dragging, setDragging] = useState<{ from: TreeDragSource<T>; treePath: string; isDir: boolean } | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const canDropOn = (target: string) => {
    if (!dragging) return false;
    if (dragging.isDir && (target === dragging.treePath || target.startsWith(`${dragging.treePath}/`))) return false;
    return target !== parentOf(dragging.treePath);
  };

  const endDrag = () => {
    setDragging(null);
    setOver(null);
  };

  const dragSourceProps = (from: TreeDragSource<T>, treePath: string, isDir: boolean): RowDragProps => ({
    draggable: true,
    onDragStart: (event: DragEvent<HTMLButtonElement>) => {
      // Firefox 不放数据就不开始拖；真正的载荷在 state 里
      event.dataTransfer.setData('text/plain', treePath);
      event.dataTransfer.effectAllowed = 'move';
      setDragging({ from, treePath, isDir });
    },
    onDragEnd: endDrag,
  });

  // 处理函数按 HTMLElement 写：目录行（button）和顶部的根放置区（div）共用
  const dropProps = (target: string) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!canDropOn(target)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (over !== target) setOver(target);
    },
    onDragLeave: () => {
      if (over === target) setOver(null);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const from = dragging?.from;
      const ok = canDropOn(target);
      endDrag();
      if (from && ok) dnd?.onDrop(from, target);
    },
  });
  // 记「展开了哪些」：切到树形时全部收起，先看清目录结构，再往下点想看的那一支
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderLevel = (dir: TreeDir<T>, depth: number): ReactNode[] => {
    const rows: ReactNode[] = [];
    for (const child of dir.dirs) {
      const open = expandAll || expanded.has(child.key);
      const dirDrag: RowDragProps | undefined = dnd
        ? {
            ...(dnd.canDragDir(child.key) ? dragSourceProps({ dirKey: child.key }, child.key, true) : {}),
            ...dropProps(child.key),
          }
        : undefined;
      rows.push(
        <Row
          key={`dir:${child.key}`}
          indent={depth}
          onClick={() => toggle(child.key)}
          dragProps={dirDrag}
          dropTarget={over === child.key}
        >
          <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            <Folder className="size-4" />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm" title={child.key}>
            {child.name}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{child.count}</span>
          {renderDirBadge?.(child.key)}
          {renderDirActions?.(child.key)}
        </Row>,
      );
      if (open) rows.push(...renderLevel(child, depth + 1));
    }
    for (const file of dir.files) {
      // Fragment 只用来挂 key，不产生额外 DOM：多包一层 div 会让每行都变成
      // 「div 里的最后一个子元素」，Row 的 last:border-b-0 把分割线全删掉
      const fileDrag = dnd?.canDragFile(file) ? dragSourceProps({ item: file }, treePathOf(file), false) : undefined;
      rows.push(<Fragment key={keyOf(file)}>{renderFile(file, depth, fileDrag)}</Fragment>);
    }
    return rows;
  };

  const tree = <div className="overflow-hidden rounded-lg border border-border">{renderLevel(root, 0)}</div>;
  // 不拖放的清单（产出、转换产物）结构与原来一模一样
  if (!dnd) return tree;
  return (
    <div className="flex flex-col gap-2">
      {dragging && canDropOn('') ? (
        <div
          role="presentation"
          {...dropProps('')}
          className={cn(
            'rounded-lg border border-dashed border-border px-3 py-2.5 text-center text-xs text-muted-foreground',
            over === '' && 'border-ring bg-accent text-foreground',
          )}
        >
          {dnd.rootLabel}
        </div>
      ) : null}
      {tree}
    </div>
  );
}
