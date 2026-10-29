import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronRight, Folder, FolderInput, Loader2, PencilLine } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import {
  ApiError,
  api,
  type RawDir,
  type RawOrganizePlan,
  type RawOrganizeRequest,
  type RawOrganizeResult,
} from '@/lib/api';
import { cn } from '@/lib/utils';

/** 输入停顿多久再预览：每次预览都要起一次脚本扫 output/，不能每敲一个字就跑 */
const PREVIEW_DEBOUNCE_MS = 300;
const RAW_ROOT = 'input/raw';
/** 目标目录键里表示 input/raw 根的固定值（服务端只认这个，不收路径） */
export const RAW_ROOT_KEY = 'root';

/** 要整理的一项：原始资料里的一个文件或一个目录 */
export interface OrganizeTarget {
  path: string;
  key: string;
  isDir: boolean;
}

export type OrganizeMode = 'rename' | 'move';

function baseName(p: string) {
  return p.slice(p.lastIndexOf('/') + 1);
}

function parentOf(p: string) {
  return p.slice(0, p.lastIndexOf('/'));
}

function splitName(name: string, isDir: boolean) {
  const dot = name.lastIndexOf('.');
  // 目录名整个算名字；文件扩展名不变（脚本按原扩展名补回去）
  return !isDir && dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' };
}

type PreviewState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; plan: RawOrganizePlan; want: string }
  | { state: 'error'; message: string };

/**
 * 原始资料「重命名 / 移动到…」的预览确认弹窗（不变量 1 第十三条）。
 * 预览和执行都由服务端 spawn 工作空间的 `scripts/move_raw.py`，请求只带整理键与新名字或目标目录键。
 * 「确定」只在当前输入的预览成功后可点；拖放到目录上也只是打开这里，不写盘。
 * 执行时脚本按指纹重算，预览后有文件变了会 409，这里自动重新预览。
 */
