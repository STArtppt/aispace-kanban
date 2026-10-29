import { useEffect, useRef, useState } from 'react';
import { CopyPlus, Loader2 } from 'lucide-react';
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
import {
  ApiError,
  api,
  type ConvertedCopyGroup,
  type ConvertedCopyPlan,
  type ConvertedCopyResult,
  type FileItem,
} from '@/lib/api';
import { cn } from '@/lib/utils';

const TARGETS: { key: ConvertedCopyGroup; label: string; hint: string }[] = [
  { key: 'analysis', label: '分析产物', hint: '当分析底稿继续写' },
  { key: 'decisions', label: '决策记录', hint: '整理成一条决策' },
  { key: 'docs', label: '交付文档', hint: '改成要交出去的文档' },
];

type PreviewState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; plan: ConvertedCopyPlan }
  | { state: 'error'; message: string };

/**
 * 转换产物「复制到…」弹窗（不变量 1 第十二条）：三选一 → 自动预览落点 → 确定。
 * 预览和执行都由服务端 spawn 工作空间的 `scripts/copy_converted.py`，请求只带 docKey 与组名。
 * 落点已存在时「确定」不可点；执行时脚本再查一次，被人抢先建了同名文件会 409，这里自动重新预览。
 */
export function ConvertedCopyDialog({
  projectId,
  item,
  onClose,
  onCopied,
}: {
  projectId: string;
  /** 要复制的转换产物；null = 关着。必须带 docKey（调用方只给带键的行出入口） */
  item: FileItem | null;
  onClose: () => void;
  onCopied: (result: ConvertedCopyResult) => void;
}) {
  const [group, setGroup] = useState<ConvertedCopyGroup | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ state: 'idle' });
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState('');
  // 重新预览的触发器：执行撞上冲突时加一
  const [retry, setRetry] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    setGroup(null);
    setPreview({ state: 'idle' });
    setApplyError('');
  }, [item?.path]);

  useEffect(() => {
    const mine = ++seq.current;
    if (!item?.docKey || !group) {
      setPreview({ state: 'idle' });
      return;
    }
    setPreview({ state: 'loading' });
    api.convertedCopyPreview(projectId, { docKey: item.docKey, group })
      .then((plan) => {
        if (seq.current === mine) setPreview({ state: 'ready', plan });
      })
      .catch((err: unknown) => {
        if (seq.current === mine) {
          setPreview({ state: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      });
  }, [projectId, item?.docKey, group, retry]);

  const ready = preview.state === 'ready' && preview.plan.group === group ? preview.plan : null;
  const canConfirm = Boolean(ready && !ready.conflict);

  const confirm = async () => {
    if (!item?.docKey || !group || !canConfirm) return;
    setBusy(true);
    setApplyError('');
    try {
      const result = await api.convertedCopy(projectId, { docKey: item.docKey, group });
      onCopied(result);
      onClose();
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err));
      // 预览之后落点被人占了：磁盘没动，重新预览把冲突显示出来
      if (err instanceof ApiError && err.kind === 'conflict') setRetry((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

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
            <DialogTitle>复制「{item?.title || item?.name}」</DialogTitle>
            <DialogDescription className="break-all">{item?.path}</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3 text-sm">
            <div role="radiogroup" aria-label="复制到" className="flex flex-col gap-1">
              {TARGETS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="radio"
                  aria-checked={group === t.key}
                  disabled={busy}
                  onClick={() => {
                    setApplyError('');
                    setGroup(t.key);
                  }}
                  className={cn(
                    'flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors',
                    group === t.key ? 'border-foreground bg-accent' : 'border-border hover:bg-accent/60',
                  )}
                >
                  <span className="truncate">{t.label}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{t.hint}</span>
                </button>
              ))}
            </div>

            {preview.state === 'loading' ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                正在算落点…
              </p>
            ) : preview.state === 'error' ? (
              <p className="whitespace-pre-wrap text-xs text-destructive">{preview.message}</p>
            ) : ready?.conflict ? (
              <p className="break-all text-xs text-destructive">
                已存在 {ready.conflictPath}，不能复制到这里。换一组，或者先把那份改名。
              </p>
            ) : ready ? (
              <div className="flex min-w-0 flex-col gap-1">
                <p className="break-all">将复制到 {ready.target}</p>
                <p className="text-xs text-muted-foreground">
                  {ready.rewrittenLinks
                    ? `会按新位置重算 ${ready.rewrittenLinks} 处链接，仍指向原来的文件。`
                    : '链接不用改，在新位置照样指向原来的文件。'}
                  图片不复制，继续用 input/assets/ 里那份。
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                复制件放进所选组里同样的子目录，front-matter 记下它从哪份转换产物复制来。
                转换产物本身不动，以后重新转换也不会改到复制件。
              </p>
            )}

            {applyError ? <p className="whitespace-pre-wrap text-xs text-destructive">{applyError}</p> : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button disabled={busy || !canConfirm} onClick={() => void confirm()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <CopyPlus className="size-3.5" />}
              确定
            </Button>
          </DialogFooter>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
