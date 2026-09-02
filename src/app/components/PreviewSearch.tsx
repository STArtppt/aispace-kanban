import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { collectBlocks, type BlockEntry, type SearchJumper } from '@/lib/blockIndex';
import { SEARCH_RESULT_LIMIT, searchBlocks, type SearchHit } from '@/lib/fuzzySearch';
import { cn } from '@/lib/utils';

/**
 * 预览内容区左上角的检索浮层。不进标题栏、不随正文滚动。
 * 收起是一颗方钮;点开后输入框向右展开,有输入才落下结果列表。
 *
 * 索引在每次检索时对着当前正文根建,关闭即丢弃 —— 表格翻页后下一轮搜索
 * 自然对着新的这一页,不会拿着旧单元格跳。
 * 全程本地计算,不发请求、不写任何东西。
 */
export function PreviewSearch({
  getBlocksRoot,
  jumper,
  emptyHint,
}: {
  /** 返回当前正文根(.markdown-body / 纯文本 <pre> / 表格 <table>);检索时调用 */
  getBlocksRoot: () => HTMLElement | null;
  /** 跳转与临时高亮控制器;归上层所有,检索条关了高亮还得走完两秒 */
  jumper: SearchJumper;
  /** 空态额外说明,如表格只搜当前页。缺省只说「只覆盖当前这一份」 */
  emptyHint?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const getRootRef = useRef(getBlocksRoot);
  getRootRef.current = getBlocksRoot;
  const blocksRef = useRef<BlockEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [current, setCurrent] = useState(0);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setDebounced('');
    setResults([]);
    setTotal(0);
    setTruncated(false);
    setCurrent(0);
    blocksRef.current = [];
    buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // 输入防抖约 200ms,连续敲键不重复扫语料
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => setDebounced(query.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [query, open]);

  useEffect(() => {
    if (!open || !debounced) {
      setResults([]);
      setTotal(0);
      setTruncated(false);
      setCurrent(0);
      if (!open) blocksRef.current = [];
      return;
    }
    // 每次检索现建:表格翻页后 DOM 已经换了,不能沿用打开那一刻的单元格
    const blocks = collectBlocks(getRootRef.current());
    blocksRef.current = blocks;
    const { hits, total: matched, truncated: cut } = searchBlocks(blocks, debounced);
    setResults(hits);
    setTotal(matched);
    setTruncated(cut);
    setCurrent(0);
  }, [open, debounced]);

  // 当前项(尤其键盘走动时)始终在列表可视范围内
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-hit-index="${current}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [current, results]);

  const select = (hit: SearchHit) => {
    // 定位不到(块元素已不在)时 jumper 静默返回:检索条照常关,滚动位置不动
    jumper.jump(blocksRef.current[hit.index]?.el);
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
          aria-label="搜索本篇内容"
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
          placeholder="在当前内容中搜索…"
          aria-label="搜索当前内容"
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
          {results.length ? (
            <>
              <p className="border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
                {total} 处命中
              </p>
              <div ref={listRef} className="max-h-64 overflow-y-auto">
                {results.map((hit, index) => (
                  <button
                    key={hit.index}
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
              <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
                {truncated ? `结果太多,只显示前 ${SEARCH_RESULT_LIMIT} 条 · ` : ''}
                ↑↓ 选择,Enter 跳转,Esc 关闭
              </p>
            </>
          ) : (
            // 措辞要点明"只搜了当前这一份",别让人误以为搜遍了全部
            <p className="px-3 py-3 text-xs leading-5 text-muted-foreground">
              这份内容里没有匹配「{debounced}」的文字。搜索只覆盖当前打开的这一份,
              不含工作空间里的其他文件。
              {emptyHint ? ` ${emptyHint}` : ''}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
