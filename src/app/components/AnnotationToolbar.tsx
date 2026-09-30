import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Copy, Check, List, SquareDashedMousePointer, TextSelect, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { HeaderIconButton, writeClipboard } from '@/components/Primitives';
import { isDocumentChanged, type Annotation } from '@/hooks/useAnnotations';
import type { AnnotationSession } from '@/hooks/useAnnotationSession';
import { useNoteHistory } from '@/hooks/useNoteHistory';
import { buildAnnotationPrompt, type PromptNote } from '@/lib/annotationPrompt';
import { formatRelative } from '@/lib/format';
import { ApiError, type NoteHistoryItem } from '@/lib/api';
import { deliveryOf } from '@/lib/deaiPrompt';
import { cn } from '@/lib/utils';

/** 浮层统一宽度：够放下一条批注，又不至于把正文盖掉半边。 */
const CARD = 'pointer-events-auto w-[min(22rem,calc(100vw-2rem))]';
const SURFACE = 'rounded-lg border border-border bg-popover shadow-md';

const STATUS_LABEL: Record<string, string> = {
  pending: '待处理',
  adopted: '已采纳',
  rejected: '未采纳',
  unclear: '待确认',
};

function statusLabel(status: string) {
  return STATUS_LABEL[status] ?? status;
}

/** 回执里去掉沉淀标记（标记另外显示成标签） */
function stripDeposits(receipt: string) {
  return receipt.replace(/沉淀为\s*R\d{3}\s*[（(]规则库\s*v\d+[)）][。；;，,\s]*/g, '').trim() || '（只有沉淀标记）';
}

function fingerprintOf(notes: Array<{ start: number; end: number; quote: string; comment: string }>) {
  return notes.map((note) => `${note.start},${note.end}\0${note.quote}\0${note.comment}`).join('\n');
}

