import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { AnnotateMode, AnnotateRequest } from '@/hooks/useAnnotationSession';
import type { Annotation } from '@/hooks/useAnnotations';
import { cn } from '@/lib/utils';
import {
  anchorFromDomSelection,
  anchorFromElement,
  collectLeavesFromDom,
  domRangeFromBytes,
  SOURCE_RANGE_ATTR,
  SOURCE_TEXT_ATTR,
  type StructureHint,
} from '@/lib/sourceAnchor';

/** 正文里可以拾取的元素：声明过 A2 区间，且不是给文本节点包的那层 span。 */
const PICKABLE = `[${SOURCE_RANGE_ATTR}]:not([${SOURCE_TEXT_ATTR}])`;
/** 浮层与它所贴的那块之间的缝。 */
const GAP = 8;
/** 批注框的宽度上限，用来把它夹在正文宽度以内。 */
const POPOVER_WIDTH = 320;
/** 目标下方还剩这么多像素才够开一个批注框，否则翻到上方去。 */
const POPOVER_ROOM = 220;
/** 标记点直径；钉在所批那块的左上角，往外挪半个身位。 */
const MARKER_SIZE = 20;
/** 「定位」之后高亮加重多久。够让眼睛跟过去，又不会一直亮着。 */
const FLASH_MS = 1500;

/** 相对包裹层的坐标，跟着正文一起滚。 */
type Box = { top: number; left: number; width: number; height: number };

type Highlight = Box & { id: string };
type Marker = { id: string; index: number; top: number; left: number };

/** 待写的那一条贴着哪块开 —— 存"怎么量"而不是当时量出的值，重排后还能再量一次。 */
type Target = { kind: 'element'; el: Element } | { kind: 'range'; range: Range };

type Pending =
  | {
      kind: 'ok';
      /** 改老的那条时是它的 id；新写的一条是 null。 */
      id: string | null;
      label: string;
      quote: string;
      start: number;
      end: number;
      structure: StructureHint;
      box: Box;
      /** 这块要不要补一圈实线框：点出来的元素要，划出来的文字有选区高亮就不用。 */
      outline: boolean;
      place: 'above' | 'below';
    }
  | { kind: 'unsupported'; box: Box; place: 'above' | 'below' };

