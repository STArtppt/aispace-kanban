import { useEffect, useState } from 'react';
import { Stamp } from 'lucide-react';
import { toast } from 'sonner';
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
import { api, isUnsupported, type FinalizePickResult, type FinalizeResult } from '@/lib/api';

const NOTE_MAX = 60;

type Picked = Extract<FinalizePickResult, { picked: true }>;

/**
 * 定稿（第十条）：打开即请服务端在本机弹系统选文件框，等待期间显示「请在桌面上选择文件…」；
 * 选中后确认框写清会做什么，用户点「确认定稿」才发写请求。请求里只有令牌和可选备注，没有路径。
 * 取消选择直接关掉；旧服务 404 交给调用方置灰按钮。
 */
export function FinalizeDialog({
  projectId,
  request,
  onClose,
  onUnsupported,
  onDone,
}: {
  projectId: string;
  /** 每次点「定稿」换一个新对象；null = 关着 */
  request: { docKey: string } | null;
  onClose: () => void;
  onUnsupported: () => void;
  onDone: (result: FinalizeResult) => void;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!request) return;
    let alive = true;
    setPicked(null);
    setNote('');
    setError('');
    api.finalizePick(projectId, request.docKey)
      .then((r) => {
        if (!alive) return;
        if (r.picked) setPicked(r);
        else onClose();
      })
      .catch((err: Error) => {
        if (!alive) return;
        if (isUnsupported(err)) onUnsupported();
        else toast.error(err.message);
        onClose();
      });
    return () => {
      alive = false;
    };
    // 只跟着「点了一次定稿」走；回调换引用不该再弹一次选文件框
  }, [projectId, request]);

  const confirm = async () => {
    if (!picked) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.finalizeConfirm(projectId, picked.token, note.trim() || undefined);
      toast.success(`已定稿（第 ${result.count} 次）`, {
        description: result.copiedAs ? `Word 已复制进交付稿目录：${result.copiedAs}` : '用的是交付稿目录里的这份 Word，没有复制',
      });
      onDone(result);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(request)} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>定稿</DialogTitle>
            <DialogDescription>选一份交出去的 Word，记为这份文档的定稿。</DialogDescription>
          </DialogHeader>
          {picked ? (
            <DialogBody className="flex flex-col gap-3 text-sm">
              <div className="flex flex-col gap-1 rounded-md border border-border px-3 py-2">
                <span className="truncate font-medium" title={picked.name}>{picked.name}</span>
                <span className="text-xs text-muted-foreground">
                  {picked.inMirror
                    ? '来自交付稿目录，不复制。'
                    : `来自其他目录，将复制进交付稿目录，命名为 ${picked.copyAs ?? '「原名-定稿时间.docx」'}（不覆盖任何文件）。`}
                </span>
                <span className="text-xs text-muted-foreground">
                  {picked.nextCount <= 1
                    ? '将生成 定稿.md（这份 Word 转出来的文字）。'
                    : `定稿.md 将被覆盖为这份 Word 的内容（第 ${picked.nextCount} 次定稿），之前的记录保留。`}
                </span>
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">备注（可不填）</span>
                <Input
                  value={note}
                  maxLength={NOTE_MAX}
                  placeholder="例如：发给甲方 · 第二轮评审"
                  disabled={busy}
                  onChange={(e) => setNote(e.target.value.replace(/[\r\n]/g, ' '))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !busy) void confirm();
                  }}
                />
              </label>
              <p className="text-xs text-muted-foreground">以 Word 为准，转出来的文字只用来阅读和对比。在 Word 里改过的，请先保存再确认。</p>
              {error ? <p className="whitespace-pre-wrap text-xs text-destructive">{error}</p> : null}
            </DialogBody>
          ) : (
            <DialogBody className="text-sm text-muted-foreground">请在桌面上选择文件…</DialogBody>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button>
            <Button disabled={!picked || busy} onClick={() => void confirm()}>
              <Stamp className="size-3.5" />
              {busy ? '正在定稿…' : '确认定稿'}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
