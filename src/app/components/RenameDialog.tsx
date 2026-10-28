import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Loader2, PencilLine } from 'lucide-react';
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
import { ApiError, api, type FileItem, type RenamePlan, type RenameResult } from '@/lib/api';
import { cn } from '@/lib/utils';

/** 输入停顿多久再预览：每次预览都要起一次脚本扫 output/，不能每敲一个字就跑 */
const PREVIEW_DEBOUNCE_MS = 300;

function splitName(name: string) {
  const dot = name.lastIndexOf('.');
  // `.gitkeep` 这种点开头的整个算名字；三组里的隐藏文件本来就不进列表
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' };
}

type PreviewState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; plan: RenamePlan; name: string }
  | { state: 'error'; message: string };

/**
 * 重命名弹窗（不变量 1 第十一条）：填新名字 → 自动预览 → 确定。
 * 预览和执行都由服务端 spawn 工作空间的 `scripts/rename_output.py`，请求只带 docKey 与新基名。
 * 「确定」只在当前输入的预览成功后可点；执行时脚本按指纹重算，预览后有文件变了会 409，这里自动重新预览。
 */
export function RenameDialog({
  projectId,
  item,
  onClose,
  onRenamed,
}: {
  projectId: string;
  /** 要改名的产出文件；null = 关着。必须带 docKey（调用方负责置灰没有键的行） */
  item: FileItem | null;
  onClose: () => void;
  onRenamed: (item: FileItem, result: RenameResult) => void;
}) {
  const { stem, ext } = splitName(item?.name || '');
  const [name, setName] = useState(stem);
  const [preview, setPreview] = useState<PreviewState>({ state: 'idle' });
  const [showFiles, setShowFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState('');
  // 重新预览的触发器：执行撞上「预览后有文件变了」时加一
  const [retry, setRetry] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    setName(stem);
    setPreview({ state: 'idle' });
    setShowFiles(false);
    setApplyError('');
  }, [item?.path, stem]);

  useEffect(() => {
    const wanted = name.trim();
    const mine = ++seq.current;
    if (!item?.docKey || !wanted || wanted === stem) {
      setPreview({ state: 'idle' });
      return undefined;
    }
    setPreview({ state: 'loading' });
    const timer = window.setTimeout(() => {
      api.renamePreview(projectId, { docKey: item.docKey || '', name: wanted })
        .then((plan) => {
          if (seq.current === mine) setPreview({ state: 'ready', plan, name: wanted });
        })
        .catch((err: unknown) => {
          if (seq.current === mine) {
            setPreview({ state: 'error', message: err instanceof Error ? err.message : String(err) });
          }
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [projectId, item?.docKey, name, stem, retry]);

  const ready = preview.state === 'ready' && preview.name === name.trim() ? preview.plan : null;

  const confirm = async () => {
    if (!item?.docKey || !ready) return;
    setBusy(true);
    setApplyError('');
    try {
      const result = await api.renameOutput(projectId, { docKey: item.docKey, name: name.trim(), plan: ready.plan });
      onRenamed(item, result);
      onClose();
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err));
      // 预览之后有文件变了：磁盘没动，按当前内容再算一遍给人看
      if (err instanceof ApiError && err.kind === 'stale') setRetry((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const fileRenames = ready?.renames.length ?? 0;

  return (
    <Dialog
      open={Boolean(item)}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>重命名「{item?.title || item?.name}」</DialogTitle>
            <DialogDescription className="break-all">{item?.path}</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3 text-sm">
            <form
              className="flex min-w-0 items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void confirm();
              }}
            >
              <Input
                autoFocus
                value={name}
                disabled={busy}
                onValueChange={(value: string) => setName(value)}
                aria-label="新名字"
                className="min-w-0 flex-1"
              />
              {ext ? <span className="shrink-0 text-muted-foreground">{ext}</span> : null}
            </form>

            {preview.state === 'loading' ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                正在算要改哪些文件…
              </p>
            ) : preview.state === 'error' ? (
              <p className="whitespace-pre-wrap text-xs text-destructive">{preview.message}</p>
            ) : ready ? (
              <div className="flex min-w-0 flex-col gap-2">
                <p>
                  将改名 {fileRenames} 处，更新 {ready.linkFiles} 个文件中的 {ready.links} 处链接
                  {ready.records.length ? `，在记录 ${ready.records.join('、')} 的状态流水里留痕` : ''}。
                </p>
                <ul className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground">
                  {ready.renames.map((r) => (
                    <li key={r.from} className="break-all">
                      {r.from}
                      {r.kind === 'dir' ? '/' : ''} → {r.to.split('/').pop()}
                      {r.kind === 'dir' ? '/' : ''}
                    </li>
                  ))}
                </ul>
                {ready.files.length ? (
                  <div className="flex min-w-0 flex-col gap-1">
                    <button
                      type="button"
                      onClick={() => setShowFiles((open) => !open)}
                      aria-expanded={showFiles}
                      className="flex items-center gap-1 text-left text-xs text-muted-foreground hover:text-foreground"
                    >
                      <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', showFiles && 'rotate-90')} />
                      要改写的 {ready.files.length} 个文件
                    </button>
                    {showFiles ? (
                      <ul className="flex max-h-48 min-w-0 flex-col gap-0.5 overflow-y-auto rounded-lg border border-border bg-muted/40 p-2 text-xs">
                        {ready.files.map((f) => (
                          <li key={f.path} className="flex min-w-0 items-baseline justify-between gap-3">
                            <span className="min-w-0 break-all">{f.path}</span>
                            <span className="shrink-0 text-muted-foreground">
                              {[
                                f.links ? `${f.links} 处` : '',
                                f.sourceSha ? 'source_sha' : '',
                                f.flow ? '留痕' : '',
                              ].filter(Boolean).join(' · ')}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  交付稿正文、input/、output/converted/、visualization/、.claude/ 里的提及不改。
                  改名前先停下正在跑的 agent；要撤销就再改一次名。
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                只填名字本身，扩展名不变。交付稿、定稿、Word 成品、记录、批注和别的文档里的链接会一起改。
              </p>
            )}

            {applyError ? <p className="whitespace-pre-wrap text-xs text-destructive">{applyError}</p> : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button disabled={busy || !ready} onClick={() => void confirm()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <PencilLine className="size-3.5" />}
              确定
            </Button>
          </DialogFooter>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
