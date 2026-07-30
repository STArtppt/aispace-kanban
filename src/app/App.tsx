import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  FolderInput,
  FolderOutput,
  FolderPlus,
  LayoutDashboard,
  MonitorPlay,
  Moon,
  Plus,
  RefreshCw,
  Settings2,
  Sun,
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

export default function App() {
  const { projects, activeId, select, reload: reloadProjects } = useProjects();
  const { scan, loading, error, reload, refreshedAt } = useScan(activeId);
  const [view, setView] = useState<View>('overview');
  const [openFile, setOpenFile] = useState<FileItem | null>(null);
  const [settingsFor, setSettingsFor] = useState<Project | null>(null);
  const { dark, toggle } = useTheme();

  useEffect(() => {
    setOpenFile(null);
  }, [activeId]);

  // 改完路径/名字或移出登记之后，列表和扫描结果都得重新拉
  const afterRegistryChange = async () => {
    await reloadProjects();
    await reload();
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <nav className="flex w-56 shrink-0 flex-col gap-4 border-r border-border bg-muted/30 px-3 py-4">
        <div className="flex items-center justify-between px-1">
          <span className="font-display text-base">工作空间看板</span>
          <Button variant="ghost" size="icon" title="切换主题" onClick={toggle}>
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
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
                  onClick={() => select(project.id)}
                  title={broken ? `目录找不到了：${project.root}` : project.root}
                  className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-sm"
                >
                  {broken ? (
                    <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
                  ) : null}
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
          <WorkspaceForms
            onDone={async (id) => {
              await reloadProjects();
              select(id);
            }}
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className="px-2 text-[11px] text-muted-foreground">视图</span>
          {NAV.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setView(key)}
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
      </nav>

      <main className="flex min-w-0 flex-1">
        <ScrollArea className="min-w-0 flex-1" viewportClassName="px-8 py-6">
          {error ? (
            <div className="rounded-lg border border-destructive/40 px-4 py-3 text-sm text-destructive">{error}</div>
          ) : null}

          {!projects.length && !error ? (
            <div className="mx-auto mt-24 max-w-md rounded-lg border border-dashed border-border px-6 py-10 text-center">
              <p className="text-sm">还没有登记工作空间。</p>
              <p className="mt-2 text-xs text-muted-foreground">
                用左边的「添加工作空间」填入目录，或在终端里跑
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
                <OverviewPanel scan={scan} onOpen={setOpenFile} onGoto={setView} />
              ) : null}
              {view === 'input' ? (
                <InputPanel
                  scan={scan}
                  projectId={activeId}
                  openPath={openFile?.path || ''}
                  onOpen={setOpenFile}
                />
              ) : null}
              {view === 'output' ? (
                <OutputPanel scan={scan} openPath={openFile?.path || ''} onOpen={setOpenFile} />
              ) : null}
              {view === 'prototypes' ? <PrototypePanel prototypes={scan.prototypes} /> : null}
            </>
          ) : null}
        </ScrollArea>

        {openFile ? (
          <div className="w-[46%] min-w-[420px] shrink-0">
            <Reader projectId={activeId} item={openFile} onClose={() => setOpenFile(null)} />
          </div>
        ) : null}
      </main>

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
