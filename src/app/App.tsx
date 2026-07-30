import { useEffect, useState } from 'react';
import {
  FolderInput,
  FolderOutput,
  LayoutDashboard,
  MonitorPlay,
  Moon,
  Plus,
  RefreshCw,
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
import { useProjects, useScan } from '@/hooks/useWorkspace';
import { api, type FileItem } from '@/lib/api';
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

function AddProjectForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [root, setRoot] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!root.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api.addProject(root.trim());
      setRoot('');
      setOpen(false);
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button variant="ghost" size="sm" className="justify-start" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        添加工作空间
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-2">
      <Input
        autoFocus
        value={root}
        placeholder="工作空间目录的绝对路径"
        onChange={(e) => setRoot(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
          if (e.key === 'Escape') setOpen(false);
        }}
        className="h-8 text-xs"
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void submit()}>
          添加
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
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
  const { dark, toggle } = useTheme();

  useEffect(() => {
    setOpenFile(null);
  }, [activeId]);

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
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              onClick={() => select(project.id)}
              title={project.root}
              className={cn(
                'truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent',
                project.id === activeId && 'bg-secondary text-secondary-foreground',
              )}
            >
              {project.name}
            </button>
          ))}
          <AddProjectForm onAdded={reloadProjects} />
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

          {scan ? (
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
    </div>
  );
}