function sameBox(a: Box, b: Box | null | undefined): boolean {
  return !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

export function AnnotationLayer({
  notes,
  contentKey,
  active,
  mode,
  request,
  children,
  onCreate,
  onUpdate,
  onRequestDone,
  onToast,
  onEscape,
}: {
  notes: Annotation[];
  /** 正文变了要重算高亮（已有批注、文档刚加载完） */
  contentKey: string;
  /** 胶囊激活了才有批注交互；没激活时这一层只画已有批注的高亮 */
  active: boolean;
  mode: AnnotateMode;
  /** 清单里点「定位 / 改」传进来的一次点名 */
  request: AnnotateRequest | null;
  children: ReactNode;
  onCreate: (input: {
    quote: string;
    start: number;
    end: number;
    structure: StructureHint;
    comment: string;
  }) => void;
  onUpdate: (id: string, comment: string) => void;
  onRequestDone: () => void;
  onToast: (text: string, tone?: 'info' | 'warn') => void;
  onEscape: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<Target | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [draft, setDraft] = useState('');
  const [hover, setHover] = useState<{ box: Box; label: string } | null>(null);
  const [rects, setRects] = useState<Highlight[]>([]);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [flashId, setFlashId] = useState<string | null>(null);

  const markdownRoot = useCallback(
    () => wrapRef.current?.querySelector<HTMLElement>('.markdown-body') ?? null,
    [],
  );

  /** 视口坐标 → 包裹层坐标。包裹层自己不滚，滚的是外面的阅读区。 */
  const toBox = useCallback((rect: DOMRect): Box | null => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    const base = wrap.getBoundingClientRect();
    return {
      top: rect.top - base.top,
      left: rect.left - base.left,
      width: rect.width,
      height: rect.height,
    };
  }, []);

  /** 批注框默认开在下方；下面不够高就翻上去（阅读区的可视范围说了算）。 */
  const placeFor = useCallback((rect: DOMRect): 'above' | 'below' => {
    const host = wrapRef.current?.closest('[data-reader-scroll]');
    const bottom = host ? host.getBoundingClientRect().bottom : window.innerHeight;
    return rect.bottom + POPOVER_ROOM > bottom ? 'above' : 'below';
  }, []);

  const measure = useCallback((target: Target): DOMRect => {
    return target.kind === 'element'
      ? target.el.getBoundingClientRect()
      : target.range.getBoundingClientRect();
  }, []);

  /** 高亮、标记点、以及待写那条的位置，一起重量一遍。 */
  const syncGeometry = useCallback(() => {
    const root = markdownRoot();
    const wrap = wrapRef.current;
    if (!root || !wrap) {
      setRects([]);
      setMarkers([]);
      return;
    }
    const base = wrap.getBoundingClientRect();
    const nextRects: Highlight[] = [];
    const nextMarkers: Marker[] = [];
    // 叶子表整份正文只走一遍：每条批注各自去收一次的话，代价是「批注条数 × 全文 DOM」，
    // 而这个函数还挂在 ResizeObserver 上，会被反复触发
    const leaves = notes.length ? collectLeavesFromDom(root) : [];
    notes.forEach((note, index) => {
      const range = domRangeFromBytes(root, note.start, note.end, leaves);
      if (!range) return;
      const list = Array.from(range.getClientRects()).filter(
        (rect) => rect.width >= 1 && rect.height >= 1,
      );
      if (!list.length) return;
      for (const rect of list) {
        nextRects.push({
          id: note.id,
          top: rect.top - base.top,
          left: rect.left - base.left,
          width: rect.width,
          height: rect.height,
        });
      }
      // 标记点钉在这一条真正占的那块的左上角，和点开它之后框出来的是同一块
      nextMarkers.push({
        id: note.id,
        index: index + 1,
        top: list[0].top - base.top - MARKER_SIZE / 2,
        left: list[0].left - base.left - MARKER_SIZE / 2,
      });
    });
    setRects(nextRects);
    setMarkers(nextMarkers);

    const target = targetRef.current;
    if (target) {
      const box = toBox(measure(target));
      if (box) setPending((prev) => (prev && !sameBox(box, prev.box) ? { ...prev, box } : prev));
    }
  }, [markdownRoot, measure, notes, toBox]);

  useLayoutEffect(() => {
    syncGeometry();
  }, [syncGeometry, contentKey]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => syncGeometry());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [syncGeometry]);

  const cancel = useCallback(() => {
    targetRef.current = null;
    setPending(null);
    setDraft('');
  }, []);

  // 收起胶囊 = 退出批注状态：描边、待写的那条一起收掉
  useEffect(() => {
    if (active) return;
    cancel();
    setHover(null);
  }, [active, cancel]);

  useEffect(() => {
    cancel();
    setHover(null);
  }, [contentKey, cancel]);

  const open = useCallback(
    (next: Pending, target: Target | null, note: string) => {
      targetRef.current = target;
      setPending(next);
      setDraft(note);
    },
    [],
  );

  /** 打开某一条已有批注：原地把框重新开出来，看得见写过什么，也能改。 */
  const openExisting = useCallback(
    (note: Annotation, index: number, range: Range) => {
      const rect = range.getBoundingClientRect();
      const box = toBox(rect);
      if (!box) return;
      open(
        {
          kind: 'ok',
          id: note.id,
          label: `第 ${index + 1} 条`,
          quote: note.quote,
          start: note.start,
          end: note.end,
          structure: note.structure,
          box,
          // 重新打开时页面上没有别的东西指出是哪一块，这一圈框得补上
          outline: true,
          place: placeFor(rect),
        },
        { kind: 'range', range },
        note.comment,
      );
    },
    [open, placeFor, toBox],
  );

  // 清单里点「定位 / 改」：滚过去，再按动作决定要不要把框开出来
  useEffect(() => {
    if (!request) return;
    const root = markdownRoot();
    const index = notes.findIndex((note) => note.id === request.id);
    const note = notes[index];
    const range = root && note ? domRangeFromBytes(root, note.start, note.end) : null;
    if (!note || !range) {
      onToast('这一条的原位置已经找不到了 —— 文档改过了。批注内容还留着。', 'warn');
      onRequestDone();
      return;
    }
    const host = range.startContainer.parentElement;
    host?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (request.action === 'edit') {
      openExisting(note, index, range);
    } else {
      setFlashId(note.id);
    }
    onRequestDone();
  }, [markdownRoot, notes, onRequestDone, onToast, openExisting, request]);

  useEffect(() => {
    if (!flashId) return;
    const timer = window.setTimeout(() => setFlashId(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flashId]);

  // 正在改的那条被删掉 / 清空了：把框收掉，别留一个存不进去的空壳
  useEffect(() => {
    if (pending?.kind !== 'ok' || pending.id === null) return;
    if (notes.some((note) => note.id === pending.id)) return;
    cancel();
  }, [cancel, notes, pending]);

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      // 先收框，框都收干净了再按一次才退出批注
      if (pending) cancel();
      else onEscape();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, cancel, onEscape, pending]);

  /** 事件落在我们自己的界面上（标记点、批注框），不算落在正文上。 */
  const isOurs = (target: EventTarget | null): boolean =>
    target instanceof Element && Boolean(target.closest('[data-annotate-ui]'));

  const pickableAt = (target: EventTarget | null): Element | null => {
    const root = markdownRoot();
    if (!root || !(target instanceof Element) || isOurs(target)) return null;
    const el = target.closest(PICKABLE);
    return el && root.contains(el) ? el : null;
  };

  const onMouseMove = (event: ReactMouseEvent) => {
    if (!active || mode !== 'pick-element') return;
    const el = pickableAt(event.target);
    if (!el) {
      setHover(null);
      return;
    }
    const box = toBox(el.getBoundingClientRect());
    if (!box) return;
    setHover({
      box,
      label: `${el.tagName.toLowerCase()} · ${Math.round(box.width)}×${Math.round(box.height)}`,
    });
  };

  const onClick = (event: ReactMouseEvent) => {
    if (!active || isOurs(event.target)) return;
    // 批注模式下正文里的链接不跳走：跳了就没得批了
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (link) {
      event.preventDefault();
      if (mode === 'select-text') {
        onToast('批注模式下先不跳转，收起批注后再点这个链接。', 'warn');
        return;
      }
    }
    if (mode !== 'pick-element') return;
    const el = pickableAt(event.target);
    // 点在正文以外（页边、空白）：当成"算了"，把开着的框收掉
    if (!el) {
      cancel();
      return;
    }
    event.preventDefault();
    const root = markdownRoot();
    if (!root) return;
    const rect = el.getBoundingClientRect();
    const box = toBox(rect);
    if (!box) return;
    const result = anchorFromElement(root, el);
    if (!result.ok) {
      open({ kind: 'unsupported', box, place: placeFor(rect) }, null, '');
      return;
    }
    open(
      {
        kind: 'ok',
        id: null,
        label: `已选中 <${el.tagName.toLowerCase()}> · ${result.structure}`,
        quote: result.quote,
        start: result.start,
        end: result.end,
        structure: result.structure,
        box,
        outline: true,
        place: placeFor(rect),
      },
      { kind: 'element', el },
      '',
    );
  };

  const onMouseUp = (event: ReactMouseEvent) => {
    if (!active || mode !== 'select-text' || isOurs(event.target)) return;
    const root = markdownRoot();
    if (!root) return;
    const selection = window.getSelection();
    const result = anchorFromDomSelection(root, selection);
    if (!result.ok && result.reason === 'empty') {
      cancel();
      return;
    }
    const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
    if (!range) return;
    const rect = range.getBoundingClientRect();
    const box = toBox(rect);
    if (!box) return;
    if (!result.ok) {
      open({ kind: 'unsupported', box, place: placeFor(rect) }, null, '');
      return;
    }
    open(
      {
        kind: 'ok',
        id: null,
        label: `已选中「${result.quote.slice(0, 30)}」`,
        quote: result.quote,
        start: result.start,
        end: result.end,
        structure: result.structure,
        box,
        // 浏览器自己的选区高亮已经在了，再套一个跨行的外接矩形只会更糊
        outline: false,
        place: placeFor(rect),
      },
      { kind: 'range', range },
      '',
    );
  };

  const save = () => {
    if (pending?.kind !== 'ok') return;
    const comment = draft.trim();
    if (!comment) return;
    if (pending.id === null) {
      onCreate({
        quote: pending.quote,
        start: pending.start,
        end: pending.end,
        structure: pending.structure,
        comment,
      });
    } else {
      onUpdate(pending.id, comment);
    }
    cancel();
    window.getSelection()?.removeAllRanges();
  };

  const picking = active && mode === 'pick-element';
  const popoverLeft = (box: Box): number => {
    const width = wrapRef.current?.clientWidth ?? POPOVER_WIDTH;
    return Math.max(0, Math.min(box.left, Math.max(0, width - POPOVER_WIDTH)));
  };

  return (
    <div
      ref={wrapRef}
      className={cn('relative', picking && 'cursor-crosshair select-none')}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onClick={onClick}
    >
      <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
        {rects.map((rect, index) => (
          <div
            key={`${rect.id}-${index}`}
            className={cn(
              'absolute rounded-sm bg-muted',
              rect.id === flashId && 'bg-foreground/15 ring-1 ring-foreground/40',
            )}
            style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
          />
        ))}
      </div>

      <div className="relative z-[1]">{children}</div>

      {/* 鼠标底下那块：虚线，还没定。选中的就是这块时不再描一遍 */}
      {hover && !sameBox(hover.box, pending?.box) ? (
        <div
          className="pointer-events-none absolute z-10 rounded-sm border border-dashed border-foreground/70 bg-foreground/5"
          style={{ top: hover.box.top, left: hover.box.left, width: hover.box.width, height: hover.box.height }}
          aria-hidden
        >
          <span className="absolute bottom-full left-0 rounded-t-sm bg-foreground px-1.5 text-[11px] leading-4 whitespace-nowrap text-background">
            {hover.label}
          </span>
        </div>
      ) : null}

      {/* 已经选中的那块：实线，一直画到这条记完或取消 */}
      {pending?.kind === 'ok' && pending.outline ? (
        <div
          className="pointer-events-none absolute z-10 rounded-sm border border-foreground bg-foreground/5"
          style={{
            top: pending.box.top,
            left: pending.box.left,
            width: pending.box.width,
            height: pending.box.height,
          }}
          aria-hidden
        />
      ) : null}

      {active ? (
        <div className="pointer-events-none absolute inset-0 z-10" data-annotate-ui>
          {markers.map((marker) => (
            <button
              key={marker.id}
              type="button"
              data-annotate-ui
              className="pointer-events-auto absolute grid size-5 place-items-center rounded-full border-2 border-background bg-foreground text-[10px] leading-none text-background shadow-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              style={{ top: marker.top, left: marker.left }}
              aria-label={`打开第 ${marker.index} 条批注`}
              onClick={(event) => {
                event.stopPropagation();
                const root = markdownRoot();
                const note = notes.find((item) => item.id === marker.id);
                const range = root && note ? domRangeFromBytes(root, note.start, note.end) : null;
                if (!note || !range) return;
                openExisting(note, marker.index - 1, range);
              }}
            >
              {marker.index}
            </button>
          ))}
        </div>
      ) : null}

      {pending ? (
        <div
          data-annotate-ui
          className="absolute z-20"
          style={{
            left: popoverLeft(pending.box),
            top:
              pending.place === 'below'
                ? pending.box.top + pending.box.height + GAP
                : pending.box.top - GAP,
            transform: pending.place === 'below' ? undefined : 'translateY(-100%)',
          }}
        >
          {pending.kind === 'unsupported' ? (
            <p className="rounded-lg border border-border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-md">
              这段内容暂时不支持批注
            </p>
          ) : (
            <div
              className="rounded-lg border border-border bg-popover p-2.5 shadow-md"
              style={{ width: `min(${POPOVER_WIDTH}px, calc(100vw - 3rem))` }}
            >
              <p className="mb-2 line-clamp-2 text-xs text-muted-foreground">{pending.label}</p>
              <Textarea
                autoFocus
                rows={3}
                value={draft}
                placeholder="写下你的意见"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save();
                }}
              />
              <div className="mt-2 flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={cancel}>
                  取消
                </Button>
                <Button type="button" size="sm" disabled={!draft.trim()} onClick={save}>
                  {pending.id === null ? '记下来' : '改好了'}
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
