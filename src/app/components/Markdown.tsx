import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useLayoutEffect,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { MarkdownCodeBlock } from '@/components/MarkdownCodeBlock';
import { MermaidBlock } from '@/components/MermaidBlock';
import { useScrollActivity } from '@/hooks/useScrollActivity';
import { remarkWorkspace } from '@/lib/markdownSyntax';
import { hoistLargeDataUris, shouldPassthroughUrl } from '@/lib/markdownUrls';
import { pickSourceAttrs, rehypeSourcePos, rehypeStripTableWhitespace } from '@/lib/sourceAnchor';
import { cn } from '@/lib/utils';
import 'katex/dist/katex.min.css';

export type TocItem = { id: string; text: string; level: number; index: number };

const HEADING_SELECTOR = 'h1, h2, h3, h4';

function headingLevel(tag: string): number {
  if (tag === 'H1') return 1;
  if (tag === 'H2') return 2;
  if (tag === 'H3') return 3;
  return 4;
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

/** 解析出的站内目标：`path` 相对工作空间根，`href` 是原始文件地址（修饰键点击时浏览器用它） */
export type InternalLinkTarget = { path: string; href: string };

/**
 * 站内链接的判定与上报。`kind` 区分来源：`link` 是 `[..](..)` 的目标，
 * `code` 是行内代码的文本 —— 两者解析规则不同，但走同一个判定函数，免得口径分叉。
 */
export type ResolveLink = (url: string, kind: 'link' | 'code') => InternalLinkTarget | null;
/** 站内目标（工作空间路径，或 `#锚点`）被无修饰键左键点中。要不要 preventDefault 由调用方定 */
export type OnInternalLink = (target: string, event: ReactMouseEvent<HTMLAnchorElement>) => void;

type LinkHandlers = { resolve: ResolveLink; open: OnInternalLink };

/** 不给 = 帮助面板、问题详情：链接行为与改动前逐字一致 */
const LinkContext = createContext<LinkHandlers | null>(null);
/** 链接里的行内代码不再自动成链：`<a>` 套 `<a>` 是非法结构 */
const InsideLinkContext = createContext(false);

/** 与浏览器「新窗口 / 新标签」相关的点法一律放行 */
function isPlainClick(event: ReactMouseEvent) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** 锚点与标题文本比较前的规整：去首尾空白、小写、空白与连字符等价、解百分号 */
function normalizeAnchor(text: string): string {
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    decoded = text;
  }
  return decoded.trim().toLowerCase().replace(/[\s-]+/g, '-');
}

/**
 * 在链接所在的正文里找标题文本对得上的那个并滚过去；找不到就什么都不做。
 * 标题 id 是序号（`doc-h-<n>`），对不上锚点文本，所以按文本比。
 */
export function scrollToAnchor(from: Element, hash: string) {
  const want = normalizeAnchor(hash.replace(/^#/, ''));
  if (!want) return;
  const root = from.closest('.markdown-body');
  if (!root) return;
  const headings = root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6');
  for (const el of headings) {
    if (normalizeAnchor(el.textContent || '') === want) {
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
  }
}

type HastLike = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: HastLike[] };

/**
 * urlTransform 会就地改写 href，渲染器拿到的已经是 `/file?path=…`。
 * 判定站内链接要原始写法，所以先抄一份到 `data-md-href`。只在启用站内链接时挂。
 */
function rehypeKeepHref() {
  return (tree: HastLike) => {
    const visit = (node: HastLike) => {
      if (node.type === 'element' && node.tagName === 'a' && typeof node.properties?.href === 'string') {
        node.properties.dataMdHref = node.properties.href;
      }
      for (const child of node.children || []) visit(child);
    };
    visit(tree);
  };
}

const LINK_CLASS = 'underline underline-offset-4 decoration-border hover:decoration-foreground';

function MdLink({ className, ...all }: ComponentProps<'a'>) {
  const link = useContext(LinkContext);
  if (!link) {
    // 未启用：与改动前逐字一致
    return <a className={cn(LINK_CLASS, className)} target="_blank" rel="noreferrer" {...all} />;
  }
  const { 'data-md-href': raw, children, ...rest } = all as typeof all & { 'data-md-href'?: unknown };
  const props = {
    ...rest,
    children: <InsideLinkContext.Provider value>{children}</InsideLinkContext.Provider>,
  };
  const original = typeof raw === 'string' ? raw : '';
  if (original.startsWith('#')) {
    return (
      <a
        className={cn(LINK_CLASS, className)}
        {...props}
        onClick={(event) => {
          if (!isPlainClick(event)) return;
          link.open(original, event);
        }}
      />
    );
  }
  const target = original ? link.resolve(original, 'link') : null;
  if (!target) {
    return <a className={cn(LINK_CLASS, className)} target="_blank" rel="noreferrer" {...props} />;
  }
  // href 用解析结果：`a.md#某节` 的片段不能进 path 参数，否则 ⌘ 点击新开的是 404
  return (
    <a
      className={cn(LINK_CLASS, className)}
      {...props}
      href={target.href}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        link.open(target.path, event);
      }}
    />
  );
}

