import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  FolderInput,
  FolderOutput,
  FolderPlus,
  LayoutDashboard,
  Menu,
  MonitorPlay,
  Moon,
  Plus,
  RefreshCw,
  Settings2,
  Sun,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { InputPanel } from '@/components/InputPanel';
import { OutputPanel } from '@/components/OutputPanel';
import { OverviewPanel } from '@/components/OverviewPanel';
import { PrototypePanel } from '@/components/PrototypePanel';
import { Reader } from '@/components/Reader';
import { UnavailableWorkspace, WorkspaceDialog } from '@/components/WorkspaceSettings';
import { useProjects, useScan } from '@/hooks/useWorkspace';
import { api, type FileItem, type Project } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

type View = 'overview' | 'input' | 'output' | 'prototypes';

const NAV: { key: View; label: string; icon: typeof LayoutDashboard }[] = [
  { key: 'overview', label: '概览', icon: LayoutDashboard },
  { key: 'input', label: '输入资料', icon: FolderInput },
  { key: 'output', label: '产出文档', icon: FolderOutput },
  { key: 'prototypes', label: '原型', icon: MonitorPlay },
];

function useTheme() {
  const [dark, setDark] = useState(
    () =>
      localStorage.getItem('workspace-dashboard:theme') === 'dark' ||
      (!localStorage.getItem('workspace-dashboard:theme') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches),
  );
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('workspace-dashboard:theme', dark ? 'dark' : 'light');
  }, [dark]);
  return { dark, toggle: () => setDark((v) => !v) };
}

type FormMode = '' | 'add' | 'create';

/**
 * 两个入口：
 *   登记已有目录 —— 只把目录挂进看板
 *   新建工作空间 —— 调模板的 init_workspace.py 铺骨架，再挂进来
 */
function WorkspaceForms({ onDone }: { onDone: (id: string) => void }) {
  const [mode, setMode] = useState<FormMode>('');
  const [root, setRoot] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const close = () => {
    setMode('');
    setError('');
    setRoot('');
    setName('');
  };

  const submit = async () => {
    if (!root.trim() || (mode === 'create' && !name.trim())) return;
    setBusy(true);
    setError('');
    try {
      const project =
        mode === 'create'
          ? await api.createWorkspace(name.trim(), root.trim())
          : await api.addProject(root.trim());
      close();
      onDone(project.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!mode) {
    return (
      <div className="flex flex-col">
        <Button variant="ghost" size="sm" className="justify-start" onClick={() => setMode('create')}>
          <FolderPlus className="size-3.5" />
          新建工作空间
        </Button>
        <Button variant="ghost" size="sm" className="justify-start" onClick={() => setMode('add')}>
          <Plus className="size-3.5" />
          登记已有目录
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-2">
      <span className="text-[11px] text-muted-foreground">
        {mode === 'create' ? '从模板新建，元信息之后再补' : '登记一个已经存在的工作空间'}
      </span>
      {mode === 'create' ? (
        <Input
          autoFocus
          value={name}
          placeholder="工作空间名称"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && close()}
          className="h-8 text-xs"
        />
      ) : null}
      <Input
        autoFocus={mode === 'add'}
        value={root}
        placeholder="目录绝对路径"
        onChange={(e) => setRoot(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
          if (e.key === 'Escape') close();
        }}
        className="h-8 text-xs"
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void submit()}>
          {mode === 'create' ? '创建' : '登记'}
        </Button>
        <Button variant="ghost" size="sm" onClick={close}>
          取消
        </Button>
      </div>
    </div>
  );
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
  dark,
  toggleTheme,
  setSettingsFor,
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
  dark: boolean;
  toggleTheme: () => void;
  setSettingsFor: (p: Project) => void;
  onProjectAdded: (id: string) => void | Promise<void>;
  onNavigate?: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between px-1">
        <span className="font-display text-base">工作空间看板</span>
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
                'group flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-accent',
                project.id === activeId && 'bg-secondary text-secondary-foreground',
              )}
            >
              <button
                type="button"
                onClick={() => {
                  select(project.id);
                  onNavigate?.();
                }}
                title={broken ? `目录找不到了：${project.root}` : project.root}
                className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-sm"
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
        <WorkspaceForms onDone={onProjectAdded} />
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
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent',
              view === key && 'bg-secondary text-secondary-foreground',
            )}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </div>

      <div className="mt-auto flex flex-col gap-2 px-1">
        <Button variant="ghost" size="sm" className="justify-start" onClick={() => void reload()}>
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          重新扫描
        </Button>
        <span className="px-2 text-[11px] text-muted-foreground">
          {refreshedAt ? `更新于 ${formatRelative(refreshedAt)}` : '—'}
        </span>
      </div>
    </>
  );
}

