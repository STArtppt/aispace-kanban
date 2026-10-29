import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

type DiffLib = typeof import('diff');

/** 超过这么多行只按段对比（逐字对比在长文档上太慢，也看不过来） */
const CHAR_DIFF_LINE_LIMIT = 2000;
/** 未变的连续段落超过这么多字就折叠 */
const FOLD_CHARS = 240;

interface Part {
  kind: 'same' | 'added' | 'removed' | 'changed';
  /** same / added / removed：段落列表 */
  paras?: string[];
  /** changed：一对改动过的段落，段内按字对比 */
  before?: string;
  after?: string;
}

/** 按空行切段；段内换行保留（列表、表格行在同一段里） */
function paragraphs(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

function diffParts(lib: DiffLib, left: string, right: string, charLevel: boolean): Part[] {
  const out: Part[] = [];
  const chunks = lib.diffArrays(paragraphs(left), paragraphs(right));
  for (let i = 0; i < chunks.length; i += 1) {
    const c = chunks[i];
    const next = chunks[i + 1];
    if (!c.added && !c.removed) {
      out.push({ kind: 'same', paras: c.value });
      continue;
    }
    // 删一段紧跟着加一段：当成「这一段改了」，段内按字标出改动
    if (charLevel && c.removed && next?.added) {
      const n = Math.min(c.value.length, next.value.length);
      for (let k = 0; k < n; k += 1) out.push({ kind: 'changed', before: c.value[k], after: next.value[k] });
      if (c.value.length > n) out.push({ kind: 'removed', paras: c.value.slice(n) });
      if (next.value.length > n) out.push({ kind: 'added', paras: next.value.slice(n) });
      i += 1;
      continue;
    }
    out.push({ kind: c.added ? 'added' : 'removed', paras: c.value });
  }
  return out;
}

/** 段内改动的字：深一档的底色；删掉的字再加删除线，红绿色弱也分得出来 */
const ADDED = 'rounded-sm bg-diff-add-strong text-foreground';
const REMOVED = 'rounded-sm bg-diff-del-strong text-foreground line-through decoration-diff-del-edge/70';
/** 整段新增 / 删除：浅底 + 左边线 */
const ADDED_LINE = 'border-l-2 border-diff-add-edge bg-diff-add text-foreground';
const REMOVED_LINE = 'border-l-2 border-diff-del-edge bg-diff-del text-foreground';
const PARA = 'relative whitespace-pre-wrap break-words px-2 py-1 text-sm leading-6';

type Sign = '+' | '-';

/** 行首的 + / − 记号，和 git 一样；不靠颜色也能看出是增还是删 */
function SignMark({ sign }: { sign: Sign }) {
  return (
    <span aria-hidden className={cn('absolute left-2 select-none font-mono', sign === '+' ? 'text-diff-add-edge' : 'text-diff-del-edge')}>
      {sign === '+' ? '+' : '−'}
    </span>
  );
}

function Para({ text, className, sign }: { text: string; className?: string; sign?: Sign }) {
  return (
    <p className={cn(PARA, sign && 'pl-6', className)}>
      {sign ? <SignMark sign={sign} /> : null}
      {text}
    </p>
  );
}

/** 双栏的一行：左旧右新，同一行两侧等高，所以对应段落始终并排 */
function SplitRow({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="grid grid-cols-2 divide-x divide-border">
      <div className="min-w-0">{left}</div>
      <div className="min-w-0">{right}</div>
    </div>
  );
}

/** 一侧没有对应内容时的占位：灰底，不上色，免得被看成改动 */
const BLANK = <div className="h-full min-h-8 bg-muted" />;

/** 改动过的段落在双栏里：左侧只标删掉的字，右侧只标加上的字 */
function SplitChanged({ lib, before, after }: { lib: DiffLib; before: string; after: string }) {
  const parts = useMemo(() => lib.diffChars(before, after), [lib, before, after]);
  const side = (keep: 'added' | 'removed') => (
    <p className={cn(PARA, 'h-full pl-6', keep === 'added' ? ADDED_LINE : REMOVED_LINE)}>
      <SignMark sign={keep === 'added' ? '+' : '-'} />
      {parts.map((p, i) => {
        if (p.added && keep !== 'added') return null;
        if (p.removed && keep !== 'removed') return null;
        return <span key={i} className={p.added ? ADDED : p.removed ? REMOVED : undefined}>{p.value}</span>;
      })}
    </p>
  );
  return <SplitRow left={side('removed')} right={side('added')} />;
}

function SplitSame({ paras }: { paras: string[] }) {
  const long = paras.join('').length > FOLD_CHARS && paras.length > 1;
  const [open, setOpen] = useState(false);
  if (!long || open) {
    return (
      <div className="text-muted-foreground">
        {paras.map((p, i) => <SplitRow key={i} left={<Para text={p} />} right={<Para text={p} />} />)}
      </div>
    );
  }
  return (
    <div className="text-muted-foreground">
      <SplitRow left={<Para text={paras[0]} className="line-clamp-2" />} right={<Para text={paras[0]} className="line-clamp-2" />} />
      <button type="button" onClick={() => setOpen(true)} className="my-1 w-full border-y border-dashed border-border px-2 py-0.5 text-xs hover:bg-accent">
        展开未改动的 {paras.length - 1} 段
      </button>
    </div>
  );
}

/**
 * 两份文本的差异：先按段对比，改动过的段再按字对比；未变的长段落默认折叠。
 * 双栏：左旧右新、对应段落并排，像 git 的 side-by-side diff。
 * jsdiff（npm `diff`）动态 import，只在打开对比视图时加载，不进首屏包。
 * 配色走 globals.css 的 diff-* 令牌：绿增红删（git 习惯，全站唯一的彩色例外），删掉的字另加删除线，
 * 整段增删带 + / − 记号，红绿色弱也能分。
 */
export function DiffView({
  left,
  right,
  leftLabel,
  rightLabel,
}: {
  left: string;
  right: string;
  leftLabel: string;
  rightLabel: string;
}) {
  const [lib, setLib] = useState<DiffLib | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    import('diff')
      .then((m) => { if (alive) setLib(m); })
      .catch(() => { if (alive) setFailed(true); });
    return () => {
      alive = false;
    };
  }, []);

  const lines = left.split('\n').length + right.split('\n').length;
  const charLevel = lines <= CHAR_DIFF_LINE_LIMIT * 2;
  const parts = useMemo(() => (lib ? diffParts(lib, left, right, charLevel) : []), [lib, left, right, charLevel]);
  const count = (kind: Part['kind']) =>
    parts.reduce((n, p) => n + (p.kind !== kind ? 0 : kind === 'changed' ? 1 : p.paras?.length ?? 0), 0);
  const stats = { changed: count('changed'), added: count('added'), removed: count('removed') };
  const anyChange = stats.changed + stats.added + stats.removed > 0;

  if (failed) return <p className="px-2 py-4 text-sm text-destructive">对比组件加载失败（可能是网络中断或看板刚升级），刷新页面再试。</p>;
  if (!lib) return <p className="px-2 py-4 text-sm text-muted-foreground">正在比对…</p>;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          <span className="rounded-sm bg-diff-del px-1 text-foreground">{leftLabel}</span>
          {' → '}
          <span className="rounded-sm bg-diff-add px-1 text-foreground">{rightLabel}</span>
        </span>
        {anyChange ? (
          <span className="flex gap-3">
            {stats.changed ? <span>改 {stats.changed} 段</span> : null}
            {stats.added ? <span className="text-diff-add-edge">+{stats.added} 段</span> : null}
            {stats.removed ? <span className="text-diff-del-edge">−{stats.removed} 段</span> : null}
          </span>
        ) : (
          <span>两版正文相同</span>
        )}
        {!charLevel ? <span>文档超过 {CHAR_DIFF_LINE_LIMIT} 行，只按段对比，段内不逐字标出</span> : null}
      </div>
      <div className="flex flex-col overflow-hidden rounded-lg border border-border">
        <SplitRow
          left={<div className="truncate border-b-2 border-diff-del-edge px-2 py-1 text-xs text-muted-foreground">{leftLabel}</div>}
          right={<div className="truncate border-b-2 border-diff-add-edge px-2 py-1 text-xs text-muted-foreground">{rightLabel}</div>}
        />
        <div className="flex flex-col gap-0.5 py-2">
          {parts.map((p, i) => {
            if (p.kind === 'same') return <SplitSame key={i} paras={p.paras ?? []} />;
            if (p.kind === 'changed') return <SplitChanged key={i} lib={lib} before={p.before ?? ''} after={p.after ?? ''} />;
            // 删一组紧跟着加一组（超长文档不逐字时会这样）：两侧并排放，不各占一行错开
            const prev = parts[i - 1];
            if (p.kind === 'added' && prev?.kind === 'removed') return null;
            const next = parts[i + 1];
            const removed = p.kind === 'removed' ? p.paras ?? [] : [];
            const added = p.kind === 'added' ? p.paras ?? [] : next?.kind === 'added' ? next.paras ?? [] : [];
            return Array.from({ length: Math.max(removed.length, added.length) }, (_, k) => (
              <SplitRow
                key={`${i}-${k}`}
                left={k < removed.length ? <Para text={removed[k]} sign="-" className={cn('h-full', REMOVED_LINE)} /> : BLANK}
                right={k < added.length ? <Para text={added[k]} sign="+" className={cn('h-full', ADDED_LINE)} /> : BLANK}
              />
            ));
          })}
        </div>
      </div>
    </div>
  );
}
