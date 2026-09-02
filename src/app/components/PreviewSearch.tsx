import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { collectBlocks, type BlockEntry, type SearchJumper } from '@/lib/blockIndex';
import { searchBlocks, type SnippetPart } from '@/lib/fuzzySearch';
import { cn } from '@/lib/utils';

/** 结果列表里的一条。`pick` 自己知道怎么定位 —— 本地是滚到块,整表是先翻页再滚到行 */
export interface PreviewSearchHit {
  key: string;
  /** 条目前缀,如「第 96,000 行」;本地检索没有前缀 */
  label?: string;
  parts: SnippetPart[];
  /** 选中时执行的定位动作(滚动 + 临时高亮)。定位不到就什么都不做,不报错 */
  pick: () => void;
}

export interface PreviewSearchOutcome {
  hits: PreviewSearchHit[];
  /** 命中总数(截断前);拿不到确切数时给已知的条数 */
  total: number;
  /** 结果被截断,列表只有前若干条 */
  truncated: boolean;
  /** 结果区顶部的一句话,缺省是「N 处命中」 */
  summary?: string;
  /** 列表底部的如实说明,如「只扫到第 N 行,后面还没扫」 */
  notice?: string;
  /** 零命中时的补充说明 */
  emptyHint?: string;
}

/** 异步结果源。signal 会在改词 / 关检索条 / 卸载时 abort,实现方要把它透传下去 */
export type PreviewSearchSource = (
  query: string,
  signal: AbortSignal,
) => Promise<PreviewSearchOutcome>;

type ResultState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; outcome: PreviewSearchOutcome };

/**
 * 预览内容区左上角的检索浮层。不进标题栏、不随正文滚动。
 * 收起是一颗方钮;点开后输入框向右展开,有输入才落下结果列表。
 *
 * 两种数据源,同一套开合 / 键盘 / 输入法行为:
 * - 默认**本地**:对着当前正文根现建块索引,关闭即丢弃,不发请求;
 * - 传了 `source` 就走**异步**(表格整表检索),多出「检索中 / 失败 / 没扫完」三种态。
 *
 * 键盘与输入法那套是这里最容易写错的部分,所以只有一份实现 —— 别为第二种数据源
 * 另抄一个组件出来。
 */