export default function App() {
  const { projects, activeId, select, reload: reloadProjects } = useProjects();
  const { scan, loading, error, reload, refreshedAt } = useScan(activeId);
  const [view, setView] = useState<View>('overview');
  const [openFile, setOpenFile] = useState<FileItem | null>(null);
  const [settingsFor, setSettingsFor] = useState<Project | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const { dark, toggle } = useTheme();

  useEffect(() => {
    setOpenFile(null);
  }, [activeId]);

  // 窄屏浮层打开时锁住背景滚动
  useEffect(() => {
    if (!openFile && !navOpen) return;
    const mq = window.matchMedia('(max-width: 899px)');
    if (!mq.matches) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [openFile, navOpen]);

  const afterRegistryChange = async () => {
    await reloadProjects();
    await reload();
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
    dark,
    toggleTheme: toggle,
    setSettingsFor,
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
              workspace-dashboard add &lt;目录&gt;
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
            <OverviewPanel
              scan={scan}
              onOpen={setOpenFile}
              onGoto={setView}
              compact={Boolean(openFile)}
            />
          ) : null}
          {view === 'input' ? (
            <InputPanel
              scan={scan}
              projectId={activeId}
              openPath={openFile?.path || ''}
              onOpen={setOpenFile}
              compact={Boolean(openFile)}
            />
          ) : null}
          {view === 'output' ? (
            <OutputPanel
              scan={scan}
              openPath={openFile?.path || ''}
              onOpen={setOpenFile}
              compact={Boolean(openFile)}
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
        窄屏 <900：顶栏 + 看板全屏；侧栏抽屉；预览全屏浮层
    */
    <div className="flex h-dvh w-full max-w-[100vw] overflow-hidden">
      {/* ── 宽屏固定侧栏 ── */}
      <nav className="hidden h-full w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-muted/30 px-3 py-4 min-[900px]:flex">
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

      {/* ── 主区：窄屏顶栏 + (看板 | 预览) ── */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* 窄屏顶栏 */}
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 min-[900px]:hidden">
          <Button variant="ghost" size="icon" title="打开菜单" onClick={() => setNavOpen(true)}>
            <Menu className="size-4" />
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{headerTitle}</span>
          <Button variant="ghost" size="icon" title="切换主题" onClick={toggle}>
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </header>

        {/* 看板 + 预览行 */}
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {/*
            看板：
              无预览 → flex-1 全宽
              有预览 + 宽屏 → 2×侧栏宽（w-56 × 2 = 28rem）
              有预览 + 窄屏 → 隐藏（浮层预览盖住）
          */}
          <section
            className={cn(
              'min-h-0 min-w-0 overflow-hidden',
              openFile
                ? 'hidden w-[28rem] shrink-0 min-[900px]:flex min-[900px]:flex-col'
                : 'flex min-w-0 flex-1 flex-col',
            )}
          >
            <ScrollArea
              className="h-full min-h-0 w-full"
              viewportClassName={cn(
                'px-4 py-4',
                openFile ? 'sm:px-4 sm:py-4' : 'sm:px-6 sm:py-5 lg:px-8 lg:py-6',
              )}
            >
              {boardContent}
            </ScrollArea>
          </section>

          {/*
            预览：
              窄屏 → fixed 全屏浮层
              宽屏 → 文档流内 flex-1 占剩余宽度
          */}
          {openFile ? (
            <section className="fixed inset-0 z-30 flex min-h-0 min-w-0 flex-col overflow-hidden bg-background min-[900px]:static min-[900px]:z-auto min-[900px]:flex-1">
              <Reader projectId={activeId} item={openFile} onClose={() => setOpenFile(null)} />
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
