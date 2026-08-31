import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Copy, Check, List, SquareDashedMousePointer, TextSelect, Trash2, X } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { HeaderIconButton, writeClipboard } from '@/components/Primitives';
import { isDocumentChanged, type Annotation } from '@/hooks/useAnnotations';
import type { AnnotationSession } from '@/hooks/useAnnotationSession';
import { buildAnnotationPrompt } from '@/lib/annotationPrompt';
import { cn } from '@/lib/utils';

/** 浮层统一宽度：够放下一条批注，又不至于把正文盖掉半边。 */
const CARD = 'pointer-events-auto w-[min(22rem,calc(100vw-2rem))]';
const SURFACE = 'rounded-lg border border-border bg-popover shadow-md';

/**
 * 批注胶囊 —— 形态与相邻仓 annotation-collect 的采集款一条线：
 * 一条贴右下角的水平胶囊，按钮仅图标 + tooltip，三组之间用竖线分开。
 *
 * 三组的分工：**选取元素 / 选中文字**（怎么选）· **复制 / 清空**（这一批怎么出去）·
 * **清单 / 收起**（看和退）。胶囊不出现 = 批注交互整个不存在，正文就是拿来读的。
 */
export function AnnotationToolbar({
  file,
  mtime,
  notes,
  seenMtime,
  session,
  onRemove,
  onClear,
  onKeep,
}: {
  file: string;
  mtime: string;
  notes: Annotation[];
  seenMtime?: string;
  session: AnnotationSession;
  onRemove: (id: string) => void;
  onClear: () => void;
  onKeep: (mtime: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const changed = isDocumentChanged(seenMtime, mtime, notes.length);
  const { active, mode, setMode, panelOpen, setPanelOpen, toast, say } = session;

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
    if (active) return;
    setFallback(null);
    setCopied(false);
  }, [active]);

  if (!active) return null;

  const copyPrompt = async () => {
    if (!notes.length) return;
    const text = buildAnnotationPrompt(file, notes);
    if (await writeClipboard(text)) {
      setCopied(true);
      setFallback(null);
      say(`已复制 ${notes.length} 条批注的提示词，粘给你的 agent 就行。`);
      return;
    }
    // 非安全上下文（--host 起在局域网地址上走普通 http）拿不到剪贴板，退回手动复制
    setFallback(text);
    setCopied(false);
    say('浏览器不让直接写剪贴板，下面的文本已选中，按 ⌘C / Ctrl+C 复制。', 'warn');
  };

  return (
    <div
      className={cn(
        'pointer-events-none absolute right-4 bottom-4 z-20 flex flex-col items-end gap-2',
        // 让开右侧的目录轨，别压在章节列表上
        'min-[900px]:right-[calc(200px+1.5rem)] xl:right-[calc(220px+1.5rem)]',
      )}
    >
      {changed ? (
        <Alert className={cn(CARD, 'bg-popover shadow-md')}>
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

      {panelOpen ? (
        <div className={cn(CARD, SURFACE, 'max-h-72 min-h-0 overflow-hidden')}>
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-sm font-medium">批注清单 · {notes.length} 条</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setPanelOpen(false)}
            >
              关闭
            </Button>
          </div>
          <ScrollArea className="max-h-[15rem]" viewportClassName="p-3">
            {notes.length ? (
              <ul className="flex flex-col gap-2">
                {notes.map((note, index) => (
                  <li key={note.id} className="rounded-lg border border-border bg-card px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-medium">
                        {index + 1}. {note.structure}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => session.ask(note.id, 'focus')}
                        >
                          定位
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => session.ask(note.id, 'edit')}
                        >
                          改
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                          onClick={() => onRemove(note.id)}
                        >
                          删
                        </Button>
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">「{note.quote}」</p>
                    <p className="mt-1 text-sm">{note.comment}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">
                还没有批注。点正文里的一块，或切到「选中文字」划一段。
              </p>
            )}
          </ScrollArea>
        </div>
      ) : null}

      {fallback ? (
        <div className={cn(CARD, SURFACE, 'p-3')}>
          <p className="mb-2 text-xs text-muted-foreground">
            当前页面不在安全上下文（用 --host 在局域网地址访问时走普通
            http），浏览器不允许直接写入剪贴板。下面的文本已选中，请按 ⌘C / Ctrl+C 复制。
          </p>
          <Textarea ref={fallbackRef} readOnly rows={8} value={fallback} className="font-mono text-xs" />
          <div className="mt-2 flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={() => setFallback(null)}>
              知道了
            </Button>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div
          role="status"
          className={cn(
            CARD,
            SURFACE,
            'px-3 py-2 text-xs',
            toast.tone === 'warn' ? 'border-destructive text-destructive' : 'text-muted-foreground',
          )}
        >
          {toast.text}
        </div>
      ) : null}

      {!notes.length && !panelOpen ? (
        <p className={cn(CARD, SURFACE, 'px-3 py-2 text-xs text-muted-foreground')}>
          点正文里的一块就能批注；要精确到某几个字，切到「选中文字」再划。
        </p>
      ) : null}

      <div className="pointer-events-auto flex items-center gap-0.5 rounded-full bg-popover p-1 shadow-md">
        <CapsuleButton
          label="选取元素"
          pressed={mode === 'pick-element'}
          onClick={() => setMode('pick-element')}
        >
          <SquareDashedMousePointer className="size-4" />
        </CapsuleButton>
        <CapsuleButton
          label="选中文字"
          pressed={mode === 'select-text'}
          onClick={() => setMode('select-text')}
        >
          <TextSelect className="size-4" />
        </CapsuleButton>

        <Separator />

        <CapsuleButton
          label={copied ? '已复制' : '复制提示词'}
          disabled={!notes.length}
          onClick={() => void copyPrompt()}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </CapsuleButton>
        <CapsuleButton label="清空批注" disabled={!notes.length} onClick={onClear}>
          <Trash2 className="size-4" />
        </CapsuleButton>

        <Separator />

        <CapsuleButton
          label="批注清单"
          pressed={panelOpen}
          badge={notes.length}
          onClick={() => setPanelOpen(!panelOpen)}
        >
          <List className="size-4" />
        </CapsuleButton>
        <CapsuleButton label="收起批注" onClick={() => session.setActive(false)}>
          <X className="size-4" />
        </CapsuleButton>
      </div>
    </div>
  );
}

function Separator() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />;
}

/**
 * 胶囊上的一个仅图标按钮。
 *
 * 选中态用墨黑底（`--primary`），不上彩色 —— 整套系统里 orange 只留给"需要注意"。
 * 文案不消失，它挪进 tooltip，`aria-label` 上也留一份。
 */
function CapsuleButton({
  label,
  pressed,
  disabled,
  badge = 0,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  badge?: number;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <HeaderIconButton
      label={label}
      pressed={pressed}
      disabled={disabled}
      className={cn(
        'relative size-8 rounded-full',
        pressed && 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground',
      )}
      onClick={onClick}
    >
      {children}
      {badge > 0 ? (
        <span
          className={cn(
            'absolute -top-0.5 -right-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full border border-popover px-0.5 text-[10px] leading-none',
            // 按钮按下时底色也是墨黑，角标得反过来才看得见
            pressed ? 'bg-background text-foreground' : 'bg-primary text-primary-foreground',
          )}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </HeaderIconButton>
  );
}
