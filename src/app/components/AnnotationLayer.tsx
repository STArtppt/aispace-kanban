import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { Annotation } from '@/hooks/useAnnotations';
import { cn } from '@/lib/utils';
import {
  anchorFromDomSelection,
  domRangeFromBytes,
  type StructureHint,
} from '@/lib/sourceAnchor';

type Pending =
  | {
      kind: 'ok';
      quote: string;
      start: number;
      end: number;
      structure: StructureHint;
      x: number;
      y: number;
    }
  | { kind: 'unsupported'; x: number; y: number };

export function AnnotationLayer({
  notes,
  contentKey,
  disabled,
  children,
  onCreate,
}: {
  notes: Annotation[];
  /** 正文变了要重算高亮（已有批注、文档刚加载完） */
  contentKey: string;
  disabled?: boolean;
  children: ReactNode;
  onCreate: (input: {
    quote: string;
    start: number;
    end: number;
    structure: StructureHint;
    comment: string;
  }) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [rects, setRects] = useState<{ top: number; left: number; width: number; height: number; id: string }[]>(
    [],
  );

  const markdownRoot = () => wrapRef.current?.querySelector<HTMLElement>('.markdown-body') ?? null;

  const syncHighlights = () => {
    const root = markdownRoot();
    const wrap = wrapRef.current;
    if (!root || !wrap) {
      setRects([]);
      return;
    }
    const base = wrap.getBoundingClientRect();
    const next: typeof rects = [];
    for (const note of notes) {
      const range = domRangeFromBytes(root, note.start, note.end);
      if (!range) continue;
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width < 1 || rect.height < 1) continue;
        next.push({
          id: note.id,
          top: rect.top - base.top + wrap.scrollTop,
          left: rect.left - base.left + wrap.scrollLeft,
          width: rect.width,
          height: rect.height,
        });
      }
    }
    setRects(next);
  };

  useLayoutEffect(() => {
    syncHighlights();
  }, [notes, contentKey]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onScroll = () => {
      setPending(null);
      setComposing(false);
      syncHighlights();
    };
    const host = wrap.closest('[data-reader-scroll]') ?? wrap;
    host.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => syncHighlights());
    ro.observe(wrap);
    return () => {
      host.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [notes]);

  useEffect(() => {
    if (!pending) return;
    const onDown = (event: PointerEvent) => {
      const wrap = wrapRef.current;
      if (wrap && event.target instanceof Node && wrap.contains(event.target)) {
        const pop = wrap.querySelector('[data-annotate-pop]');
        if (pop && pop.contains(event.target)) return;
      }
      setPending(null);
      setComposing(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [pending]);

  const onMouseUp = () => {
    if (disabled || composing) return;
    const root = markdownRoot();
    const wrap = wrapRef.current;
    if (!root || !wrap) return;
    const sel = window.getSelection();
    const result = anchorFromDomSelection(root, sel);
    if (!result.ok && result.reason === 'empty') {
      setPending(null);
      return;
    }
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    const rect = range?.getBoundingClientRect();
    const base = wrap.getBoundingClientRect();
    const x = rect ? rect.left - base.left + rect.width / 2 : 16;
    const y = rect ? rect.top - base.top - 8 : 16;
    if (!result.ok) {
      setPending({ kind: 'unsupported', x, y });
      setComposing(false);
      return;
    }
    setPending({
      kind: 'ok',
      quote: result.quote,
      start: result.start,
      end: result.end,
      structure: result.structure,
      x,
      y,
    });
    setComposing(false);
    setDraft('');
  };

  const save = () => {
    if (!pending || pending.kind !== 'ok') return;
    const comment = draft.trim();
    if (!comment) return;
    onCreate({
      quote: pending.quote,
      start: pending.start,
      end: pending.end,
      structure: pending.structure,
      comment,
    });
    setPending(null);
    setComposing(false);
    setDraft('');
    window.getSelection()?.removeAllRanges();
  };

  return (
    <div ref={wrapRef} className="relative" onMouseUp={onMouseUp}>
      <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
        {rects.map((rect, index) => (
          <div
            key={`${rect.id}-${index}`}
            className="absolute rounded-sm bg-muted"
            style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
          />
        ))}
      </div>
      <div className="relative z-[1]">{children}</div>
      {pending ? (
        <div
          data-annotate-pop
          className="absolute z-20"
          style={{
            left: Math.max(8, pending.x),
            top: Math.max(8, pending.y),
            transform: 'translate(-50%, -100%)',
          }}
        >
          {pending.kind === 'unsupported' ? (
            <p className="rounded-lg border border-border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-sm">
              这段内容暂时不支持批注
            </p>
          ) : composing ? (
            <div className="w-[min(20rem,calc(100vw-3rem))] rounded-lg border border-border bg-popover p-2 shadow-sm">
              <p className="mb-2 line-clamp-3 text-xs text-muted-foreground">「{pending.quote}」</p>
              <Textarea
                autoFocus
                rows={3}
                value={draft}
                placeholder="写下你的意见"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setPending(null);
                    setComposing(false);
                  }
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save();
                }}
              />
              <div className="mt-2 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPending(null);
                    setComposing(false);
                  }}
                >
                  取消
                </Button>
                <Button type="button" size="sm" disabled={!draft.trim()} onClick={save}>
                  保存
                </Button>
              </div>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className={cn('shadow-sm')}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setComposing(true)}
            >
              批注
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
