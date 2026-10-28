import { useEffect, useState } from 'react';
import { Copy, FileOutput, FileText, GitCompare } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DiffView } from '@/components/DiffView';
import { writeClipboard } from '@/components/Primitives';
import { api, type DeliveryDocx, type DeliveryFinal, type DeliveryList, type DeliveryVersion } from '@/lib/api';
import { deaiPrompt } from '@/lib/deaiPrompt';
import { cn } from '@/lib/utils';

/**
 * 原稿的交付稿版本（去 AI 味）。只读：看板不写交付稿，只列出、切换、比对、转 Word。
 * 接口 404（旧服务进程）、出错，一律当成「没有交付稿」（版本条只剩原稿），不报错。
 */
export function useDeliveryVersions(projectId: string, docKey: string | undefined, refreshToken: unknown) {
  const [list, setList] = useState<DeliveryList | null>(null);
  /** 最近一次请求（成功或失败）落定时对应的 docKey：调用方据此区分「还在路上」和「确实没有」 */
  const [settledFor, setSettledFor] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!docKey) {
      setList(null);
      setSettledFor(undefined);
      return;
    }
    let alive = true;
    api.deliveryVersions(projectId, docKey)
      .then((data) => { if (alive) setList(Array.isArray(data.versions) ? data : null); })
      .catch(() => { if (alive) setList(null); })
      .finally(() => { if (alive) setSettledFor(docKey); });
    return () => {
      alive = false;
    };
  }, [projectId, docKey, refreshToken]);
  return { list, settledFor };
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

/** `final`：选中「定稿」时与最新一版（没有版本时与原稿）对比 */
export type CompareMode = 'source' | 'prev' | 'final';

/** `2026-10-22T16:30:00+08:00` → `10-22 16:30`；认不出原样返回 */
function shortTime(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : iso;
}

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
 * 「去 AI 味…」：只写剪贴板，不发写请求。取一次规则库只为写上版本号、判断要不要先补齐技能；
 * 取不到（旧服务 404、出错）也照样复制，只是不带版本号。
 */
export async function copyDeaiPrompt(projectId: string, sourcePath: string, nextPath?: string) {
  let installed = true;
  let rulesVersion: number | undefined;
  try {
    const rules = await api.deaiRules(projectId);
    installed = rules.installed !== false;
    rulesVersion = rules.version;
  } catch {
    // 旧服务没有这个接口、或读失败：按已安装处理，提示词里不写版本号
  }
  const ok = await writeClipboard(deaiPrompt({ sourcePath, rulesVersion, nextPath, installed }));
  if (ok) toast.success(installed ? '已复制，粘贴给工作空间 AI' : '已复制（含先补齐技能的步骤），粘贴给工作空间 AI');
  else toast.error('复制失败：浏览器没给剪贴板权限');
}

const actionClass = 'h-7 px-2 text-xs';

/**
 * 阅读器顶部的版本条：「原稿 · v001 · v002 …」切换阅读。产出三组的 .md 一律常驻，没有交付稿时只有「原稿」。
 * 选中原稿给「去 AI 味… / Word」，选中某一版给「对比 / Word」。批注统一走阅读器顶栏的铅笔。
 * Word 按钮看当前这份的成品：没有是「转成 Word」，有了变成「预览 Word」（在阅读器里就地切换）+「重新转换」
 * （上一份由脚本改名保留，不覆盖）。落点由调用方按 docxTargetOf 算好后传进来。
 * orange 只给「被直接改过」：版本上是有人绕过批注改了这一版，原稿上是原稿在最新一版之后又改过；待处理批注是中性灰。
 * 有 `定稿.md` 时最末多一个「定稿」（选中值 `final`）：只给「预览 Word」（最近一次定稿那份）和对比，
 * 不给去 AI 味 / 转 Word —— 定稿是交出去的事实记录。没有 `final`（旧服务、未定稿）时与改动前一致。
 * 选中某一版或定稿时另给「复制路径」：复制这份 .md 在工作空间内的相对路径。
 * `wordOnly`：输入转换产物。没有版本、去 AI 味、对比、定稿、复制路径，说明行写成品目录。
 */
