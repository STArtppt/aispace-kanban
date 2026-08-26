import {
  Children,
  cloneElement,
  isValidElement,
  useLayoutEffect,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type RefObject,
} from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { MarkdownCodeBlock } from '@/components/MarkdownCodeBlock';
import { MermaidBlock } from '@/components/MermaidBlock';
import { useScrollActivity } from '@/hooks/useScrollActivity';
import { cn } from '@/lib/utils';

export type TocItem = { id: string; text: string; level: number; index: number };

const HEADING_SELECTOR = 'h1, h2, h3';

function headingLevel(tag: string): number {
  if (tag === 'H1') return 1;
  if (tag === 'H2') return 2;
  return 3;
}

/** 在已渲染的 markdown DOM 上打锚点，并生成与 DOM 完全一致的目录。 */
export function syncHeadingsFromDom(root: HTMLElement | null): TocItem[] {
  if (!root) return [];
  const nodes = root.querySelectorAll<HTMLElement>(HEADING_SELECTOR);
  const items: TocItem[] = [];
  nodes.forEach((el, index) => {
    const id = `doc-h-${index}`;
    el.id = id;
    el.setAttribute('data-toc-index', String(index));
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim() || `章节 ${index + 1}`;
    items.push({
      id,
      text,
      level: headingLevel(el.tagName),
      index,
    });
  });
  return items;
}

function listHeadingEls(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  const root = container.querySelector('.markdown-body') ?? container;
  return Array.from(root.querySelectorAll<HTMLElement>(HEADING_SELECTOR));
}

function findHeadingEl(container: HTMLElement | null, item: TocItem): HTMLElement | null {
  const headings = listHeadingEls(container);
  // 优先按 DOM 顺序 index（最稳），再回退 id
  return headings[item.index] ?? headings.find((el) => el.id === item.id) ?? null;
}

/**
 * markdown 排版。
 * 标题 id 不在 render 时分配（StrictMode 会双调组件导致序号错位），
 * 改由 syncHeadingsFromDom 在布局后写入。
 */
function buildComponents(): ComponentProps<typeof ReactMarkdown>['components'] {
  return {
    h1: ({ className, ...props }) => (
      <h1 className={cn('mt-8 mb-4 scroll-mt-6 font-display text-2xl first:mt-0', className)} {...props} />
    ),
    h2: ({ className, ...props }) => (
      <h2
        className={cn(
          'mt-8 mb-3 scroll-mt-6 border-b border-border pb-2 text-xl font-medium first:mt-0',
          className,
        )}
        {...props}
      />
    ),
    h3: ({ className, ...props }) => (
      <h3 className={cn('mt-6 mb-2 scroll-mt-6 text-base font-medium first:mt-0', className)} {...props} />
    ),
    h4: ({ className, ...props }) => (
      <h4 className={cn('mt-4 mb-2 scroll-mt-6 text-sm font-medium first:mt-0', className)} {...props} />
    ),
    p: ({ className, ...props }) => <p className={cn('my-3 text-sm leading-7', className)} {...props} />,
    ul: ({ className, ...props }) => (
      <ul className={cn('my-3 list-disc space-y-1 pl-5 text-sm leading-7', className)} {...props} />
    ),
    ol: ({ className, ...props }) => (
      <ol className={cn('my-3 list-decimal space-y-1 pl-5 text-sm leading-7', className)} {...props} />
    ),
    li: ({ className, ...props }) => <li className={cn('pl-1', className)} {...props} />,
    blockquote: ({ className, ...props }) => (
      <blockquote
        className={cn('my-4 border-l-2 border-border pl-4 text-sm text-muted-foreground', className)}
        {...props}
      />
    ),
    hr: ({ className, ...props }) => <hr className={cn('my-8 border-border', className)} {...props} />,
    a: ({ className, ...props }) => (
      <a
        className={cn('underline underline-offset-4 decoration-border hover:decoration-foreground', className)}
        target="_blank"
        rel="noreferrer"
        {...props}
      />
    ),
    code: ({ className, children, ...props }) => {
      // pre 会把 isBlock 透传下来；带 language-* 的也是围栏块
      const { isBlock: isBlockProp, ...rest } = props as {
        isBlock?: boolean;
      } & typeof props;
      const isBlock = Boolean(isBlockProp) || String(className || '').includes('language-');
      if (isBlock) {
        const language = className?.match(/language-(\S+)/)?.[1];
        if (language === 'mermaid') {
          return <MermaidBlock source={String(children).replace(/\n$/, '')} />;
        }
        return <MarkdownCodeBlock className={className}>{children}</MarkdownCodeBlock>;
      }
      return (
        <code className={cn('rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]', className)} {...rest}>
          {children}
        </code>
      );
    },
    // CodeBlock 自带外壳；pre 只负责把子 code 标成块级，避免双重边框
    pre: ({ children }) => (
      <>
        {Children.map(children, (child) => {
          if (isValidElement(child)) {
            return cloneElement(child as ReactElement<{ isBlock?: boolean }>, { isBlock: true });
          }
          return child;
        })}
      </>
    ),
    table: ({ className, ...props }) => (
      <div className="my-4 overflow-x-auto rounded-lg border border-border">
        <table className={cn('w-full border-collapse text-sm', className)} {...props} />
      </div>
    ),
    thead: ({ className, ...props }) => <thead className={cn('bg-muted/60', className)} {...props} />,
    th: ({ className, ...props }) => (
      <th
        className={cn(
          'border-b border-border px-3 py-2 text-left text-xs font-medium whitespace-nowrap',
          className,
        )}
        {...props}
      />
    ),
    td: ({ className, ...props }) => (
      <td className={cn('border-b border-border px-3 py-2 align-top last:border-r-0', className)} {...props} />
    ),
    img: ({ className, style, ...props }) => (
      <img
        className={cn('my-4 h-auto max-w-full rounded-lg border border-border', className)}
        // 老的 pandoc 时代产物会带 Word 的固定宽高（如 6.76in）；窄栏下保留高度会把图压扁
        style={style ? { ...style, height: 'auto' } : undefined}
        {...props}
      />
    ),
  };
}

