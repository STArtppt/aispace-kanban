import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Copy, Check, List, SquareDashedMousePointer, TextSelect, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { HeaderIconButton, writeClipboard } from '@/components/Primitives';
import { isDocumentChanged, type Annotation } from '@/hooks/useAnnotations';
import type { AnnotationSession } from '@/hooks/useAnnotationSession';
import { useNoteHistory } from '@/hooks/useNoteHistory';
import { buildAnnotationPrompt } from '@/lib/annotationPrompt';
import { formatRelative } from '@/lib/format';
import type { NoteHistoryItem } from '@/lib/api';
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
  projectId,
  file,
  mtime,
  notes,
  seenMtime,
  session,
  onRemove,
  onClear,
}: {
  projectId: string;
  file: string;
  mtime: string;
  notes: Annotation[];
  seenMtime?: string;
  session: AnnotationSession;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const changed = isDocumentChanged(seenMtime, mtime, notes.length);
  const { batches, append, clear } = useNoteHistory(projectId, file);
  const historyCount = batches.reduce((n, batch) => n + batch.notes.length, 0);
  const lastArchive = useRef('');
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

  // 文档一变就把当前这批收进历史、清掉页面标记。不管 AI 改全了没有。
  useEffect(() => {
    if (!changed || !notes.length) return;
    const token = `${file}\0${mtime}\0${notes.map((note) => note.id).join(',')}`;
    if (lastArchive.current === token) return;
    lastArchive.current = token;
    const snapshot: NoteHistoryItem[] = notes.map((note, index) => ({
      quote: note.quote,
      comment: note.comment,
      structure: note.structure,
      start: note.start,
      end: note.end,
      number: index + 1,
    }));
    const count = snapshot.length;
    void (async () => {
      try {
        await append(snapshot);
        onClear();
        say(`文档已改动，本批 ${count} 条批注已收入历史，页面上的标记已清掉。`);
      } catch (err) {
        onClear();
        say(`文档已改动，标记已清掉。这一批没写进历史：${(err as Error).message}`, 'warn');
      }
    })();
  }, [append, changed, file, mtime, notes, onClear, say]);

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
      {panelOpen ? (
        <div className={cn(CARD, SURFACE, 'max-h-96 min-h-0 overflow-hidden')}>
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-sm font-medium">
              批注清单
              {notes.length ? ` · 当前 ${notes.length}` : ''}
              {historyCount ? ` · 历史 ${historyCount}` : ''}
            </span>
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
          <ScrollArea className="max-h-[20rem]" viewportClassName="p-3">
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
                {batches.length
                  ? '当前没有批注。点正文里的一块继续批；下面是已经收入历史的批次。'
                  : '还没有批注。点正文里的一块，或切到「选中文字」划一段。'}
              </p>
            )}
            {batches.length ? (
              <div className={cn(notes.length ? 'mt-3 border-t border-border pt-3' : 'mt-3')}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">历史</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      void clear().catch((err) =>
                        say(`历史没清掉：${(err as Error).message}`, 'warn'),
                      );
                    }}
                  >
                    清空历史
                  </Button>
                </div>
                <ul className="flex flex-col gap-3">
                  {batches.map((batch) => (
                    <li key={batch.id} className="flex flex-col gap-2">
                      <p className="text-xs text-muted-foreground">
                        {formatRelative(batch.archivedAt)} · {batch.notes.length} 条
                      </p>
                      {batch.notes.map((note, index) => (
                        <div
                          key={`${batch.id}-${note.number ?? index}`}
                          className="rounded-lg border border-border bg-muted/40 px-3 py-2"
                        >
                          <span className="text-xs font-medium">
                            {note.number ?? index + 1}. {note.structure}
                          </span>
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                            「{note.quote}」
                          </p>
                          <p className="mt-1 text-sm">{note.comment}</p>
                        </div>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
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

      {!notes.length && !panelOpen && !toast ? (
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