/** 批注用的 rehypeSourcePos 会给文本外包 span，行内代码的 children 不一定是字符串 */
function plainText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(plainText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return plainText(node.props.children);
  return '';
}

/** 行内代码：内容恰好是工作空间里的文件路径时包成站内链接，等宽样式不变 */
function InlineCode({ className, children, ...rest }: ComponentProps<'code'>) {
  const link = useContext(LinkContext);
  const insideLink = useContext(InsideLinkContext);
  const text = link && !insideLink ? plainText(children).trim().replace(/^\.\//, '') : '';
  const target = text && !/\s/.test(text) ? link!.resolve(text, 'code') : null;
  const code = (
    <code
      className={cn(
        'rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]',
        // 下划线画在 code 自己身上；颜色比普通链接深一档 —— border 色贴着 muted 底色，看不出能点
        target && 'underline underline-offset-4 decoration-muted-foreground/50 group-hover:decoration-foreground',
        className,
      )}
      {...rest}
    >
      {children}
    </code>
  );
  if (!target) return code;
  return (
    <a
      className="group"
      href={target.href}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        link!.open(target.path, event);
      }}
    >
      {code}
    </a>
  );
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
    a: MdLink,
    code: ({ className, children, ...props }) => {
      // pre 会把 isBlock 透传下来；带 language-* 的也是围栏块
      const { isBlock: isBlockProp, ...rest } = props as {
        isBlock?: boolean;
      } & typeof props;
      const isBlock = Boolean(isBlockProp) || String(className || '').includes('language-');
      const a2 = pickSourceAttrs(rest as Record<string, unknown>);
      if (isBlock) {
        const language = className?.match(/language-(\S+)/)?.[1];
        if (language === 'mermaid') {
          return <MermaidBlock source={String(children).replace(/\n$/, '')} {...a2} />;
        }
        return (
          <MarkdownCodeBlock className={className} {...a2}>
            {children}
          </MarkdownCodeBlock>
        );
      }
      return (
        <InlineCode className={className} {...(rest as ComponentProps<'code'>)}>
          {children}
        </InlineCode>
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
 * 跳转 / 高亮一律按「渲染后 DOM 里的 h1–h4 顺序」，与目录同源。
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
                    item.level === 3 && 'pl-10',
                    item.level >= 4 && 'pl-12',
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
  sourceFile,
  sourceByteOffset = 0,
  resolveLink,
  onInternalLink,
}: {
  children: string;
  urlTransform?: (url: string) => string;
  /**
   * 站内链接判定。与 `onInternalLink` 一起给才生效；都不给时渲染与改动前一致。
   * 身份变了（比如扫描结果刷新）只重渲链接与行内代码，不重新解析正文。
   */
  resolveLink?: ResolveLink;
  onInternalLink?: OnInternalLink;
  /** 渲染完成后回调实际标题列表（与 DOM 锚点一致） */
  onHeadingsChange?: (items: TocItem[]) => void;
  /** 相对工作空间根。不传就不盖 A2 属性（帮助文档等） */
  sourceFile?: string;
  sourceByteOffset?: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const onHeadingsChangeRef = useRef(onHeadingsChange);
  onHeadingsChangeRef.current = onHeadingsChange;
  // 调用方给的是行内箭头函数（每次 render 换个身份）。下面要按身份 memo 整棵正文，
  // 所以这里把它收进 ref，对外只暴露一个身份恒定的包装。
  const urlTransformRef = useRef(urlTransform);
  urlTransformRef.current = urlTransform;
  const stableUrlTransform = useCallback((url: string) => {
    // data: / blob: / http(s): 已经是可用地址。调用方（阅读器）会把相对路径
    // 拼成 /file?path=…；这些协议若也走那条路，几 MB 的 data URI 会变成
    // `/file?path=data%3A…`，点开卡死且图裂开。
    if (shouldPassthroughUrl(url)) return url;
    // 没传时必须退回 react-markdown 自己的实现：它会挡 javascript: 之类的协议，
    // 直接原样返回等于把这道消毒去掉了。
    return (urlTransformRef.current ?? defaultUrlTransform)(url);
  }, []);

  // 与 urlTransform 同理：上报回调收进 ref，只让判定函数的身份决定链接要不要重渲
  const onInternalLinkRef = useRef(onInternalLink);
  onInternalLinkRef.current = onInternalLink;
  const linksEnabled = Boolean(resolveLink && onInternalLink);
  const linkHandlers = useMemo<LinkHandlers | null>(
    () =>
      linksEnabled && resolveLink
        ? { resolve: resolveLink, open: (target, event) => onInternalLinkRef.current?.(target, event) }
        : null,
    [linksEnabled, resolveLink],
  );

  // 超大 data URI 抽成 blob:，再交给 micromark。原文仍用来盖锚点。
  const hoisted = useMemo(() => hoistLargeDataUris(children), [children]);

  const renderKey = useMemo(
    () => `${children.length}:${children.slice(0, 64)}:${sourceFile ?? ''}:${sourceByteOffset}:${hoisted.replaced}`,
    [children, sourceFile, sourceByteOffset, hoisted.replaced],
  );

  const remarkPlugins: ComponentProps<typeof ReactMarkdown>['remarkPlugins'] = useMemo(
    () => [remarkMath, [remarkGfm, { singleTilde: false }], [remarkWorkspace, { sourceFile }]],
    [sourceFile],
  );

  const rehypePlugins: ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = useMemo(() => {
    // katex 要在 rehype-raw 之前：它认的是 remark-math 留下的 code.language-math，
    // 转成 span 之后代码高亮组件才不会把公式当围栏代码块。
    // 非法公式不让整篇白掉：rehype-katex 自己会退回源文本；errorColor 不用它默认的红。
    const plugins: ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [
      [rehypeKatex, { errorColor: 'currentColor', strict: 'ignore' }],
      // rehype-raw 会把裸 HTML 表里的换行缩进留成文本节点；React 19 不允许
      // colgroup / table / tr 等结构标签的子节点是空白，开发态会把预览盖成空白。
      rehypeRaw,
      rehypeStripTableWhitespace,
    ];
    if (linksEnabled) plugins.push(rehypeKeepHref);
    if (sourceFile) {
      plugins.push([
        rehypeSourcePos,
        {
          file: sourceFile,
          source: children,
          byteOffset: sourceByteOffset,
          mapCharOffset: hoisted.mapToOriginal,
        },
      ]);
    }
    return plugins;
  }, [sourceFile, children, sourceByteOffset, hoisted.mapToOriginal, linksEnabled]);

  /**
   * 整棵正文按「源码 + 锚点参数」memo。
   *
   * react-markdown 是在 render 里跑完整条 markdown 管线的：父组件每重渲染一次
   * （回传目录后 setState、批注层量完几何后 setState、扫描刷新……），同一篇文档就要
   * 重新解析一遍。大表文档一次解析上百毫秒，点开一次实际会卡两三次。
   * 元素身份不变时 React 会跳过这棵子树，解析于是只发生在正文真的换了的时候。
   */
  const rendered = useMemo(
    () => (
      <ReactMarkdown
        key={renderKey}
        // 关掉单波浪删除线：中文文档里「6~8 月」「0~2 MW」这类区间写法太常见，
        // 同一段出现两个 `~` 就会被 remark-gfm 默认的 singleTilde 配对成删除线。
        // 成对 `~~删除~~` 不受影响；全角 `～` 本就不会触发（micromark 只认 ASCII ~）。
        remarkPlugins={remarkPlugins}
        // MinerU 与 pandoc 时代的老产物会出裸 HTML 图/表，不是 ![]()；不接 rehype-raw 会被转义掉。
        // docx/odt/rtf/epub 现在走 anydoc_writer.mjs 出的是 ![]()，但**别把这个插件删了**——上面两条路还在。
        rehypePlugins={rehypePlugins}
        disallowedElements={['script', 'iframe', 'object', 'embed']}
        components={mdComponents}
        urlTransform={stableUrlTransform}
      >
        {hoisted.text}
      </ReactMarkdown>
    ),
    [hoisted.text, renderKey, remarkPlugins, rehypePlugins, stableUrlTransform],
  );

  // 布局后根据真实 DOM 打 id，再回传目录 —— 彻底避开 render 期序号问题
  useLayoutEffect(() => {
    const items = syncHeadingsFromDom(rootRef.current);
    onHeadingsChangeRef.current?.(items);
  }, [children]);

  return (
    <div ref={rootRef} className="markdown-body max-w-[76ch]">
      <LinkContext.Provider value={linkHandlers}>{rendered}</LinkContext.Provider>
    </div>
  );
}
