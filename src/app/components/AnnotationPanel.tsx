import { useEffect, useRef, useState } from 'react';
import { Copy, X } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { isDocumentChanged, type Annotation } from '@/hooks/useAnnotations';
import { buildAnnotationPrompt } from '@/lib/annotationPrompt';
import { ScrollArea } from '@/components/ui/scroll-area';

export function AnnotationPanel({
  file,
  mtime,
  notes,
  seenMtime,
  open,
  onClose,
  onUpdate,
  onRemove,
  onClear,
  onKeep,
}: {
  file: string;
  mtime: string;
  notes: Annotation[];
  seenMtime?: string;
  open: boolean;
  onClose: () => void;
  onUpdate: (id: string, comment: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onKeep: (mtime: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const changed = isDocumentChanged(seenMtime, mtime, notes.length);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (!fallback || !fallbackRef.current) return;
    fallbackRef.current.focus();
    fallbackRef.current.select();
  }, [fallback]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const copyPrompt = async () => {
    if (!notes.length) return;
    const text = buildAnnotationPrompt(file, notes);
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setFallback(null);
        return;
      } catch {
        // 落到下面的手动复制
      }
    }
    setFallback(text);
    setCopied(false);
  };

  if (!open) return null;

  const showSheet = notes.length > 0 || changed || Boolean(fallback);

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4 min-[900px]:pr-[calc(200px+1.5rem)] xl:pr-[calc(220px+1.5rem)]"
    >
      <div className="pointer-events-auto flex w-full max-w-[min(28rem,100%)] flex-col items-stretch gap-2">
        {showSheet ? (
          <div className="max-h-64 min-h-0 overflow-hidden rounded-lg border border-border bg-popover shadow-md">
            <ScrollArea className="max-h-64" viewportClassName="p-3">
              {changed ? (
                <Alert className="mb-3">
                  <AlertTitle>这篇文档刚被改动过，批注可能已处理</AlertTitle>
                  <AlertDescription>
                    <p className="mb-2">不清空的话会一直留着，以免误伤还没处理的意见。</p>
                    <div className="flex gap-2">
                      <Button type="button" size="sm" onClick={onClear}>
                        清空
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={() => onKeep(mtime)}>
                        保留
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              ) : null}
              {fallback ? (
                <div className="mb-3 rounded-lg border border-border bg-muted/40 p-2">
                  <p className="mb-2 text-xs text-muted-foreground">
                    当前页面不在安全上下文（用 --host 在局域网地址访问时走普通
                    http），浏览器不允许直接写入剪贴板。下面的文本已选中，请按 ⌘C / Ctrl+C 复制。
                  </p>
                  <Textarea ref={fallbackRef} readOnly rows={8} value={fallback} className="font-mono text-xs" />
                </div>
              ) : null}
              {notes.length ? (
                <ul className="flex flex-col gap-2">
                  {notes.map((note) => (
                    <li key={note.id} className="rounded-lg border border-border bg-card px-3 py-2">
                      <p className="line-clamp-2 text-xs text-muted-foreground">「{note.quote}」</p>
                      {editingId === note.id ? (
                        <div className="mt-2">
                          <Textarea rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} />
                          <div className="mt-2 flex justify-end gap-2">
                            <Button type="button" variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                              取消
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              disabled={!draft.trim()}
                              onClick={() => {
                                onUpdate(note.id, draft.trim());
                                setEditingId(null);
                              }}
                            >
                              保存
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="mt-1 text-sm">{note.comment}</p>
                          <div className="mt-2 flex justify-end gap-2">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setEditingId(note.id);
                                setDraft(note.comment);
                              }}
                            >
                              改
                            </Button>
                            <Button type="button" variant="ghost" size="sm" onClick={() => onRemove(note.id)}>
                              删
                            </Button>
                          </div>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
            </ScrollArea>
          </div>
        ) : null}

        <div className="flex items-center gap-1 rounded-full bg-popover py-1 pr-1 pl-3 shadow-md">
          <span className="text-xs font-medium">批注</span>
          <span className="text-xs text-muted-foreground">{notes.length}</span>
          {notes.length ? (
            <div className="ml-auto flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="rounded-full"
                onClick={() => void copyPrompt()}
              >
                <Copy className="size-3.5" />
                {copied ? '已复制' : '复制提示词'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="rounded-full"
                onClick={onClear}
              >
                清空
              </Button>
            </div>
          ) : (
            <span className="ml-1 min-w-0 flex-1 truncate text-xs text-muted-foreground">
              划选文字即可写下意见
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 rounded-full"
            title="收起批注"
            aria-label="收起批注"
            onClick={onClose}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