const mdComponents = buildComponents();

/**
 * 文档目录 —— 相对预览面板固定。
 * 跳转 / 高亮一律按「渲染后 DOM 里的 h1–h3 顺序」，与目录同源。
 */
export function DocumentToc({
  items,
  scrollContainerRef,
  className,
}: {
  items: TocItem[];
  scrollContainerRef: RefObject<HTMLElement | null>;
  className?: string;
}) {
  const [activeId, setActiveId] = useState<string | null>(items[0]?.id ?? null);
  const jumpingRef = useRef(false);
  const jumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { isScrolling, markScrollActive } = useScrollActivity();

  useEffect(() => {
    setActiveId(items[0]?.id ?? null);
  }, [items]);

  useEffect(() => {
    if (!items.length) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const syncActive = () => {
      if (jumpingRef.current) return;
      const top = container.getBoundingClientRect().top;
      const threshold = top + 96;
      const headings = listHeadingEls(container);
      let found: string | null = null;
      for (let i = 0; i < headings.length; i++) {
        const el = headings[i];
        if (el.getBoundingClientRect().top < threshold) {
          found = el.id || `doc-h-${i}`;
        } else {
          break;
        }
      }
      if (!found && headings[0]) found = headings[0].id || 'doc-h-0';
      setActiveId((prev) => (prev === found ? prev : found));
    };

    container.addEventListener('scroll', syncActive, { passive: true });
    const t = window.setTimeout(syncActive, 80);
    return () => {
      container.removeEventListener('scroll', syncActive);
      window.clearTimeout(t);
    };
  }, [items, scrollContainerRef]);

  useEffect(() => {
    if (!activeId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-toc-id="${activeId}"]`);
    if (!el) return;
    const list = listRef.current;
    const elTop = el.offsetTop;
    const elBottom = elTop + el.offsetHeight;
    const viewTop = list.scrollTop;
    const viewBottom = viewTop + list.clientHeight;
    if (elTop < viewTop + 8) {
      list.scrollTo({ top: Math.max(0, elTop - 24), behavior: 'smooth' });
    } else if (elBottom > viewBottom - 8) {
      list.scrollTo({ top: elBottom - list.clientHeight + 24, behavior: 'smooth' });
    }
  }, [activeId]);

  useEffect(() => {
    return () => {
      if (jumpTimerRef.current) clearTimeout(jumpTimerRef.current);
    };
  }, []);

  const scrollTo = (item: TocItem) => {
    const container = scrollContainerRef.current;
    const el = findHeadingEl(container, item);
    if (!el || !container) return;

    setActiveId(item.id);
    jumpingRef.current = true;
    if (jumpTimerRef.current) clearTimeout(jumpTimerRef.current);
    jumpTimerRef.current = setTimeout(() => {
      jumpingRef.current = false;
    }, 800);

    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const nextTop = container.scrollTop + (eRect.top - cRect.top) - 16;
    container.scrollTo({ top: Math.max(0, nextTop), behavior: 'smooth' });
  };

  // 「目录」标题常驻；不足 2 个标题时显示空态，右轨宽度始终占位
  const empty = items.length < 2;

  return (
    <nav
      aria-label="目录"
      className={cn('relative flex h-full min-h-0 w-full select-none flex-col py-1 text-sm', className)}
    >
      <div className="mb-3 shrink-0 pl-4 text-[13px] font-semibold text-foreground">目录</div>
      {!empty ? (
        <div className="pointer-events-none absolute top-[38px] bottom-2 left-0 w-0.5 rounded-full bg-border" />
      ) : null}

      {empty ? (
        <p className="px-4 text-xs text-muted-foreground">暂无目录</p>
      ) : (
        <div
          ref={listRef}
          onScroll={markScrollActive}
          className={cn(
            'relative z-10 min-h-0 flex-1 overflow-y-auto pr-1',
            '[scrollbar-width:thin]',
            isScrolling
              ? '[&::-webkit-scrollbar-thumb]:bg-muted-foreground/30'
              : '[&::-webkit-scrollbar-thumb]:bg-transparent',
          )}
        >
          <div className="relative flex flex-col gap-0.5 pb-4">
            {items.map((item) => {
              const isActive = activeId === item.id;
              return (
                <button
                  key={`${item.id}-${item.index}`}
                  type="button"
                  data-toc-id={item.id}
                  title={item.text}
                  onClick={() => scrollTo(item)}
                  className={cn(
                    'relative w-full truncate py-1.5 pr-2 text-left text-xs transition-colors hover:text-foreground',
                    isActive ? 'font-medium text-foreground' : 'text-muted-foreground',
                    item.level === 1 && 'mt-0.5 pl-4 text-[13px]',
                    item.level === 2 && 'pl-7',
                    item.level >= 3 && 'pl-10',
                  )}
                >
                  {isActive ? (
                    <span className="absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
                  ) : null}
                  {item.text}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </nav>
  );
}

/** 渲染 markdown 正文；布局完成后从真实 DOM 生成目录。 */
export function Markdown({
  children,
  urlTransform,
  onHeadingsChange,
}: {
  children: string;
  urlTransform?: (url: string) => string;
  /** 渲染完成后回调实际标题列表（与 DOM 锚点一致） */
  onHeadingsChange?: (items: TocItem[]) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const onHeadingsChangeRef = useRef(onHeadingsChange);
  onHeadingsChangeRef.current = onHeadingsChange;

  // 布局后根据真实 DOM 打 id，再回传目录 —— 彻底避开 render 期序号问题
  useLayoutEffect(() => {
    const items = syncHeadingsFromDom(rootRef.current);
    onHeadingsChangeRef.current?.(items);
  }, [children]);

  const renderKey = useMemo(
    () => `${children.length}:${children.slice(0, 64)}`,
    [children],
  );

  return (
    <div ref={rootRef} className="markdown-body max-w-[76ch]">
      <ReactMarkdown
        key={renderKey}
        remarkPlugins={[remarkGfm]}
        // MinerU 与 pandoc 时代的老产物会出裸 HTML 图/表，不是 ![]()；不接 rehype-raw 会被转义掉。
        // docx/odt/rtf/epub 现在走 anydoc_writer.mjs 出的是 ![]()，但**别把这个插件删了**——上面两条路还在。
        rehypePlugins={[rehypeRaw]}
        disallowedElements={['script', 'iframe', 'object', 'embed']}
        components={mdComponents}
        urlTransform={urlTransform}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
