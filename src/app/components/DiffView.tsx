import { useEffect, useMemo, useState } from 'react';
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

const ADDED = 'rounded-sm bg-selected text-foreground';
const REMOVED = 'rounded-sm text-muted-foreground line-through decoration-muted-foreground/70';

function Para({ text, className }: { text: string; className?: string }) {
  return <p className={cn('whitespace-pre-wrap break-words px-2 py-1 text-sm leading-6', className)}>{text}</p>;
}

function Changed({ lib, before, after }: { lib: DiffLib; before: string; after: string }) {
  const parts = useMemo(() => lib.diffChars(before, after), [lib, before, after]);
  return (
    <p className="whitespace-pre-wrap break-words border-l-2 border-foreground/40 px-2 py-1 text-sm leading-6">
      {parts.map((p, i) => (
        <span key={i} className={p.added ? ADDED : p.removed ? REMOVED : undefined}>{p.value}</span>
      ))}
    </p>
  );
}

function Same({ paras }: { paras: string[] }) {
  const long = paras.join('').length > FOLD_CHARS && paras.length > 1;
  const [open, setOpen] = useState(false);
  if (!long || open) {
    return <div className="text-muted-foreground">{paras.map((p, i) => <Para key={i} text={p} />)}</div>;
  }
  return (
    <div className="text-muted-foreground">
      <Para text={paras[0]} className="line-clamp-2" />
      <button type="button" onClick={() => setOpen(true)} className="mx-2 my-1 rounded-md border border-dashed border-border px-2 py-0.5 text-xs hover:bg-accent">
        展开未改动的 {paras.length - 1} 段
      </button>
    </div>
  );
}

/**
 * 两份文本的差异：先按段对比，改动过的段再按字对比；未变的长段落默认折叠。
 * jsdiff（npm `diff`）动态 import，只在打开对比视图时加载，不进首屏包。
 * 配色只用令牌：新增是浅灰底，删除是删除线 + 次要色（黑白灰；orange 留给「需要注意」）。
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
  const changed = parts.filter((p) => p.kind !== 'same').length;

  if (failed) return <p className="px-2 py-4 text-sm text-destructive">对比组件加载失败（可能是网络中断或看板刚升级），刷新页面再试。</p>;
  if (!lib) return <p className="px-2 py-4 text-sm text-muted-foreground">正在比对…</p>;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          <span className={cn(REMOVED, 'px-1')}>{leftLabel}</span>
          {' → '}
          <span className={cn(ADDED, 'px-1')}>{rightLabel}</span>
        </span>
        <span>{changed ? `${changed} 处改动` : '两版正文相同'}</span>
        {!charLevel ? <span>文档超过 {CHAR_DIFF_LINE_LIMIT} 行，只按段对比，段内不逐字标出</span> : null}
      </div>
      <div className="flex flex-col gap-0.5 rounded-lg border border-border py-2">
        {parts.map((p, i) => {
          if (p.kind === 'same') return <Same key={i} paras={p.paras ?? []} />;
          if (p.kind === 'changed') return <Changed key={i} lib={lib} before={p.before ?? ''} after={p.after ?? ''} />;
          return (p.paras ?? []).map((text, k) => (
            <Para
              key={`${i}-${k}`}
              text={text}
              className={cn('border-l-2', p.kind === 'added' ? `border-foreground/40 ${ADDED}` : `border-border ${REMOVED}`)}
            />
          ));
        })}
      </div>
    </div>
  );
}
