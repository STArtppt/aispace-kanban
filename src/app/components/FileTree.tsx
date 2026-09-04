import { Fragment, useMemo, useState, type ReactNode } from 'react';
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
import { HeaderTooltip, Row, RowActions, writeClipboard, type RowAction } from '@/components/Primitives';
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

/** 目录按名称排；文件保持调用方给的顺序（那是用户选的排序结果） */
function sortDirs<T>(dir: TreeDir<T>) {
  dir.dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
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

export function FileTree<T>({
  items,
  treePathOf,
  keyOf,
  renderFile,
  renderDirActions,
  expandAll,
}: {
  items: T[];
  /** 这份文件在树里的位置，相对本列表的根目录，如 `客户版/需求说明.md` */
  treePathOf: (item: T) => string;
  keyOf: (item: T) => string;
  /** 画一行文件；indent 要透给 Row，否则层级看不出来 */
  renderFile: (item: T, indent: number) => ReactNode;
  /**
   * 目录行尾的动作（复制路径、转这一整个目录…）。dirKey 是相对本列表根目录的路径。
   * 树是前端按路径拼的，只有调用方知道它对应磁盘上的哪个目录，所以由调用方来给。
   */
  renderDirActions?: (dirKey: string) => ReactNode;
  /**
   * 无视折叠状态一律展开。给「正在搜索」用 —— 命中的文件藏在收起的目录里，
   * 看着就跟搜不到一样。搜索结束后仍回到用户自己点开的那几层。
   */
  expandAll?: boolean;
}) {
  const root = useMemo(() => buildTree(items, treePathOf), [items, treePathOf]);
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
      rows.push(
        <Row key={`dir:${child.key}`} indent={depth} onClick={() => toggle(child.key)}>
          <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            <Folder className="size-4" />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm" title={child.key}>
            {child.name}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{child.count}</span>
          {renderDirActions?.(child.key)}
        </Row>,
      );
      if (open) rows.push(...renderLevel(child, depth + 1));
    }
    for (const file of dir.files) {
      // Fragment 只用来挂 key，不产生额外 DOM：多包一层 div 会让每行都变成
      // 「div 里的最后一个子元素」，Row 的 last:border-b-0 把分割线全删掉
      rows.push(<Fragment key={keyOf(file)}>{renderFile(file, depth)}</Fragment>);
    }
    return rows;
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border">{renderLevel(root, 0)}</div>
  );
}
