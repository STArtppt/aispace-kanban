import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CircleHelp,
  FolderInput,
  FolderOutput,
  LayoutDashboard,
  Menu,
  MonitorPlay,
  Moon,
  RefreshCw,
  Settings2,
  Sun,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CreateWorkspaceDialog } from '@/components/CreateWorkspaceDialog';
import { HelpPanel } from '@/components/HelpPanel';
import { InputPanel } from '@/components/InputPanel';
import { OutputPanel } from '@/components/OutputPanel';
import { OverviewPanel } from '@/components/OverviewPanel';
import { PrototypePanel } from '@/components/PrototypePanel';
import { Reader } from '@/components/Reader';
import { UnavailableWorkspace, WorkspaceDialog } from '@/components/WorkspaceSettings';
import { useBoardSession, type View } from '@/hooks/useBoardSession';
import { useIngestJob } from '@/hooks/useIngestJob';
import { useProjects, useScan } from '@/hooks/useWorkspace';
import { api, type FileItem, type Project } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

/** 预览挂载/离场时长，需与下方 transition duration 一致 */
const PREVIEW_MOTION_MS = 320;
/** 宽屏断点（与 Tailwind min-[900px] 对齐） */
const WIDE_MQ = '(min-width: 900px)';
/** 宽屏有预览时看板宽 = 2× 侧栏 w-56 */
const BOARD_COMPACT = '28rem';

/**
 * 预览位里放的东西：一份工作空间文件，或看板帮助文档。
 * 两者互斥（同一个位置、同一套进出场动画），所以合成一个联合类型而不是两套状态。
 */
type Preview = { kind: 'file'; file: FileItem } | { kind: 'help' };

/**
 * 控制预览进出场：关闭时先播离场再卸载，切换文档时只换内容不重播。
 * visible 只驱动看板 width；预览用 flex-1 吃剩余空间，由浏览器逐帧填满，避免 JS 设双宽度打架。
 *
 * 依赖的是 preview 对象本身（调用方用 useMemo 稳住身份）：扫描刷新后 FileItem 会换一个新
 * 对象，那时也该把新的那份换进来，用字符串 key 做依赖会漏掉这次更新。
 */
