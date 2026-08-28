import { useEffect, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/Primitives';
import { isDocumentChanged, type Annotation } from '@/hooks/useAnnotations';
import { buildAnnotationPrompt } from '@/lib/annotationPrompt';
import { ScrollArea } from '@/components/ui/scroll-area';

export function AnnotationPanel({
  file,
  mtime,
  notes,
  seenMtime,
  onUpdate,
  onRemove,
  onClear,
  onKeep,
}: {
  file: string;
  mtime: string;
  notes: Annotation[];
  seenMtime?: string;
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

  return (
    <div className="flex max-h-64 min-h-0 shrink-0 flex-col border-t border-border bg-background">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-xs font-medium">批注</span>
        <span className="text-xs text-muted-foreground">{notes.length}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!notes.length}
            onClick={() => void copyPrompt()}
          >
            <Copy className="size-3.5" />
            {copied ? '已复制' : '复制提示词'}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={!notes.length} onClick={onClear}>
            清空批注
          </Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-3 pb-3">
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
        {!notes.length ? (
          <EmptyState title="还没有批注" hint="在预览里划选一段文字，即可写下意见。" />
        ) : (
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
        )}
      </ScrollArea>
    </div>
  );
}
