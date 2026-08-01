import { useEffect, useState } from 'react';
import { AlertTriangle, FolderSearch, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogPortal,
  DialogBackdrop,
  DialogTitle,
} from '@/components/ui/dialog';
import { useFileManagerName } from '@/hooks/useFileManager';
import { api, type Project, type RelinkCandidate } from '@/lib/api';
import { formatRelative } from '@/lib/format';

/**
 * 登记条目的增删改闭环都在这里。
 *
 * 看板对工作空间只读这条约束不变：这里改的、删的都只是 ~/.pmwork/dashboard/projects.json
 * 里的登记信息，本地目录一个字节都不动。文案上必须说清楚，否则「删除」两个字很吓人。
 */
export function WorkspaceDialog({
  project,
  open,
  onOpenChange,
  onSaved,
  onRemoved,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  onRemoved: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [root, setRoot] = useState(project.root);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fileManager = useFileManagerName();

  // 每次打开都从当前登记信息重置，避免上一次的半截编辑残留
  useEffect(() => {
    if (!open) return;
    setName(project.name);
    setRoot(project.root);
    setError('');
    setConfirmRemove(false);
  }, [open, project.name, project.root]);

  const dirty = name.trim() !== project.name || root.trim() !== project.root;

  const save = async () => {
    if (!dirty || !name.trim() || !root.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api.updateProject(project.id, { name: name.trim(), root: root.trim() });
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await api.removeProject(project.id);
      onOpenChange(false);
      onRemoved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>工作空间设置</DialogTitle>
            <DialogDescription>
              改的是看板里的登记信息，不会动本地目录里的任何文件。
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">显示名称</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">目录绝对路径</span>
              <Input
                value={root}
                onChange={(e) => setRoot(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void save()}
                className="h-9 font-mono text-xs"
              />
              <span className="text-[11px] text-muted-foreground">
                在{fileManager}里改了文件夹名或挪了位置，把新路径填这里就能接回来。历史记录和当前选中状态都保留。
              </span>
            </label>

            {project.status && !project.status.ok ? (
              <p className="flex items-start gap-1.5 text-xs text-destructive">
                <AlertTriangle className="mt-px size-3.5 shrink-0" />
                当前路径无效：{project.status.reasons.join('、')}
              </p>
            ) : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </DialogBody>

          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button disabled={busy || !dirty} onClick={() => void save()}>
              保存
            </Button>
          </DialogFooter>

          <div className="mt-1 flex flex-col gap-2 border-t border-border pt-4">
            {confirmRemove ? (
              <>
                <p className="text-sm">
                  确定把「{project.name}」移出看板？
                </p>
                <p className="text-xs text-muted-foreground">
                  只删除看板里的这条登记，本地目录
                  <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{project.root}</code>
                  及其中所有文件都会原样留在硬盘上。之后想看，用「登记已有目录」再加回来就行。
                </p>
                <div className="flex gap-2">
                  <Button variant="danger" size="sm" disabled={busy} onClick={() => void remove()}>
                    确定移出
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
                    再想想
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  项目归档了，不想在看板里看到它
                </span>
                <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(true)}>
                  <Trash2 className="size-3.5" />
                  移出看板
                </Button>
              </div>
            )}
          </div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}

/**
 * 目录扫不到时占住主区。
 * 不能让用户看到一份空清单还以为工作空间是空的 —— 那正是改名后最容易误会的地方。
 */
export function UnavailableWorkspace({
  project,
  reasons,
  onSettings,
  onRelinked,
}: {
  project: { id: string; name: string; root: string };
  reasons: string[];
  onSettings: () => void;
  onRelinked: () => void;
}) {
  const [candidates, setCandidates] = useState<RelinkCandidate[]>([]);
  const fileManager = useFileManagerName();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setCandidates([]);
    setError('');
    api
      .candidates(project.id)
      .then((data) => alive && setCandidates(data.candidates))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [project.id]);

  const relink = async (root: string) => {
    setBusy(root);
    setError('');
    try {
      await api.updateProject(project.id, { root });
      onRelinked();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="mx-auto mt-16 max-w-2xl">
      <div className="rounded-lg border border-destructive/40 bg-card px-6 py-5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium">「{project.name}」的目录找不到了</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {reasons.length ? reasons.join('、') : '目录不存在'}
              —— 多半是在{fileManager}里改了文件夹名，或者把它挪到别处了。看板只按登记的绝对路径找工作空间，
              路径变了就得告诉它新位置。
            </p>
            <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">
              登记路径 {project.root}
            </p>
          </div>
        </div>

        {candidates.length ? (
          <div className="mt-5">
            <p className="text-xs text-muted-foreground">
              同一个父目录下找到这些还没登记过的工作空间，是不是改成了其中一个：
            </p>
            <div className="mt-2 overflow-hidden rounded-md border border-border">
              {candidates.map((candidate) => (
                <div
                  key={candidate.root}
                  className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
                >
                  <FolderSearch className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{candidate.name}</p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">{candidate.root}</p>
                  </div>
                  {candidate.mtime ? (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {formatRelative(candidate.mtime)}
                    </span>
                  ) : null}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={Boolean(busy)}
                    onClick={() => void relink(candidate.root)}
                  >
                    就是它
                  </Button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}

        <div className="mt-5 flex items-center gap-2">
          <Button size="sm" onClick={onSettings}>
            手动填新路径
          </Button>
          <span className="text-xs text-muted-foreground">
            或者在同一个弹窗里把它移出看板（不会删本地文件）
          </span>
        </div>
      </div>
    </div>
  );
}