export function DeliveryBar({
  versions,
  selected,
  onSelect,
  compare,
  onCompare,
  onDeai,
  docx,
  docxPreview,
  onDocxPreview,
  onConvert,
  final,
  wordOnly = false,
  docxDir,
}: {
  versions: DeliveryVersion[];
  /** `source` = 原稿，`final` = 定稿 */
  selected: string;
  onSelect: (version: string) => void;
  compare: CompareMode | null;
  onCompare: (mode: CompareMode | null) => void;
  /** 原稿的「去 AI 味…」 */
  onDeai: () => void;
  /** 当前选中这一份的 .docx；null = 还没转过。原稿可能是镜像目录，也可能是旁边的旧成品 */
  docx: DeliveryDocx | null;
  docxPreview: boolean;
  onDocxPreview: (on: boolean) => void;
  onConvert: () => void;
  final?: DeliveryFinal;
  /** 输入转换产物：只留 Word 按钮 */
  wordOnly?: boolean;
  /** `wordOnly` 时成品所在目录（工作空间相对路径） */
  docxDir?: string;
}) {
  const current = versions.find((v) => v.version === selected);
  const onFinal = selected === 'final' && Boolean(final);
  // 各版的 source_sha 照抄底版，最新一版代表交付稿目前跟到哪
  const sourceEdited = Boolean(versions[versions.length - 1]?.sourceChanged);
  // 交付稿各版与定稿给「复制路径」（工作空间内相对路径）；原稿的路径在顶栏已有
  const copyPath = onFinal ? final?.path : current?.path;
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
      {!v && sourceEdited ? (
        <Badge attention title="原稿在最新一版交付稿之后又改过，交付稿没跟上；需要的话再去一次 AI 味">被直接改过</Badge>
      ) : null}
      {v?.directlyEdited ? (
        <Badge attention title="改交付稿请走批注，直接改动不会沉淀成规则">被直接改过</Badge>
      ) : null}
      {v?.pendingNotes ? <Badge>{`${v.pendingNotes} 条待处理`}</Badge> : null}
    </button>
  );
  const compareButton = (mode: CompareMode, label: string, disabled?: boolean, title?: string) => (
    <Button
      variant={compare === mode ? 'secondary' : 'ghost'}
      size="sm"
      className={actionClass}
      aria-pressed={compare === mode}
      disabled={disabled}
      title={title}
      onClick={() => onCompare(compare === mode ? null : mode)}
    >
      <GitCompare className="size-3.5" />
      {label}
    </Button>
  );
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-3 py-2 sm:px-4">
      {wordOnly ? null : (
        <div className="flex flex-wrap items-center gap-1">
          {chip('source', '原稿')}
          {versions.map((v) => chip(v.version, v.version, v))}
          {final ? chip('final', '定稿') : null}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {wordOnly ? (
          <span className="min-w-0 flex-1 truncate" title={docxDir}>成品放在 {docxDir}</span>
        ) : onFinal && final ? (
          <span className="truncate" title={final.history.join('\n')}>
            {`第 ${final.count} 次定稿 · ${shortTime(final.finalizedAt)} · ${final.sourceName}`}
            {final.originalName ? `（原名 ${final.originalName}）` : ''}
            {final.note ? ` · ${final.note}` : ''}
          </span>
        ) : current ? (
          <>
            <span>
              {current.rulesVersion ? `规则 v${current.rulesVersion}` : '规则版本未记'}
              {current.hits ? ` · 命中 ${hitsTotal(current.hits)} 处` : ''}
              {current.notes.length ? ` · 由 ${notesRange(current.notes)} 修订` : current.basedOn === 'source' ? ' · 去味首版' : ''}
            </span>
            {current.note ? <span className="truncate" title={current.note}>{current.note}</span> : null}
          </>
        ) : (
          <span>若要作为交付稿，可以点右侧「去 AI 味」复制提示词，发给 AI 执行，以融入个人的写作风格。</span>
        )}
        <span className="ml-auto flex flex-wrap gap-1">
          {!wordOnly && copyPath ? (
            <Button
              variant="ghost"
              size="sm"
              className={actionClass}
              title={copyPath}
              onClick={() => {
                void writeClipboard(copyPath).then((ok) => {
                  if (ok) toast.success('已复制路径');
                  else toast.error('复制失败：浏览器没给剪贴板权限');
                });
              }}
            >
              <Copy className="size-3.5" />
              复制路径
            </Button>
          ) : null}
          {wordOnly ? null : onFinal ? (
            compareButton('final', versions.length ? '与最新一版对比' : '与原稿对比')
          ) : current ? (
            <>
              {compareButton('source', '与原稿对比')}
              {compareButton(
                'prev',
                '与上一版对比',
                current.basedOn === 'source' || !current.basedOn,
                current.basedOn === 'source' ? '这是去味首版，上一版就是原稿' : undefined,
              )}
            </>
          ) : (
            <Button variant="ghost" size="sm" className={actionClass} title="复制去 AI 味的提示词" onClick={onDeai}>
              <Copy className="size-3.5" />
              去 AI 味…
            </Button>
          )}
          {docx ? (
            <>
              <Button
                variant={docxPreview ? 'secondary' : 'ghost'}
                size="sm"
                className={actionClass}
                aria-pressed={docxPreview}
                title={docxPreview ? '回到正文' : docx.path}
                onClick={() => onDocxPreview(!docxPreview)}
              >
                <FileText className="size-3.5" />
                预览 Word
              </Button>
              {onFinal ? null : <Button
                variant="ghost"
                size="sm"
                className={actionClass}
                disabled={!docx.generated}
                title={docx.generated
                  ? '按当前正文重新转换；上一份改名为「基名-上次转换时间.docx」保留，不覆盖'
                  : '同名的 Word 不是本工具生成的，为避免覆盖人工修改，请先改名或移走'}
                onClick={onConvert}
              >
                <FileOutput className="size-3.5" />
                重新转换
              </Button>}
            </>
          ) : onFinal ? null : (
            <Button variant="ghost" size="sm" className={actionClass} onClick={onConvert}>
              <FileOutput className="size-3.5" />
              转成 Word
            </Button>
          )}
        </span>
      </div>
    </div>
  );
}

function stripFrontmatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** 两份全文对比（左旧右新）；front-matter 不参与比对。路径由调用方按版本条的选中值算好。 */
export function DeliveryDiff({
  projectId,
  left,
  right,
}: {
  projectId: string;
  left: { path: string; label: string };
  right: { path: string; label: string };
}) {
  const [texts, setTexts] = useState<{ left: string; right: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setTexts(null);
    setError('');
    Promise.all([api.file(projectId, left.path), api.file(projectId, right.path)])
      .then(([l, r]) => {
        if (!alive) return;
        setTexts({ left: stripFrontmatter(String(l.content ?? '')), right: stripFrontmatter(String(r.content ?? '')) });
      })
      .catch((err: Error) => { if (alive) setError(err.message); });
    return () => {
      alive = false;
    };
  }, [projectId, left.path, right.path]);
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!texts) return <p className="text-sm text-muted-foreground">读取中…</p>;
  return <DiffView left={texts.left} right={texts.right} leftLabel={left.label} rightLabel={right.label} />;
}