export function RawOrganizeDialog({
  projectId,
  target,
  mode,
  initialDest,
  dirs,
  onClose,
  onDone,
}: {
  projectId: string;
  /** null = 关着 */
  target: OrganizeTarget | null;
  mode: OrganizeMode;
  /** 拖放时已经选好的目标目录键（`root` 或目录的整理键） */
  initialDest?: string;
  /** 能选的目录：服务端下发的全部目录，不跟随列表筛选 */
  dirs: RawDir[];
  onClose: () => void;
  onDone: (result: RawOrganizeResult) => void;
}) {
  const name = target ? baseName(target.path) : '';
  const { stem, ext } = splitName(name, Boolean(target?.isDir));
  const [newName, setNewName] = useState(stem);
  const [dest, setDest] = useState(initialDest || '');
  const [dirQuery, setDirQuery] = useState('');
  const [preview, setPreview] = useState<PreviewState>({ state: 'idle' });
  const [showFiles, setShowFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState('');
  // 重新预览的触发器：执行撞上「预览后有文件变了」时加一
  const [retry, setRetry] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    setNewName(stem);
    setDest(initialDest || '');
    setDirQuery('');
    setPreview({ state: 'idle' });
    setShowFiles(false);
    setApplyError('');
  }, [target?.path, stem, mode, initialDest]);

  /** 能移过去的目录：根 + 全部目录，去掉自己、自己的子目录和现在所在的目录 */
  const choices = useMemo(() => {
    if (!target) return [];
    const parent = parentOf(target.path);
    const all = [{ path: RAW_ROOT, organizeKey: RAW_ROOT_KEY }, ...dirs];
    return all.filter((d) => d.path !== parent
      && !(target.isDir && (d.path === target.path || d.path.startsWith(`${target.path}/`))));
  }, [dirs, target]);
  const shownChoices = useMemo(() => {
    const q = dirQuery.trim().toLowerCase();
    return q ? choices.filter((d) => d.path.toLowerCase().includes(q)) : choices;
  }, [choices, dirQuery]);
  const destPath = choices.find((d) => d.organizeKey === dest)?.path || '';

  // 当前输入对应的请求；null = 还不能预览（名字没改、没选目录）
  const request: RawOrganizeRequest | null = useMemo(() => {
    if (!target) return null;
    if (mode === 'rename') {
      const wanted = newName.trim();
      return wanted && wanted !== stem ? { key: target.key, name: wanted } : null;
    }
    return dest && destPath ? { key: target.key, destKey: dest } : null;
  }, [target, mode, newName, stem, dest, destPath]);
  const want = request ? JSON.stringify(request) : '';

  useEffect(() => {
    const mine = ++seq.current;
    if (!request) {
      setPreview({ state: 'idle' });
      return undefined;
    }
    setPreview({ state: 'loading' });
    const timer = window.setTimeout(() => {
      api.rawOrganizePreview(projectId, request)
        .then((plan) => {
          if (seq.current === mine) setPreview({ state: 'ready', plan, want });
        })
        .catch((err: unknown) => {
          if (seq.current === mine) {
            setPreview({ state: 'error', message: err instanceof Error ? err.message : String(err) });
          }
        });
    }, mode === 'rename' ? PREVIEW_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
    // request 由 want 唯一决定，依赖 want 免得每次渲染新对象都重跑
  }, [projectId, want, retry, mode]);

  const ready = preview.state === 'ready' && preview.want === want ? preview.plan : null;

  const confirm = async () => {
    if (!request || !ready) return;
    setBusy(true);
    setApplyError('');
    try {
      const result = await api.rawOrganize(projectId, { ...request, plan: ready.plan });
      onDone(result);
      onClose();
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err));
      // 预览之后有文件变了：磁盘没动，按当前内容再算一遍给人看
      if (err instanceof ApiError && err.kind === 'stale') setRetry((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const verb = mode === 'rename' ? '重命名' : '移动';

  return (
    <Dialog
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {verb}「{name}」{target?.isDir ? '目录' : ''}
            </DialogTitle>
            <DialogDescription className="break-all">{target?.path}</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3 text-sm">
            {mode === 'rename' ? (
              <form
                className="flex min-w-0 items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void confirm();
                }}
              >
                <Input
                  autoFocus
                  value={newName}
                  disabled={busy}
                  onValueChange={(value: string) => setNewName(value)}
                  aria-label="新名字"
                  className="min-w-0 flex-1"
                />
                {ext ? <span className="shrink-0 text-muted-foreground">{ext}</span> : null}
              </form>
            ) : (
              <div className="flex min-w-0 flex-col gap-2">
                <Input
                  value={dirQuery}
                  disabled={busy}
                  onValueChange={(value: string) => setDirQuery(value)}
                  placeholder="筛选目录"
                  aria-label="筛选目标目录"
                />
                <div
                  role="listbox"
                  aria-label="目标目录"
                  className="flex max-h-48 min-w-0 flex-col overflow-y-auto rounded-lg border border-border"
                >
                  {shownChoices.length ? (
                    shownChoices.map((d) => (
                      <button
                        key={d.organizeKey}
                        type="button"
                        role="option"
                        aria-selected={dest === d.organizeKey}
                        disabled={busy}
                        onClick={() => setDest(d.organizeKey)}
                        className={cn(
                          'flex min-w-0 items-center gap-2 border-b border-border px-3 py-2 text-left text-xs last:border-b-0 hover:bg-accent',
                          dest === d.organizeKey && 'bg-selected hover:bg-selected',
                        )}
                      >
                        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 break-all">
                          {d.path === RAW_ROOT ? 'input/raw（根）' : d.path.slice(RAW_ROOT.length + 1)}
                        </span>
                      </button>
                    ))
                  ) : (
                    <p className="px-3 py-2 text-xs text-muted-foreground">没有匹配的目录</p>
                  )}
                </div>
              </div>
            )}

            {preview.state === 'loading' ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                正在算要改哪些文件…
              </p>
            ) : preview.state === 'error' ? (
              <p className="whitespace-pre-wrap text-xs text-destructive">{preview.message}</p>
            ) : ready ? (
              <PlanSummary plan={ready} showFiles={showFiles} onToggleFiles={() => setShowFiles((open) => !open)} />
            ) : (
              <p className="text-xs text-muted-foreground">
                {mode === 'rename'
                  ? `只填这一层的名字${ext ? '，扩展名不变' : ''}，仍留在原目录。`
                  : '选一个目标目录，名字不变。'}
                转换产物、台账、忽略规则和别的文档里的链接会一起跟上，确认前不会改动磁盘。
              </p>
            )}

            {applyError ? <p className="whitespace-pre-wrap text-xs text-destructive">{applyError}</p> : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button disabled={busy || !ready} onClick={() => void confirm()}>
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : mode === 'rename' ? (
                <PencilLine className="size-3.5" />
              ) : (
                <FolderInput className="size-3.5" />
              )}
              确定
            </Button>
          </DialogFooter>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}