export function PreviewSearch({
  getBlocksRoot,
  jumper,
  emptyHint,
  source,
}: {
  /** 返回当前正文根(.markdown-body / 纯文本 <pre> / 表格 <table>);检索时调用 */
  getBlocksRoot: () => HTMLElement | null;
  /** 跳转与临时高亮控制器;归上层所有,检索条关了高亮还得走完两秒 */
  jumper: SearchJumper;
  /** 空态额外说明。缺省只说「只覆盖当前这一份」 */
  emptyHint?: string;
  /** 传了就用它取结果(整表检索);不传走本地块索引 */
  source?: PreviewSearchSource;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const getRootRef = useRef(getBlocksRoot);
  getRootRef.current = getBlocksRoot;
  // 结果源每次渲染都是新函数,放 ref 里,免得 effect 因为它变化就重跑一次检索
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const remote = Boolean(source);
  const blocksRef = useRef<BlockEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [state, setState] = useState<ResultState>({ status: 'idle' });
  const [current, setCurrent] = useState(0);

  const results = state.status === 'done' ? state.outcome.hits : [];

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setDebounced('');
    setState({ status: 'idle' });
    setCurrent(0);
    blocksRef.current = [];
    buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // 输入防抖。整表检索每次都要在服务端扫一遍表,比本地多留一点时间,少扫几趟
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => setDebounced(query.trim()), remote ? 350 : 200);
    return () => window.clearTimeout(timer);
  }, [query, open, remote]);

  useEffect(() => {
    if (!open || !debounced) {
      setState({ status: 'idle' });
      setCurrent(0);
      if (!open) blocksRef.current = [];
      return;
    }
    const run = sourceRef.current;
    if (!run) {
      // 本地:每次检索现建索引 —— 表格翻页后 DOM 已经换了,不能沿用打开那一刻的单元格
      const blocks = collectBlocks(getRootRef.current());
      blocksRef.current = blocks;
      const { hits, total, truncated } = searchBlocks(blocks, debounced);
      setState({
        status: 'done',
        outcome: {
          total,
          truncated,
          emptyHint,
          hits: hits.map((hit) => ({
            key: String(hit.index),
            parts: hit.parts,
            // 定位不到(块元素已不在)时 jumper 静默返回:滚动位置不动,不报错
            pick: () => jumper.jump(blocksRef.current[hit.index]?.el),
          })),
        },
      });
      setCurrent(0);
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    run(debounced, controller.signal)
      .then((outcome) => {
        if (controller.signal.aborted) return;
        setState({ status: 'done', outcome });
        setCurrent(0);
      })
      .catch((err: Error) => {
        // 自己取消的不算失败:用户改词而已
        if (controller.signal.aborted || err.name === 'AbortError') return;
        setState({ status: 'error', message: err.message });
      });
    return () => controller.abort();
  }, [open, debounced, emptyHint, jumper]);

  // 当前项(尤其键盘走动时)始终在列表可视范围内
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-hit-index="${current}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [current, results]);

  const select = (hit: PreviewSearchHit) => {
    hit.pick();
    close();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // 输入法组合期整条快捷键链让位:Enter 是上屏候选、上下是翻候选、Esc 是取消组合。
    // keyCode 229 兜 Safari 那种 isComposing 已翻 false 但还在组合里的怪账。
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!results.length) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setCurrent((index) => (index + delta + results.length) % results.length);
      return;
    }
    if (event.key === 'Enter') {
      if (!results.length) return;
      event.preventDefault();
      event.stopPropagation();
      const hit = results[current];
      if (hit) select(hit);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  // 点检索条外关闭。开合按钮在容器内,它的 mousedown 不算"外"。
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (containerRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open, close]);

  const outcome = state.status === 'done' ? state.outcome : null;

  return (
    <div
      ref={containerRef}
      // 左缘跟预览顶栏标题对齐(header px-3 sm:px-4);顶缘跟左侧清单标题行
      // (产出列表 / 输入列表,ScrollArea py-4 + min-h-8)垂直居中
      className="absolute top-4 left-3 z-20 w-fit max-w-[calc(100%-1.5rem)] sm:left-4"
    >
      <div
        className={cn(
          // 收起态照抄左侧清单的可展开搜索框(ExpandableSearch → Input):
          // 同样的 rounded-lg / border-input / bg-background / shadow-sm,尺寸也同为 8
          'flex h-8 items-center overflow-hidden rounded-lg border border-input bg-background shadow-sm',
          'transition-[width,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
          'focus-within:border-ring',
          // 收起时半透明:悬浮在 csv 表格上方会挡住表头与首行,让它透出来;
          // 悬停 / 有焦点 / 展开后都恢复不透明,免得输入时正文透上来干扰阅读
          open
            ? 'w-72 max-w-full opacity-100'
            : 'w-8 opacity-85 hover:opacity-100 focus-within:opacity-100',
        )}
      >
        <button
          ref={buttonRef}
          type="button"
          aria-label={remote ? '搜索整张表' : '搜索本篇内容'}
          aria-expanded={open}
          className="flex size-8 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
          onClick={() => (open ? close() : setOpen(true))}
        >
          <Search className="size-3.5" />
        </button>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={remote ? '在整张表中搜索…' : '在当前内容中搜索…'}
          aria-label={remote ? '搜索整张表' : '搜索当前内容'}
          tabIndex={open ? 0 : -1}
          className={cn(
            'h-8 min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground',
            open ? 'pr-1' : 'pointer-events-none caret-transparent',
          )}
        />
        {open && query ? (
          <button
            type="button"
            aria-label="清空搜索"
            className="flex size-8 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
            // 拦住失焦,点完清空还能接着键入
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setQuery('');
              inputRef.current?.focus();
            }}
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>

      {open && debounced ? (
        <div className="absolute top-[calc(100%+0.25rem)] left-0 z-20 w-full overflow-hidden rounded-lg border border-border bg-popover shadow-md">
          {state.status === 'loading' ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">正在扫描整张表…</p>
          ) : null}

          {/* 失败就说失败。**不能**退回"没找到"—— 那会让人以为整张表里真的没有 */}
          {state.status === 'error' ? (
            <p className="px-3 py-3 text-xs leading-5 text-destructive">
              检索失败：{state.message}
            </p>
          ) : null}

          {outcome && outcome.hits.length ? (
            <>
              <p className="border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
                {outcome.summary ?? `${outcome.total} 处命中`}
              </p>
              <div ref={listRef} className="max-h-64 overflow-y-auto">
                {outcome.hits.map((hit, index) => (
                  <button
                    key={hit.key}
                    type="button"
                    data-hit-index={index}
                    onMouseEnter={() => setCurrent(index)}
                    onClick={() => select(hit)}
                    className={cn(
                      'block w-full border-b border-border/60 px-3 py-2 text-left text-xs leading-5 break-all last:border-b-0',
                      index === current
                        ? 'bg-accent text-foreground'
                        : 'text-foreground/90 hover:bg-accent/60',
                    )}
                  >
                    {hit.label ? (
                      <span className="mr-1.5 font-mono text-[11px] text-muted-foreground">
                        {hit.label}
                      </span>
                    ) : null}
                    {hit.parts.map((part, i) =>
                      part.matched ? (
                        <strong key={i} className="font-semibold text-foreground">
                          {part.text}
                        </strong>
                      ) : (
                        <span key={i}>{part.text}</span>
                      ),
                    )}
                  </button>
                ))}
              </div>
              <p className="border-t border-border px-3 py-1.5 text-[11px] leading-4 text-muted-foreground">
                {outcome.truncated ? `只显示前 ${outcome.hits.length} 条 · ` : ''}
                ↑↓ 选择,Enter 跳转,Esc 关闭
                {outcome.notice ? <span className="mt-1 block">{outcome.notice}</span> : null}
              </p>
            </>
          ) : null}

          {outcome && !outcome.hits.length ? (
            // 措辞要点明搜的到底是什么范围,别让人误以为搜遍了全部
            <p className="px-3 py-3 text-xs leading-5 text-muted-foreground">
              没有匹配「{debounced}」的内容。
              {outcome.emptyHint
                ? ` ${outcome.emptyHint}`
                : ' 搜索只覆盖当前打开的这一份,不含工作空间里的其他文件。'}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
