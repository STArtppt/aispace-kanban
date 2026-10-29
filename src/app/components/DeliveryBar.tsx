import { useEffect, useRef, useState } from 'react';
import { Check, Copy, FileOutput, FileText, GitCompare, Menu, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
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
/** 标签区至少要留这么宽（px），再窄就把按钮收进「更多」菜单 */
const MIN_CHIPS_WIDTH = 128;

interface BarAction {
  key: string;
  icon: LucideIcon;
  label: string;
  title?: string;
  disabled?: boolean;
  /** 开关类按钮（对比、预览 Word）：是否正开着 */
  pressed?: boolean;
  onClick: () => void;
}

/**
 * 量宽用的「最宽一组」按钮：选某一版时最多（复制路径 + 两个对比 + 预览 Word + 重新转换）。
 * 收不收起只看这组放不放得下，不随选中的是原稿 / 某一版 / 定稿变来变去。
 */
const WIDEST_ACTIONS: { icon: LucideIcon; label: string }[] = [
  { icon: Copy, label: '复制路径' },
  { icon: GitCompare, label: '与原稿对比' },
  { icon: GitCompare, label: '与上一版对比' },
  { icon: FileText, label: '预览 Word' },
  { icon: FileOutput, label: '重新转换' },
];
const WIDEST_WORD_ONLY = WIDEST_ACTIONS.slice(3);

/**
 * 阅读器顶部的版本条：「原稿 · v001 · v002 …」切换阅读。产出三组的 .md 一律常驻，没有交付稿时只有「原稿」。
 * 选中原稿给「去 AI 味… / Word」，选中某一版给「对比 / Word」。批注统一走阅读器顶栏的铅笔。
 * Word 按钮看当前这份的成品：没有是「转成 Word」，有了变成「预览 Word」（在阅读器里就地切换）+「重新转换」
 * （上一份由脚本改名保留，不覆盖）。落点由调用方按 docxTargetOf 算好后传进来。
 * orange 只给「被直接改过」：版本上是有人绕过批注改了这一版，原稿上是原稿在最新一版之后又改过；待处理批注是中性灰。
 * 有 `定稿.md` 时最末多一个「定稿」（选中值 `final`）：只给「预览 Word」（最近一次定稿那份）和对比，
 * 不给去 AI 味 / 转 Word —— 定稿是交出去的事实记录。没有 `final`（旧服务、未定稿）时与改动前一致。
 * 选中某一版或定稿时另给「复制路径」：复制这份 .md 在工作空间内的相对路径。
 * 版本标签和操作按钮同一行：标签多了在自己那块里横向滚动，按钮固定在右边；说明行在下面。
 * 这一行窄到按钮放不下（标签区不足 MIN_CHIPS_WIDTH）时，按钮整组收进「更多」菜单。
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
  // 标签横向滚动时，选中的那个（含从工作台跳进来选中的）自动滚进可见区
  const chipsRef = useRef<HTMLDivElement>(null);
  // 不显示滚动条（标签很小，滚动条比标签还显眼）；哪一侧还有藏着的标签，哪一侧边缘就淡出提示
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const measure = () => {
    const el = chipsRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setOverflow((o) => (o.left === left && o.right === right ? o : { left, right }));
  };
  useEffect(() => {
    // scroll-mx-6 让它停在淡出区里侧，不会半透明地贴着边
    chipsRef.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    measure();
  }, [selected, versions.length]);
  useEffect(() => {
    const el = chipsRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fade = '1.5rem';
  const chipsMask = overflow.left || overflow.right
    ? `linear-gradient(to right, ${overflow.left ? 'transparent' : '#000'}, #000 ${fade}, #000 calc(100% - ${fade}), ${overflow.right ? 'transparent' : '#000'})`
    : undefined;
  const chip = (key: string, label: string, v?: DeliveryVersion) => (
    <button
      key={key}
      type="button"
      aria-pressed={selected === key}
      onClick={() => onSelect(key)}
      className={cn(
        'flex shrink-0 scroll-mx-6 items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs transition-colors',
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
  const compareAction = (mode: CompareMode, label: string, disabled?: boolean, title?: string): BarAction => ({
    key: `compare-${mode}`,
    icon: GitCompare,
    label,
    disabled,
    title,
    pressed: compare === mode,
    onClick: () => onCompare(compare === mode ? null : mode),
  });
  const actions: BarAction[] = [];
  if (!wordOnly && copyPath) {
    actions.push({
      key: 'copy-path',
      icon: Copy,
      label: '复制路径',
      title: copyPath,
      onClick: () => {
        void writeClipboard(copyPath).then((ok) => {
          if (ok) toast.success('已复制路径');
          else toast.error('复制失败：浏览器没给剪贴板权限');
        });
      },
    });
  }
  if (wordOnly) {
    // 输入转换产物只有 Word 按钮
  } else if (onFinal) {
    actions.push(compareAction('final', versions.length ? '与最新一版对比' : '与原稿对比'));
  } else if (current) {
    actions.push(
      compareAction('source', '与原稿对比'),
      compareAction(
        'prev',
        '与上一版对比',
        current.basedOn === 'source' || !current.basedOn,
        current.basedOn === 'source' ? '这是去味首版，上一版就是原稿' : undefined,
      ),
    );
  } else {
    actions.push({ key: 'deai', icon: Copy, label: '去 AI 味…', title: '复制去 AI 味的提示词', onClick: onDeai });
  }
  if (docx) {
    actions.push({
      key: 'docx-preview',
      icon: FileText,
      label: '预览 Word',
      title: docxPreview ? '回到正文' : docx.path,
      pressed: docxPreview,
      onClick: () => onDocxPreview(!docxPreview),
    });
    if (!onFinal) {
      actions.push({
        key: 'reconvert',
        icon: FileOutput,
        label: '重新转换',
        disabled: !docx.generated,
        title: docx.generated
          ? '按当前正文重新转换；上一份改名为「基名-上次转换时间.docx」保留，不覆盖'
          : '同名的 Word 不是本工具生成的，为避免覆盖人工修改，请先改名或移走',
        onClick: onConvert,
      });
    }
  } else if (!onFinal) {
    actions.push({ key: 'convert', icon: FileOutput, label: '转成 Word', onClick: onConvert });
  }

  // 按钮放不放得下：量一份不可见的「最宽一组」按钮的实际宽度，和这一行的宽度比
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const row = rowRef.current;
    const ghost = measureRef.current;
    if (!row || !ghost) return;
    const check = () => setCollapsed(ghost.offsetWidth + MIN_CHIPS_WIDTH + 8 > row.clientWidth);
    const ro = new ResizeObserver(check);
    ro.observe(row);
    ro.observe(ghost);
    return () => ro.disconnect();
  }, []);

  const inlineActions = () =>
    actions.map((a) => (
      <Button
        key={a.key}
        variant={a.pressed ? 'secondary' : 'ghost'}
        size="sm"
        className={actionClass}
        aria-pressed={a.pressed}
        disabled={a.disabled}
        title={a.title}
        onClick={a.onClick}
      >
        <a.icon className="size-3.5" />
        {a.label}
      </Button>
    ));
  const anyPressed = actions.some((a) => a.pressed);
  const actionGroup = collapsed ? (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant={anyPressed ? 'secondary' : 'ghost'}
            size="sm"
            className={cn(actionClass, 'ml-auto shrink-0')}
            aria-label="更多操作"
            title="更多操作"
          />
        }
      >
        <Menu className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((a) => (
          <DropdownMenuItem key={a.key} disabled={a.disabled} title={a.title} onClick={a.onClick}>
            <a.icon />
            {a.label}
            {a.pressed ? <Check className="ml-auto" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : (
    <span className="ml-auto flex shrink-0 gap-1">{inlineActions()}</span>
  );
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-3 py-2 sm:px-4">
      {/* 不换行：按钮整组固定在右边，标签区只拿剩下的宽度，放不下就滚动 */}
      <div ref={rowRef} className="relative flex items-center gap-2">
        {/* 量宽用的按钮组：不可见、不占位、点不到 */}
        <span ref={measureRef} aria-hidden className="pointer-events-none invisible absolute right-0 top-0 flex gap-1">
          {(wordOnly ? WIDEST_WORD_ONLY : WIDEST_ACTIONS).map((a) => (
            <Button key={a.label} variant="ghost" size="sm" className={actionClass} tabIndex={-1}>
              <a.icon className="size-3.5" />
              {a.label}
            </Button>
          ))}
        </span>
        {wordOnly ? (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={docxDir}>成品放在 {docxDir}</span>
        ) : (
          <div
            ref={chipsRef}
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            style={chipsMask ? { maskImage: chipsMask, WebkitMaskImage: chipsMask } : undefined}
            onScroll={measure}
            // 没有滚动条，普通鼠标滚轮也得能左右翻：竖向滚动量转成横向
            onWheel={(e) => {
              if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
            }}
          >
            {chip('source', '原稿')}
            {versions.map((v) => chip(v.version, v.version, v))}
            {final ? chip('final', '定稿') : null}
          </div>
        )}
        {actionGroup}
      </div>
      {wordOnly ? null : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {onFinal && final ? (
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
            <span>若要作为交付稿，可以点右上「去 AI 味…」复制提示词，发给 AI 执行，以融入个人的写作风格。</span>
          )}
        </div>
      )}
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