function usePreviewPresence(preview: Preview | null) {
  const [mounted, setMounted] = useState<Preview | null>(preview);
  const [visible, setVisible] = useState(Boolean(preview));

  useEffect(() => {
    if (preview) {
      setMounted(preview);
      // 双 rAF：先以「看板 100% + 预览 0」挂载，再切到打开态，width transition 才能触发
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setVisible(false);
    const t = window.setTimeout(() => setMounted(null), PREVIEW_MOTION_MS);
    return () => window.clearTimeout(t);
  }, [preview]);

  return { mounted, visible };
}

/** 宽屏断点（与 Tailwind min-[900px] 对齐） */
function useIsWide() {
  const [wide, setWide] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(WIDE_MQ).matches : true,
  );
  useEffect(() => {
    const mq = window.matchMedia(WIDE_MQ);
    const onChange = () => setWide(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return wide;
}

const NAV: { key: View; label: string; icon: typeof LayoutDashboard }[] = [
  { key: 'overview', label: '概览', icon: LayoutDashboard },
  { key: 'input', label: '输入资料', icon: FolderInput },
  { key: 'output', label: '产出文档', icon: FolderOutput },
  { key: 'prototypes', label: '原型', icon: MonitorPlay },
];

/** 看板版本：老服务进程没有这个字段时不显示，退回改动前的侧栏。 */
let versionPromise: Promise<string> | null = null;
function queryVersion() {
  versionPromise ??= api
    .health()
    .then((data) => (typeof data.version === 'string' ? data.version.trim() : ''))
    .catch(() => '');
  return versionPromise;
}

function useAppVersion() {
  const [version, setVersion] = useState('');
  useEffect(() => {
    let alive = true;
    void queryVersion().then((value) => {
      if (alive && value) setVersion(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return version;
}

function useTheme() {
  const [dark, setDark] = useState(
    () =>
      localStorage.getItem('aispace-kanban:theme') === 'dark' ||
      (!localStorage.getItem('aispace-kanban:theme') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches),
  );
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('aispace-kanban:theme', dark ? 'dark' : 'light');
  }, [dark]);
  return { dark, toggle: () => setDark((v) => !v) };
}

function SidebarBody({
  projects,
  activeId,
  select,
  view,
  setView,
  loading,
  reload,
  refreshedAt,
  version,
  dark,
  toggleTheme,
  setSettingsFor,
  openHelp,
  onProjectAdded,
  onNavigate,
}: {
  projects: Project[];
  activeId: string;
  select: (id: string) => void;
  view: View;
  setView: (v: View) => void;
  loading: boolean;
  reload: () => void | Promise<void>;
  refreshedAt: string;
  version: string;
  dark: boolean;
  toggleTheme: () => void;
  setSettingsFor: (p: Project) => void;
  openHelp: () => void;
  onProjectAdded: (id: string) => void | Promise<void>;
  onNavigate?: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between px-1">
        <span className="flex min-w-0 items-center gap-1.5">
          {/* 黑字 logo：深色模式反相成白字，避免融进背景 */}
          <img src="/logo-ai.png" alt="" className="h-5 w-auto shrink-0 dark:invert" />
          <span className="font-display truncate text-base">工作空间看板</span>
        </span>
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon" title="切换主题" onClick={toggleTheme}>
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
          {onNavigate ? (
            <Button
              variant="ghost"
              size="icon"
              title="关闭菜单"
              className="max-[899px]:inline-flex min-[900px]:hidden"
              onClick={onNavigate}
            >
              <X className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="px-2 text-[11px] text-muted-foreground">工作空间</span>
        {projects.map((project) => {
          const broken = project.status && !project.status.ok;
          return (
            <div
              key={project.id}
              className={cn(
                // border-transparent 常驻：选中时才上色，避免多出 1px 让行错位
                'group flex items-center gap-1 rounded-md border border-transparent pr-1 transition-colors hover:bg-accent',
                // 选中态同概览页「进行中」阶段：浅灰底 + 细深色描边
                project.id === activeId && 'border-foreground/40 bg-muted hover:bg-muted',
              )}
            >
              <button
                type="button"
                onClick={() => {
                  select(project.id);
                  onNavigate?.();
                }}
                title={broken ? `目录找不到了：${project.root}` : project.root}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-sm',
                  project.id === activeId && 'font-medium',
                )}
              >
                {broken ? <AlertTriangle className="size-3.5 shrink-0 text-destructive" /> : null}
                <span className="truncate">{project.name}</span>
              </button>
              <button
                type="button"
                title="工作空间设置"
                onClick={() => setSettingsFor(project)}
                className={cn(
                  'shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100',
                  broken && 'opacity-100',
                )}
              >
                <Settings2 className="size-3.5" />
              </button>
            </div>
          );
        })}
        <CreateWorkspaceDialog onDone={onProjectAdded} />
      </div>

      <div className="flex flex-col gap-1">
        <span className="px-2 text-[11px] text-muted-foreground">视图</span>
        {NAV.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setView(key);
              onNavigate?.();
            }}
            className={cn(
              'flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent',
              view === key && 'border-foreground/40 bg-muted font-medium hover:bg-muted',
            )}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </div>

      <div className="mt-auto flex flex-col gap-2 px-1">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            title="重新扫描"
            aria-label="重新扫描"
            onClick={() => void reload()}
          >
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          </Button>
          <Button variant="ghost" size="icon" title="查看帮助" aria-label="查看帮助" onClick={openHelp}>
            <CircleHelp className="size-4" />
          </Button>
        </div>
        <span className="px-2 text-[11px] text-muted-foreground">
          {refreshedAt ? `更新于 ${formatRelative(refreshedAt)}` : '—'}
        </span>
        {version ? (
          <span className="px-2 font-mono text-[10px] text-muted-foreground/60" title={`看板 ${version}`}>
            {version}
          </span>
        ) : null}
      </div>
    </>
  );
}

export default function App() {
  const { projects, activeId, select, reload: reloadProjects } = useProjects();
  const { scan, loading, error, reload, refreshedAt } = useScan(activeId);
  const { view, setView, openFile, selectFile } = useBoardSession(activeId, scan);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [settingsFor, setSettingsFor] = useState<Project | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const { dark, toggle } = useTheme();
  const version = useAppVersion();
  const [helpOpen, setHelpOpen] = useState(false);
  // 帮助和文件共用预览位，所以互斥：开帮助时先把文件预览关掉，关帮助就回到看板。
  // useMemo 稳住对象身份，否则每次渲染都是新对象，进出场动画会被反复重放。
  const preview = useMemo<Preview | null>(
    () => (helpOpen ? { kind: 'help' } : openFile ? { kind: 'file', file: openFile } : null),
    [helpOpen, openFile],
  );
  const { mounted: mountedPreview, visible: previewVisible } = usePreviewPresence(preview);
  const mountedFile = mountedPreview?.kind === 'file' ? mountedPreview.file : null;
  const openHelp = () => {
    selectFile(null);
    setHelpOpen(true);
    setNavOpen(false);
  };
  // 转换任务提到这一层：待转换列表和预览页的「重新转换」共用同一轮任务
  // （服务端每个项目只允许一个，各持一份状态会让第二处显示成「没反应」）
  const canIngest = Boolean(scan?.input?.canIngest);
  const ingest = useIngestJob(activeId, canIngest);
  const isWide = useIsWide();
  // 布局侧：真正打开中（含离场动画期）
  const previewActive = Boolean(mountedPreview);

  useEffect(() => {
    setPreviewExpanded(false);
    setHelpOpen(false);
  }, [activeId]);

  // 预览卸载后再清展开态，避免离场途中侧栏/看板突然弹回
  useEffect(() => {
    if (!mountedPreview) setPreviewExpanded(false);
  }, [mountedPreview]);

  // 窄屏浮层打开时锁住背景滚动（含离场动画期）
  useEffect(() => {
    if (!previewActive && !navOpen) return;
    if (isWide) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [previewActive, navOpen, isWide]);

  const afterRegistryChange = async () => {
    await reloadProjects();
    await reload();
  };

  const selectFileAndCloseHelp = (file: FileItem | null) => {
    setHelpOpen(false);
    selectFile(file);
  };

  const sidebarProps = {
    projects,
    activeId,
    select,
    view,
    setView,
    loading,
    reload,
    refreshedAt,
    version,
    dark,
    toggleTheme: toggle,
    setSettingsFor,
    openHelp,
    onProjectAdded: async (id: string) => {
      await reloadProjects();
      select(id);
      setNavOpen(false);
    },
  };

  const activeProject = projects.find((p) => p.id === activeId);
  const headerTitle =
    scan?.meta?.data?.identity?.项目名称 ||
    scan?.meta?.data?.workspace?.name ||
    activeProject?.name ||
    '工作空间看板';

  const boardContent = (
    <>
      {error ? (
        <div className="rounded-lg border border-destructive/40 px-4 py-3 text-sm text-destructive">{error}</div>
      ) : null}

      {!projects.length && !error ? (
        <div className="mx-auto mt-16 max-w-md rounded-lg border border-dashed border-border px-6 py-10 text-center sm:mt-24">
          <p className="text-sm">还没有登记工作空间。</p>
          <p className="mt-2 text-xs text-muted-foreground">
            用菜单里的「添加工作空间」填入目录，或在终端里跑
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono">
              aispace-kanban add &lt;目录&gt;
            </code>
          </p>
        </div>
      ) : null}

      {scan?.available === false ? (
        <UnavailableWorkspace
          project={scan.project}
          reasons={scan.unavailableReasons || []}
          onSettings={() => {
            const project = projects.find((p) => p.id === scan.project.id);
            if (project) setSettingsFor(project);
          }}
          onRelinked={() => void afterRegistryChange()}
        />
      ) : null}

      {scan && scan.available !== false ? (
        <>
          {view === 'overview' ? (
            <OverviewPanel scan={scan} onOpen={selectFileAndCloseHelp} onGoto={setView} />
          ) : null}
          {view === 'input' ? (
            <InputPanel
              scan={scan}
              projectId={activeId}
              openPath={openFile?.path || mountedFile?.path || ''}
              onOpen={selectFileAndCloseHelp}
              ingest={ingest}
            />
          ) : null}
          {view === 'output' ? (
            <OutputPanel
              scan={scan}
              openPath={openFile?.path || mountedFile?.path || ''}
              onOpen={selectFileAndCloseHelp}
            />
          ) : null}
          {view === 'prototypes' ? <PrototypePanel prototypes={scan.prototypes} /> : null}
        </>
      ) : null}
    </>
  );

  return (
    /*
      布局契约（只认 900px 一个断点；类名必须是完整字面量，否则 Tailwind 扫不到）：
        宽屏 ≥900：侧栏(w-56) | 看板(有预览时 2×侧栏 = w-[28rem]) | 预览(flex-1)
                  预览「向左展开」后：侧栏+看板收为 0，预览占满
                  进出场：看板与预览宽度像素联动（同步压缩/伸开）
        窄屏 <900：顶栏 + 看板全屏；侧栏抽屉；预览全屏浮层
    */
    <div className="flex h-dvh w-full max-w-[100vw] overflow-hidden">
      {/* ── 宽屏固定侧栏（展开全屏时收宽；勿在内层再写死 w-56，会把 px 内边距挤爆） ── */}
      <nav
        className={cn(
          'hidden h-full shrink-0 flex-col gap-4 border-r border-border bg-muted/30 min-[900px]:flex',
          'transition-[width,padding,opacity,border-color] duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
          previewActive && previewExpanded
            ? 'pointer-events-none w-0 overflow-hidden border-transparent py-4 opacity-0'
            : 'w-56 overflow-y-auto px-3 py-4 opacity-100',
        )}
      >
        <SidebarBody {...sidebarProps} />
      </nav>

      {/* ── 窄屏抽屉侧栏 ── */}
      {navOpen ? (
        <div className="fixed inset-0 z-40 flex min-[900px]:hidden">
          <button
            type="button"
            aria-label="关闭菜单"
            className="absolute inset-0 bg-background/60 backdrop-blur-[2px]"
            onClick={() => setNavOpen(false)}
          />
          <nav className="relative z-10 flex h-full w-[min(18rem,86vw)] flex-col gap-4 overflow-y-auto border-r border-border bg-background px-3 py-4 shadow-lg">
            <SidebarBody {...sidebarProps} onNavigate={() => setNavOpen(false)} />
          </nav>
        </div>
      ) : null}

      {/* ── 主区：看板 | 预览（窄屏的菜单/主题按钮并进看板抬头，不再单开一栏） ── */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/*
          看板 + 预览行（宽屏）：
            只动画看板 width（100% ↔ 28rem ↔ 0），预览用 flex-1 吃剩余——
            由浏览器在 CSS 动画每一帧自动填满，不再用 ResizeObserver 双边设宽（易跳闪）。
          窄屏：预览 fixed 浮层，看板隐藏。
        */}
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <section
            className={cn(
              'flex min-h-0 min-w-0 flex-col overflow-hidden',
              'transition-[width,opacity] duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
              // 窄屏有预览：让位给浮层
              !isWide && previewActive && 'hidden',
              !isWide && !previewActive && 'min-w-0 flex-1',
              // 宽屏无预览
              isWide && !previewActive && 'min-w-0 flex-1',
              // 宽屏有预览：width 走 style 插值；展开时淡出
              isWide && previewActive && 'shrink-0',
              isWide && previewActive && previewVisible && previewExpanded && 'pointer-events-none opacity-0',
            )}
            style={
              // 只动画看板 width；预览 flex-1 自动吃剩余，避免双边 JS 设宽跳闪
              isWide && previewActive
                ? {
                    width: !previewVisible ? '100%' : previewExpanded ? 0 : BOARD_COMPACT,
                  }
                : undefined
            }
          >
            {/*
              项目抬头常驻在滚动区外：切视图、滚动都看得见当前是哪个工作空间。
              窄屏时它同时兼顶栏（菜单 + 主题都在这一栏里），所以哪怕还没扫描结果也要渲染，
              否则抽屉侧栏就没有入口了；宽屏没结果时才收起来。
            */}
            <header
              className={cn(
                'flex shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-2.5 sm:px-5 sm:py-3',
                !scan && 'min-[900px]:hidden',
              )}
            >
              <Button
                variant="ghost"
                size="icon"
                title="打开菜单"
                className="shrink-0 min-[900px]:hidden"
                onClick={() => setNavOpen(true)}
              >
                <Menu className="size-4" />
              </Button>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <h1 className="font-display truncate text-lg leading-tight sm:text-xl" title={headerTitle}>
                  {headerTitle}
                </h1>
                {scan ? (
                  <p
                    className="truncate font-mono text-xs text-muted-foreground"
                    title={scan.project.root}
                  >
                    {scan.project.root}
                  </p>
                ) : null}
              </div>
              <Button
                variant="ghost"
                size="icon"
                title="切换主题"
                className="shrink-0 min-[900px]:hidden"
                onClick={toggle}
              >
                {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </Button>
            </header>
            <ScrollArea
              className="min-h-0 w-full flex-1"
              // 内边距固定：不随预览开合切换 sm/lg 档，避免顶部空白突变导致整页跳动
              viewportClassName="px-4 py-4 sm:px-5 sm:py-4"
            >
              {boardContent}
            </ScrollArea>
          </section>

          {mountedPreview ? (
            <section
              className={cn(
                'flex min-h-0 min-w-0 flex-col overflow-hidden bg-background',
                // 窄屏浮层
                !isWide && [
                  'fixed inset-0 z-30',
                  'transition-[opacity,transform] duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
                  previewVisible
                    ? 'translate-y-0 opacity-100'
                    : 'pointer-events-none translate-y-3 opacity-0',
                ],
                // 宽屏：可见时 flex-1 吃剩余；关闭态 w-0，不抢空间
                isWide && [
                  'transition-[opacity] duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
                  previewVisible
                    ? 'min-w-0 flex-1 opacity-100'
                    : 'w-0 min-w-0 shrink-0 grow-0 opacity-0',
                ],
              )}
            >
              {mountedPreview.kind === 'help' ? (
                <HelpPanel
                  onClose={() => setHelpOpen(false)}
                  expanded={previewExpanded}
                  onToggleExpand={() => setPreviewExpanded((v) => !v)}
                />
              ) : (
                <Reader
                  projectId={activeId}
                  item={mountedPreview.file}
                  ingest={ingest}
                  canIngest={canIngest}
                  onClose={() => selectFile(null)}
                  expanded={previewExpanded}
                  onToggleExpand={() => setPreviewExpanded((v) => !v)}
                />
              )}
            </section>
          ) : null}
        </div>
      </div>

      {settingsFor ? (
        <WorkspaceDialog
          project={settingsFor}
          open
          onOpenChange={(next) => !next && setSettingsFor(null)}
          onSaved={() => void afterRegistryChange()}
          onRemoved={() => void reloadProjects()}
        />
      ) : null}
    </div>
  );
}