function PlanSummary({
  plan,
  showFiles,
  onToggleFiles,
}: {
  plan: RawOrganizePlan;
  showFiles: boolean;
  onToggleFiles: () => void;
}) {
  const { ignore } = plan;
  const counts = [
    plan.products.length ? `转换产物 ${plan.products.length} 处跟着搬` : '',
    plan.indexRows ? `台账 ${plan.indexRows} 行` : '',
    plan.links ? `${plan.linkFiles} 个文件中的 ${plan.links} 处路径` : '',
  ].filter(Boolean);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="break-all">
        将{plan.mode === 'rename' ? '改名为' : '移动到'} {plan.to}
        {plan.isDir ? `（连同其下 ${plan.rawFiles} 份文件）` : ''}。
        {counts.length ? `更新：${counts.join('、')}。` : '没有别的文件要跟着改。'}
      </p>
      <ul className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground">
        {plan.renames.map((r) => (
          <li key={r.from} className="break-all">
            {r.from}
            {r.kind === 'dir' ? '/' : ''} → {r.to}
            {r.kind === 'dir' ? '/' : ''}
          </li>
        ))}
        {ignore.rewritten.map((r) => (
          <li key={`ig:${r.from}`} className="break-all">
            忽略规则 {r.from} → {r.to}
          </li>
        ))}
        {ignore.added.map((a) => (
          <li key={`add:${a}`} className="break-all">
            追加忽略规则 {a}（移出原目录后仍保持忽略）
          </li>
        ))}
      </ul>
      {ignore.wildcard.length ? (
        <div className="flex min-w-0 gap-2 rounded-lg border border-destructive/40 p-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0">
            <p>这些忽略规则含通配符，整理后可能不再套用，脚本不会改：</p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {ignore.wildcard.map((w) => (
                <li key={w} className="break-all font-mono">
                  {w}
                </li>
              ))}
            </ul>
            <p className="mt-1">仍点「确定」就按这个结果执行，要保持忽略请事后改 input/.ingestignore。</p>
          </div>
        </div>
      ) : null}
      {plan.files.length ? (
        <div className="flex min-w-0 flex-col gap-1">
          <button
            type="button"
            onClick={onToggleFiles}
            aria-expanded={showFiles}
            className="flex items-center gap-1 text-left text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', showFiles && 'rotate-90')} />
            要改写的 {plan.files.length} 个文件
          </button>
          {showFiles ? (
            <ul className="flex max-h-48 min-w-0 flex-col gap-0.5 overflow-y-auto rounded-lg border border-border bg-muted/40 p-2 text-xs">
              {plan.files.map((f) => (
                <li key={f.path} className="flex min-w-0 items-baseline justify-between gap-3">
                  <span className="min-w-0 break-all">{f.newPath !== f.path ? `${f.path} → ${f.newPath}` : f.path}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {[f.links ? `${f.links} 处` : '', f.sourceSha ? 'source_sha' : ''].filter(Boolean).join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        原件内容不变，input/assets/ 的图片不动。转换产物的 Word 成品不搬：产物换位置后显示「未转 Word」，需要时重新转一次。
        交付稿正文、visualization/、.claude/ 里的提及不改。整理前先停下正在跑的 agent。
      </p>
    </div>
  );
}