function explainSaveFailure(err: unknown): string {
  const status = err instanceof ApiError ? err.status : 0;
  const message = err instanceof Error ? err.message : '写入失败';
  if (status === 403) {
    return '这次没有落盘，agent 无处回写。服务没有监听在本机地址上，不能往工作空间写批注。';
  }
  if (status === 404) {
    return `这次没有落盘，agent 无处回写。${message}`;
  }
  return `这次没有落盘，agent 无处回写。${message}`;
}

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
  delivery,
  onOpenDeaiRule,
}: {
  projectId: string;
  file: string;
  mtime: string;
  notes: Annotation[];
  seenMtime?: string;
  session: AnnotationSession;
  onRemove: (id: string) => void;
  onClear: () => void;
  /** 正在批注某一版交付稿：提示词换成「以它为底改出下一版 + 同步沉淀」 */
  delivery?: { version: string; nextPath: string; rulesVersion?: number };
  /** 回执里的沉淀标签被点中 */
  onOpenDeaiRule?: (rule: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const changed = isDocumentChanged(seenMtime, mtime, notes.length);
  const { batches, recordId, noteFile, noteFileBroken, noteFileReason, ready, load, append, save, clear } =
    useNoteHistory(projectId, file);
  const historyCount = batches.reduce((n, batch) => n + batch.notes.length, 0);
  const pendingNotes = batches.flatMap((batch) =>
    batch.source === 'workspace' ? batch.notes.filter((note) => note.status === 'pending' && note.noteId) : [],
  );
  const hasWorkspaceNotes = pendingNotes.length > 0 || batches.some((batch) => batch.source === 'workspace');
  // 旧服务的批次没有 source，清的就是缓存，按钮保持可点
  const cacheCount = batches.filter((batch) => batch.source !== 'workspace').length;
  const lastClear = useRef('');
  const persisted = useRef(new Set<string>());
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

  // 文档一变只清页面标记。坐标已经对不上了，批注在点「复制提示词」时就该落过盘。
  useEffect(() => {
    if (!changed || !notes.length) return;
    const token = `${file}\0${mtime}\0${notes.map((note) => note.id).join(',')}`;
    if (lastClear.current === token) return;
    lastClear.current = token;
    const saved = persisted.current.has(`${file}\0${fingerprintOf(notes)}`);
    const count = notes.length;
    onClear();
    if (saved) {
      say(`文档已改动，页面上的 ${count} 条标记已清掉。已经落盘的批注还在清单里。`);
    } else {
      say(`文档已改动，页面上的 ${count} 条标记已清掉。这一批没有落过盘，已经无法找回。`, 'warn');
    }
  }, [changed, file, mtime, notes, onClear, say]);

  if (!active) return null;

  const snapshotOf = (): NoteHistoryItem[] =>
    notes.map((note, index) => ({
      quote: note.quote,
      comment: note.comment,
      structure: note.structure,
      start: note.start,
      end: note.end,
      number: index + 1,
    }));

  const publish = async (text: string, okMessage: string) => {
    if (await writeClipboard(text)) {
      setCopied(true);
      setFallback(null);
      say(okMessage);
      return;
    }
    // 非安全上下文（--host 起在局域网地址上走普通 http）拿不到剪贴板，退回手动复制
    setFallback(text);
    setCopied(false);
    say('浏览器不让直接写剪贴板，下面的文本已选中，按 ⌘C / Ctrl+C 复制。', 'warn');
  };

  const copyPrompt = async () => {
    if (!notes.length) return;
    const snapshot = snapshotOf();
    let currentRecordId = recordId;
    let currentNoteFile = noteFile;
    let settled = ready;
    if (!settled) {
      const data = await load();
      settled = true;
      currentRecordId = data && 'recordId' in data ? data.recordId : undefined;
      currentNoteFile = data?.noteFile;
    }

    let promptNotes: PromptNote[] = snapshot.map((note) => ({
      start: note.start ?? 0,
      end: note.end ?? 0,
      quote: note.quote,
      comment: note.comment,
      structure: note.structure,
      number: note.number,
    }));
    let saved = false;
    let reason = '';

    if (currentRecordId) {
      try {
        const result = await save(snapshot, currentRecordId);
        saved = true;
        currentNoteFile = result.noteFile || currentNoteFile;
        promptNotes = promptNotes.map((note, index) => {
          const item = result.items.find((entry) => entry.number === index + 1) ?? result.items[index];
          return item?.noteId ? { ...note, noteId: item.noteId } : note;
        });
        persisted.current.add(`${file}\0${fingerprintOf(notes)}`);
      } catch (err) {
        reason = explainSaveFailure(err);
      }
    } else if (settled && currentRecordId === null) {
      try {
        await append(snapshot);
        persisted.current.add(`${file}\0${fingerprintOf(notes)}`);
        reason = delivery
          ? '原稿还没有产出物记录，交付稿上的批注暂存在看板缓存里。让 agent 先给原稿建记录，之后可以迁过去。这次没有落进工作空间，agent 无处回写。'
          : '这份还没有产出物记录，批注暂存在看板缓存里。让 agent 建一份记录之后可以迁过去。这次没有落进工作空间，agent 无处回写。';
      } catch (err) {
        reason = explainSaveFailure(err);
      }
    } else {
      try {
        await append(snapshot);
        persisted.current.add(`${file}\0${fingerprintOf(notes)}`);
      } catch (err) {
        reason = explainSaveFailure(err);
      }
    }

    const text = buildAnnotationPrompt(file, promptNotes, {
      noteFile: saved ? currentNoteFile : undefined,
      saved,
      reason: saved ? undefined : reason,
      delivery,
    });
    const okMessage = saved
      ? `已复制 ${notes.length} 条批注的提示词，并写入 ${currentNoteFile}。粘给你的 agent 就行。`
      : `已复制 ${notes.length} 条批注的提示词。${reason}`;
    await publish(text, okMessage);
  };

  const recopyPending = async () => {
    if (!pendingNotes.length) return;
    const promptNotes: PromptNote[] = pendingNotes.map((note) => ({
      start: note.start ?? 0,
      end: note.end ?? 0,
      quote: note.quote,
      comment: note.comment,
      structure: note.structure,
      number: note.number,
      noteId: note.noteId,
    }));
    const text = buildAnnotationPrompt(file, promptNotes, {
      noteFile,
      saved: Boolean(noteFile),
      resend: true,
      delivery,
    });
    await publish(text, `已复制 ${pendingNotes.length} 条还没处理的批注。区间可能已经失效，提示词里写了以原文为准。`);
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
          <div className="border-b border-border px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">
                批注清单
                {notes.length ? ` · 当前 ${notes.length}` : ''}
                {historyCount ? ` · 已落盘 ${historyCount}` : ''}
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
            {hasWorkspaceNotes ? (
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {pendingNotes.length ? `还有 ${pendingNotes.length} 条待处理` : '没有待处理的批注'}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={!pendingNotes.length}
                  onClick={() => void recopyPending()}
                >
                  把未处理的重新复制
                </Button>
              </div>
            ) : null}
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
            {ready && recordId === null ? (
              <p className={cn('text-xs text-muted-foreground', notes.length || batches.length ? 'mt-3' : '')}>
                这份还没有产出物记录，批注暂存在看板缓存里。让 agent 建一份记录之后可以迁过去。
              </p>
            ) : null}
            {noteFileBroken ? (
              <p className={cn('text-xs text-destructive', notes.length || batches.length ? 'mt-3' : '')}>
                批注文件读不出来{noteFileReason ? `：${noteFileReason}` : ''}。下面只显示还能读到的批次。
              </p>
            ) : null}
            {batches.length ? (
              <div className={cn(notes.length ? 'mt-3 border-t border-border pt-3' : 'mt-3')}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">已落盘</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={cacheCount === 0}
                    onClick={() => {
                      void clear().catch((err) =>
                        say(`缓存没清掉：${(err as Error).message}`, 'warn'),
                      );
                    }}
                  >
                    清空缓存
                  </Button>
                </div>
                <p className="mb-2 text-xs text-muted-foreground">
                  {cacheCount
                    ? '清空缓存只删看板缓存里的批次，工作空间里的批注文件不动。'
                    : '这些批注在工作空间里，看板清不了。要删就在文件系统里删这份批注文件。'}
                </p>
                <ul className="flex flex-col gap-3">
                  {batches.map((batch) => (
                    <li key={batch.id} className="flex flex-col gap-2">
                      <p className="text-xs text-muted-foreground">
                        {formatRelative(batch.archivedAt)} · {batch.notes.length} 条
                        {batch.source === 'workspace' ? ' · 工作空间' : batch.source === 'cache' ? ' · 看板缓存' : ''}
                        {batch.target && deliveryOf(batch.target) ? ` · 交付稿 ${deliveryOf(batch.target)?.version}` : ''}
                      </p>
                      {batch.notes.map((note, index) => (
                        <div
                          key={`${batch.id}-${note.noteId ?? note.number ?? index}`}
                          className="rounded-lg border border-border bg-muted/40 px-3 py-2"
                        >
                          <span className="text-xs font-medium">
                            {note.noteId ? note.noteId : `${note.number ?? index + 1}.`} {note.structure}
                            {note.status ? ` · ${statusLabel(note.status)}` : ''}
                            {note.migrated ? ' · 迁移' : ''}
                          </span>
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                            「{note.quote}」
                          </p>
                          <p className="mt-1 text-sm">{note.comment}</p>
                          {note.receipt ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                              回执：{note.deposits?.length ? stripDeposits(note.receipt) : note.receipt}
                            </p>
                          ) : null}
                          {note.deposits?.length ? (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {note.deposits.map((d) => (
                                <button
                                  key={`${d.rule}-${d.version}`}
                                  type="button"
                                  disabled={!onOpenDeaiRule}
                                  title={onOpenDeaiRule ? '在工作台「去 AI 味」里看这条规则' : undefined}
                                  onClick={() => onOpenDeaiRule?.(d.rule)}
                                  className="rounded border border-border px-1.5 font-mono text-[11px] text-muted-foreground hover:bg-accent disabled:hover:bg-transparent"
                                >
                                  {d.rule} · v{d.version}
                                </button>
                              ))}
                            </div>
                          ) : null}
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
