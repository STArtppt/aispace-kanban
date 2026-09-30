import { useEffect, useState } from 'react';
import { FileOutput, GitCompare, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DiffView } from '@/components/DiffView';
import { api, type DeliveryList, type DeliveryVersion } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * 原稿的交付稿版本（去 AI 味）。只读：看板不写交付稿，只列出、切换、比对、转 Word。
 * 接口 404（旧服务进程）、出错、没有交付稿，一律当成「没有版本条」，不报错。
 */
export function useDeliveryVersions(projectId: string, docKey: string | undefined, refreshToken: unknown) {
  const [list, setList] = useState<DeliveryList | null>(null);
  useEffect(() => {
    if (!docKey) {
      setList(null);
      return;
    }
    let alive = true;
    api.deliveryVersions(projectId, docKey)
      .then((data) => { if (alive) setList(Array.isArray(data.versions) ? data : null); })
      .catch(() => { if (alive) setList(null); });
    return () => {
      alive = false;
    };
  }, [projectId, docKey, refreshToken]);
  return list;
}

/** `R001×13, R004×40` → 53 */
export function hitsTotal(hits: string): number {
  return [...hits.matchAll(/[×xX*]\s*(\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
}

/** `N0001, N0002, N0003` → `N0001–N0003`；不连续就原样用顿号连 */
export function notesRange(notes: string[]): string {
  const nums = notes.map((n) => Number(n.replace(/^N/, ''))).filter(Number.isFinite);
  if (nums.length > 2 && nums.every((n, i) => i === 0 || n === nums[i - 1] + 1)) {
    return `${notes[0]}–${notes[notes.length - 1]}`;
  }
  return notes.join('、');
}

export type CompareMode = 'source' | 'prev';

function Badge({ children, attention, title }: { children: string; attention?: boolean; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        'rounded px-1 text-[10px] leading-4',
        attention ? 'border border-destructive/60 text-destructive' : 'border border-border text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

/**
 * 阅读器顶部的版本条：「原稿 · v001 · v002 …」切换阅读；选中某一版时给出对比、批注、转成 Word。
 * orange 只给「原稿已更新」「被直接改过」这两种需要人处理的状态；待处理批注是中性灰。
 */
export function DeliveryBar({
  versions,
  selected,
  onSelect,
  compare,
  onCompare,
  onAnnotate,
  onConvert,
}: {
  versions: DeliveryVersion[];
  /** `source` = 原稿 */
  selected: string;
  onSelect: (version: string) => void;
  compare: CompareMode | null;
  onCompare: (mode: CompareMode | null) => void;
  onAnnotate: () => void;
  onConvert: (version: DeliveryVersion) => void;
}) {
  const current = versions.find((v) => v.version === selected);
  const chip = (key: string, label: string, v?: DeliveryVersion) => (
    <button
      key={key}
      type="button"
      aria-pressed={selected === key}
      onClick={() => onSelect(key)}
      className={cn(
        'flex items-center gap-1 rounded-md px-2 py-0.5 text-xs transition-colors',
        selected === key ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-accent',
      )}
    >
      {label}
      {v?.sourceChanged ? <Badge attention title="原稿在这一版之后又改过">原稿已更新</Badge> : null}
      {v?.directlyEdited ? (
        <Badge attention title="改交付稿请走批注，直接改动不会沉淀成规则">被直接改过</Badge>
      ) : null}
      {v?.pendingNotes ? <Badge>{`${v.pendingNotes} 条待处理`}</Badge> : null}
    </button>
  );
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-3 py-2 sm:px-4">
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs text-muted-foreground">交付稿</span>
        {chip('source', '原稿')}
        {versions.map((v) => chip(v.version, v.version, v))}
      </div>
      {current ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {current.rulesVersion ? `规则 v${current.rulesVersion}` : '规则版本未记'}
            {current.hits ? ` · 命中 ${hitsTotal(current.hits)} 处` : ''}
            {current.notes.length ? ` · 由 ${notesRange(current.notes)} 修订` : current.basedOn === 'source' ? ' · 去味首版' : ''}
          </span>
          {current.note ? <span className="truncate" title={current.note}>{current.note}</span> : null}
          <span className="ml-auto flex flex-wrap gap-1">
            <Button
              variant={compare === 'source' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 px-2 text-xs"
              aria-pressed={compare === 'source'}
              onClick={() => onCompare(compare === 'source' ? null : 'source')}
            >
              <GitCompare className="size-3.5" />
              与原稿对比
            </Button>
            <Button
              variant={compare === 'prev' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 px-2 text-xs"
              aria-pressed={compare === 'prev'}
              disabled={current.basedOn === 'source' || !current.basedOn}
              title={current.basedOn === 'source' ? '这是去味首版，上一版就是原稿' : undefined}
              onClick={() => onCompare(compare === 'prev' ? null : 'prev')}
            >
              <GitCompare className="size-3.5" />
              与上一版对比
            </Button>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onAnnotate}>
              <Pencil className="size-3.5" />
              批注
            </Button>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onConvert(current)}>
              <FileOutput className="size-3.5" />
              转成 Word
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

function stripFrontmatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** 两版全文对比。左边是原稿或 `based_on` 那一版，右边是当前这一版；front-matter 不参与比对。 */
export function DeliveryDiff({
  projectId,
  source,
  versions,
  current,
  mode,
}: {
  projectId: string;
  source: string;
  versions: DeliveryVersion[];
  current: DeliveryVersion;
  mode: CompareMode;
}) {
  const base = mode === 'prev' ? versions.find((v) => v.version === current.basedOn) : undefined;
  const leftPath = base?.path ?? source;
  const leftLabel = base ? base.version : '原稿';
  const [texts, setTexts] = useState<{ left: string; right: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setTexts(null);
    setError('');
    Promise.all([api.file(projectId, leftPath), api.file(projectId, current.path)])
      .then(([l, r]) => {
        if (!alive) return;
        setTexts({ left: stripFrontmatter(String(l.content ?? '')), right: stripFrontmatter(String(r.content ?? '')) });
      })
      .catch((err: Error) => { if (alive) setError(err.message); });
    return () => {
      alive = false;
    };
  }, [projectId, leftPath, current.path]);
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!texts) return <p className="text-sm text-muted-foreground">读取中…</p>;
  return <DiffView left={texts.left} right={texts.right} leftLabel={leftLabel} rightLabel={current.version} />;
}
