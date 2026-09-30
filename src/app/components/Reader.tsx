import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import Papa from 'papaparse';
import {
  ArrowLeft,
  ArrowLeftToLine,
  ArrowRightFromLine,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Expand,
  FolderOpen,
  Loader2,
  Pencil,
  RefreshCw,
  SquareArrowOutUpRight,
  Star,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { HeaderIconButton } from '@/components/Primitives';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AnnotationLayer } from '@/components/AnnotationLayer';
import { AnnotationToolbar } from '@/components/AnnotationToolbar';
import { AssetGalleryReader } from '@/components/AssetGalleryReader';
import { CodeFileView, codePreviewLabel, codePreviewLanguage } from '@/components/CodeFileView';
import { DeliveryBar, DeliveryDiff, useDeliveryVersions, type CompareMode } from '@/components/DeliveryBar';
import { DocxExportDialog } from '@/components/DocxExportDialog';
import { DocxView } from '@/components/DocxView';
import {
  DocumentToc,
  Markdown,
  scrollToAnchor,
  type OnInternalLink,
  type ResolveLink,
  type TocItem,
} from '@/components/Markdown';
import {
  PreviewSearch,
  PreviewToolbar,
  PreviewToolButton,
  type PreviewSearchOutcome,
  type PreviewSearchSource,
} from '@/components/PreviewSearch';
import { useAnnotationSession } from '@/hooks/useAnnotationSession';
import { isDocumentChanged, useAnnotations } from '@/hooks/useAnnotations';
import { useFileManagerName } from '@/hooks/useFileManager';
import { type IngestControl } from '@/hooks/useIngestJob';
import { usePins } from '@/hooks/usePins';
import { collectBlocks, createSearchJumper, type SearchJumper } from '@/lib/blockIndex';
import { queryTokens, searchBlocks, toSnippetParts } from '@/lib/fuzzySearch';
import { shouldPassthroughUrl } from '@/lib/markdownUrls';
import { utf8Len } from '@/lib/sourceAnchor';
import { deliveryDirOf, nextVersion } from '@/lib/deaiPrompt';
import {
  api,
  ApiError,
  type AssetGroup,
  type ConvertedItem,
  type FileItem,
  type SourceVerification,
} from '@/lib/api';
import { formatBytes, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

/** 表格预览每页行数（不含表头）；大点表只拉一页，避免整文件进内存 */
const TABLE_PAGE_SIZE = 50;

/**
 * 整表检索命中行的**展示文本**：服务端给回的是原始 CSV 行（判定也在原始行上做），
 * 这里解析成单元格再用空格拼 —— 与 blockIndex 里表格按行分块的拼法一致，
 * 于是同一行在「本地搜当前页」和「整表搜」两条路径下看起来是同一段文字。
 */
function csvRowText(line: string): string {
  const cells = Papa.parse<string[]>(line, { skipEmptyLines: true }).data[0];
  if (!cells?.length) return line;
  return cells
    .map((cell) => (cell || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
}

/** 只做展示用的 frontmatter 拆分，和服务端那份保持一致的宽松规则。 */
function splitFrontmatter(text: string): { meta: [string, string][]; body: string; bodyCharOffset: number } {
  if (!text.startsWith('---')) return { meta: [], body: text, bodyCharOffset: 0 };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { meta: [], body: text, bodyCharOffset: 0 };
  const raw = text.slice(text.indexOf('\n') + 1, end);
  const meta: [string, string][] = [];
  for (const line of raw.split(/\r?\n/)) {
    const kv = /^([\w.-]+):\s*(.*)$/.exec(line);
    if (kv && kv[2]) meta.push([kv[1], kv[2]]);
  }
  const fenceEnd = end + 4;
  const rest = text.slice(fenceEnd);
  const nl = rest.match(/^\r?\n/);
  const extra = nl ? nl[0].length : 0;
  const bodyCharOffset = fenceEnd + extra;
  return { meta, body: text.slice(bodyCharOffset), bodyCharOffset };
}

function dirOf(path: string) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** 把 markdown 里的相对图片路径解析成后端的文件接口地址。 */
function resolveRelative(base: string, url: string) {
  if (shouldPassthroughUrl(url)) return url;
  // micromark 会把目标里的非 ASCII 编成 %E6…；这里先解开，再交给
  // encodeURIComponent 做查询参数。不解的话中文文件名会编两次，图 404。
  let decoded = url;
  try {
    decoded = decodeURI(url);
  } catch {
    decoded = url;
  }
  const segments = `${base}/${decoded}`.split('/');
  const stack: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return stack.join('/');
}

/** 带协议的（http:、mailto:、javascript:、Windows 盘符……）都不是工作空间路径 */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * 按 `base` 解析成工作空间内路径；越出根（`..` 退过头）或解析成空返回 null。
 * 与 `resolveRelative` 的区别：那边只管拼地址，越界由服务端的 resolveInside 挡；
 * 这里要判「是不是站内」，所以越界得自己认出来。`#…` / `?…` 不算路径的一部分。
 */
function resolveWorkspacePath(base: string, url: string, { stripFragment }: { stripFragment: boolean }) {
  const raw = stripFragment ? url.replace(/[?#].*$/, '') : url;
  if (!raw) return null;
  let decoded = raw;
  try {
    decoded = decodeURI(raw);
  } catch {
    decoded = raw;
  }
  const stack: string[] = [];
  for (const seg of `${base}/${decoded}`.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!stack.length) return null;
      stack.pop();
    } else stack.push(seg);
  }
  return stack.length ? stack.join('/') : null;
}

/**
 * 预览区 markdown 的站内链接判定。
 * - 链接：按当前文档目录解析，落在工作空间内就算站内（存不存在由打开时决定）。
 * - 行内代码：先按工作空间根、再按当前文档目录，只认扫描结果里的精确命中 ——
 *   误成链比漏成链更伤，所以不猜文件名、不为此请求服务端。
 */
function makeResolveLink(projectId: string, base: string, pathSet: Set<string>): ResolveLink {
  return (url, kind) => {
    if (SCHEME_RE.test(url) || url.startsWith('#') || url.startsWith('//')) return null;
    if (kind === 'link') {
      const path = resolveWorkspacePath(base, url, { stripFragment: true });
      return path ? { path, href: api.fileUrl(projectId, path) } : null;
    }
    for (const from of ['', base]) {
      const path = resolveWorkspacePath(from, url, { stripFragment: false });
      if (path && pathSet.has(path)) return { path, href: api.fileUrl(projectId, path) };
    }
    return null;
  };
}

const EMPTY_PATHS = new Set<string>();

function sheetLabel(name: string) {
  return name.replace(/\.(csv|tsv)$/i, '') || name;
}

function isSpreadsheetPath(p: string): boolean {
  const lower = p.toLowerCase();
  return lower.endsWith('.xlsx') || lower.endsWith('.xlsm');
}

function isSpreadsheetItem(item: FileItem): boolean {
  const ext = (item.ext || '').toLowerCase();
  if (ext === '.xlsx' || ext === '.xlsm') return true;
  return isSpreadsheetPath(item.path);
}

/** 校验结果的说法：ok/stale 是坐实过的结论，unknown 只说为什么比不了。 */
const VERIFY_TEXT: Record<SourceVerification['state'], string> = {
  ok: '已校验：原件和转换时一模一样',
  stale: '已校验：原件内容确实变了，建议重新转换一次',
  missing: '原件已经不在这个路径上了',
  unknown: '比不了',
};

function SourceBar({
  meta,
  sourceState,
  projectId,
  path,
  canIngest,
  ingest,
  onReconverted,
}: {
  meta: [string, string][];
  /** 缺省 = 服务端没给（旧进程）或产物没记 source：不显示任何溯源状态 */
  sourceState?: ConvertedItem['sourceState'];
  projectId: string;
  /**
   * 摘要文件路径（frontmatter 所在处）。新布局下不等于正文目录 item.path；
   * 缺省时退回 item.path，交给服务端按三种产物形态解析。
   */
  path: string;
  /** 工作空间没有 scripts/ingest.py 时不给「重新转换」，只留校验 */
  canIngest?: boolean;
  /** 缺省 = 上层没接转换能力：退回改动前的行为，只有「校验原件」 */
  ingest?: IngestControl;
  /** 重转完成后通知上层重读正文（产物已经被脚本改写了） */
  onReconverted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<SourceVerification | null>(null);
  const [verifyError, setVerifyError] = useState('');
  /**
   * 点「重新转换」那一刻的任务时间戳，null = 没在等。
   * 记时间戳而不是布尔量：上一轮任务可能已经是 done 停在那儿，
   * 只看 status 会把「点击前的旧结果」当成本轮跑完。
   */
  const [waitFrom, setWaitFrom] = useState<string | null>(null);

  const verify = useCallback(async () => {
    setChecking(true);
    setVerifyError('');
    try {
      setResult(await api.verifySource(projectId, path));
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : '校验失败');
    } finally {
      setChecking(false);
    }
  }, [projectId, path]);

  // 重转跑完了就自己校验一次：产物刚被脚本改写，扫描给的 stale 已经过期，
  // 这时候的哈希结论才是这份产物现在的真实状态（省得人再点一次「校验原件」）。
  const jobStatus = ingest?.job?.status;
  const jobStartedAt = ingest?.job?.startedAt || '';
  useEffect(() => {
    if (waitFrom === null) return;
    // 任务还没换一轮（起任务被 409 挡下等），或者新任务还在跑：继续等
    if (!jobStatus || jobStatus === 'running' || jobStartedAt === waitFrom) return;
    setWaitFrom(null);
    if (jobStatus === 'done') {
      onReconverted?.();
      void verify();
    }
  }, [waitFrom, jobStatus, jobStartedAt, verify, onReconverted]);

  if (!meta.length) return null;
  const warning = meta.find(([k]) => k === 'warning');
  const source = meta.find(([k]) => k === 'source');
  const sourceRel = (source?.[1] || '').trim();
  // 扫描给的 stale 是 mtime 推的、会误报，哈希算过就以哈希为准；
  // unknown 说明压根比不了，那就别拿它盖掉扫描的结论
  const state = result && result.state !== 'unknown' ? result.state : sourceState;
  // 原件动过才给重转：原件已不在（missing）重转不了，没动过重跑一遍也是白跑
  const canReconvert = Boolean(canIngest && ingest && sourceRel) && state === 'stale';
  const reconverting = waitFrom !== null && ingest?.running === true;

  const reconvert = () => {
    if (!ingest || !sourceRel) return;
    setWaitFrom(jobStartedAt);
    void ingest.start(sourceRel);
  };

  return (
    <div className="mb-6 rounded-lg border border-border bg-muted/40 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <span className="text-muted-foreground">溯源</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{source?.[1] || '—'}</span>
        {/* 想回查原文时最该知道这件事；但删原件是正当用法，所以走灰字不走 destructive */}
        {state === 'missing' ? (
          <span className="shrink-0 text-muted-foreground">原件已不在</span>
        ) : null}
        {state === 'stale' ? (
          <Badge variant="outline" className="border-destructive text-destructive">
            原件转换后动过
          </Badge>
        ) : null}
        {warning ? (
          <Badge variant="outline" className="border-destructive text-destructive">
            内容存疑
          </Badge>
        ) : null}
      </button>
      {open ? (
        <div className="border-t border-border px-3 py-2.5">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            {meta.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">{key}</dt>
                <dd className={key === 'warning' ? 'text-destructive' : 'font-mono text-[11px] break-all'}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          {source ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
              <Button type="button" variant="outline" size="sm" onClick={verify} disabled={checking}>
                {checking ? '校验中…' : '校验原件'}
              </Button>
              {/* 闭环的那一步：确认原件动过之后，就地重跑一次转换，不用回列表找这份资料。
                  ingest.py 按 sha256 幂等，对着原件再跑一次就会重出这份产物 */}
              {canReconvert ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={reconvert}
                  disabled={ingest?.running || checking}
                >
                  {reconverting ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" />
                      重新转换中…
                    </>
                  ) : (
                    <>
                      <RefreshCw className="size-3.5" />
                      重新转换
                    </>
                  )}
                </Button>
              ) : null}
              {/* 列表上的「动过」只是 mtime 说的话（网盘同步、git checkout 都会动它），
                  所以那句措辞不敢说内容变了；这个按钮重算 sha256，才敢下「内容确实变了」的结论 */}
              <span
                className={cn(
                  'min-w-0 flex-1 text-[11px]',
                  (result?.state === 'stale' && !reconverting) || ingest?.error
                    ? 'text-destructive'
                    : 'text-muted-foreground',
                )}
              >
                {verifyError ||
                  (reconverting
                    ? ingest?.job?.message || '正在重新转换…'
                    : ingest?.error) ||
                  (result
                    ? result.state === 'unknown'
                      ? `${VERIFY_TEXT.unknown}：${result.reason || '缺少可比对的信息'}`
                      : VERIFY_TEXT[result.state]
                    : '重算原件的 sha256 跟这份产物记的比一比；大文件要等几秒。')}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CsvGrid({
  head,
  body,
  totalRows,
  page,
  pageSize,
  size,
  onPageChange,
}: {
  head: string[];
  body: string[][];
  totalRows: number;
  page: number;
  pageSize: number;
  size?: number;
  onPageChange: (page: number) => void;
}) {
  if (!head.length) return <p className="text-sm text-muted-foreground">这张表是空的。</p>;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const from = totalRows === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(totalRows, (page + 1) * pageSize);
  const showPager = totalRows > pageSize;

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-muted/60">
            <tr>
              {head.map((cell, i) => (
                <th
                  key={i}
                  className="border-b border-border px-3 py-2 text-left text-xs font-medium whitespace-nowrap"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.length ? (
              body.map((row, i) => (
                // data-row-index 是**绝对行号**（不含表头）：整表检索命中后靠它找到这一行
                <tr key={i} data-row-index={page * pageSize + i} className="hover:bg-accent/50">
                  {head.map((_, j) => (
                    <td key={j} className="border-b border-border px-3 py-2 align-top whitespace-pre-wrap">
                      {row[j] ?? ''}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={head.length} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  这一页没有数据。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/30 px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {totalRows === 0
            ? '0 行'
            : showPager
              ? `第 ${from}–${to} 行，共 ${totalRows.toLocaleString('zh-CN')} 行 × ${head.length} 列`
              : `${totalRows.toLocaleString('zh-CN')} 行 × ${head.length} 列`}
          {size ? ` · ${formatBytes(size)}` : ''}
        </span>
        {showPager ? (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={page <= 0}
              aria-label="上一页"
              onClick={() => onPageChange(Math.max(0, page - 1))}
            >
              <ChevronLeft className="size-3.5" />
              上一页
            </Button>
            <span className="min-w-[4.5rem] text-center text-xs text-muted-foreground">
              {page + 1} / {totalPages}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={page >= totalPages - 1}
              aria-label="下一页"
              onClick={() => onPageChange(Math.min(totalPages - 1, page + 1))}
            >
              下一页
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 表格的命令式句柄：整表检索命中一行后，由外部驱动「翻到那一页并定位到那一行」。
 * 只暴露这一件事 —— 分页仍是表格自己的状态，提到 Reader 会跟 sheet 切换、路径变化纠缠。
 */
export interface CsvTableHandle {
  /** expectMtime 是检索那一刻表格的 mtime；对不上说明表变了，不跳转、提示重搜 */
  jumpToRow: (row: number, expectMtime?: string) => void;
  /** 当前工作表名；csv 或缺字段时为 undefined */
  activeSheet: () => string | undefined;
}

/** 走 /table 分页接口；大点表也不会再撞「文件太大」。 */
function PaginatedCsvTable({
  projectId,
  path,
  jumper,
  onSheetChange,
  ref,
}: {
  projectId: string;
  path: string;
  /** 命中行的滚动与临时高亮控制器；不传就只翻页不高亮 */
  jumper?: SearchJumper;
  /** 工作簿当前 sheet 变了就说一声：上层据此重置检索条 */
  onSheetChange?: (sheet: string | undefined) => void;
  ref?: Ref<CsvTableHandle>;
}) {
  const fileManager = useFileManagerName();
  const [page, setPage] = useState(0);
  const [head, setHead] = useState<string[]>([]);
  const [body, setBody] = useState<string[][]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [size, setSize] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  // 命中行不在当前页时先记下来，等那一页的数据到位再定位
  const pendingRowRef = useRef<{ row: number; expectMtime?: string } | null>(null);
  // 最近一次成功拉到的这一页对应的文件 mtime，用来识破「检索之后表格被重转了」
  const mtimeRef = useRef('');
  const [stale, setStale] = useState(false);
  // 用户点选的 sheet；未点选时不带 sheet 参数，服务端给第一张
  const [userSheet, setUserSheet] = useState<string | undefined>();
  const [workbookSheets, setWorkbookSheets] = useState<string[]>([]);
  const [activeSheetName, setActiveSheetName] = useState<string | undefined>();
  const onSheetChangeRef = useRef(onSheetChange);
  onSheetChangeRef.current = onSheetChange;

  useEffect(() => {
    setPage(0);
    pendingRowRef.current = null;
    setStale(false);
    setUserSheet(undefined);
    setWorkbookSheets([]);
    setActiveSheetName(undefined);
  }, [path]);

  const focusRow = useCallback(
    (row: number) => {
      const el = rootRef.current?.querySelector<HTMLElement>(`tr[data-row-index="${row}"]`);
      // 找不到就静默返回：不滚动、不高亮、不报错（与预览窗内检索的降级一致）
      if (el) jumper?.jump(el);
    },
    [jumper],
  );

  /** 目标页已经在手上了：先验表格有没有变，再决定是定位还是提示重搜 */
  const resolvePending = useCallback(() => {
    const pending = pendingRowRef.current;
    if (!pending) return;
    pendingRowRef.current = null;
    // 表格在检索之后被重新转换过：这个行号可能已经不指向那条记录，宁可让人重搜，
    // 也不要滚过去高亮一行**看着像但其实不是**的数据
    if (pending.expectMtime && mtimeRef.current && pending.expectMtime !== mtimeRef.current) {
      setStale(true);
      return;
    }
    focusRow(pending.row);
  }, [focusRow]);

  useImperativeHandle(
    ref,
    () => ({
      jumpToRow(row: number, expectMtime?: string) {
        const target = Math.floor(row / TABLE_PAGE_SIZE);
        pendingRowRef.current = { row, expectMtime };
        setStale(false);
        if (target === page && !loading) {
          resolvePending();
          return;
        }
        setPage(target);
      },
      activeSheet: () => userSheet || activeSheetName,
    }),
    [page, loading, resolvePending, userSheet, activeSheetName],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .table(projectId, path, {
        offset: page * TABLE_PAGE_SIZE,
        limit: TABLE_PAGE_SIZE,
        sheet: userSheet,
      })
      .then((res) => {
        if (cancelled) return;
        const chunk = [res.headerLine, ...res.lines].filter((l) => l != null && l !== '').join('\n');
        const parsed = Papa.parse<string[]>(chunk, { skipEmptyLines: true });
        const rows = parsed.data;
        const nextHead = rows[0] || [];
        const nextBody = rows.slice(1);
        setHead(nextHead);
        setBody(nextBody);
        setTotalRows(res.totalRows);
        setSize(res.size);
        mtimeRef.current = res.mtime;
        const names = res.sheets?.filter(Boolean) ?? [];
        setWorkbookSheets(names.length > 1 ? names : []);
        const current = res.sheet || names[0];
        setActiveSheetName(current);
        onSheetChangeRef.current?.(current);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setHead([]);
        setBody([]);
        setTotalRows(0);
        setWorkbookSheets([]);
        setActiveSheetName(undefined);
        onSheetChangeRef.current?.(undefined);
        setError(err.message);
        setLoading(false);
        // 这一页没读到，就别再等着跳了；错误已经显示在位
        pendingRowRef.current = null;
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, path, page, userSheet]);

  // 目标页渲染完成后再定位：翻页是异步的，jumpToRow 当时那一行还不在 DOM 里
  useEffect(() => {
    if (loading) return;
    resolvePending();
  }, [body, loading, resolvePending]);

  if (loading && !head.length && !error) {
    return <p className="text-sm text-muted-foreground">读取表格中…</p>;
  }
  if (error) {
    return (
      <div className="flex flex-col items-start gap-4">
        <p className="text-sm text-destructive">{error}</p>
        {isSpreadsheetPath(path) ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void api.reveal(projectId, path, 'open')}>
              <SquareArrowOutUpRight className="size-3.5" />
              用默认程序打开
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void api.reveal(projectId, path)}>
              <FolderOpen className="size-3.5" />
              在{fileManager}中显示
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  const showSheetSelect = workbookSheets.length > 1;
  const sheetValue = userSheet || activeSheetName || '';

  return (
    <div ref={rootRef} className="flex flex-col gap-3">
      {showSheetSelect ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="shrink-0 text-xs text-muted-foreground">数据表</span>
          <Select
            value={sheetValue}
            onValueChange={(value) => {
              if (typeof value === 'string' && value && value !== sheetValue) {
                setUserSheet(value);
                setPage(0);
              }
            }}
          >
            <SelectTrigger
              className="h-9 min-h-9 w-auto min-w-[12rem] max-w-md flex-1 py-0"
              aria-label="选择数据表"
            >
              <SelectValue>
                {(value: string | null) => (value ? sheetLabel(value) : null)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {workbookSheets.map((name) => (
                <SelectItem key={name} value={name}>
                  {sheetLabel(name)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {loading ? <p className="text-xs text-muted-foreground">翻页加载中…</p> : null}
      {stale ? (
        <p className="text-xs text-destructive">
          这张表在检索之后有改动，行号可能已经不指向那一行了 —— 请重新检索。
        </p>
      ) : null}
      <CsvGrid
        head={head}
        body={body}
        totalRows={totalRows}
        page={page}
        pageSize={TABLE_PAGE_SIZE}
        size={size}
        onPageChange={setPage}
      />
    </div>
  );
}

/** 进程内正文缓存：切换文档时先出缓存，避免「读取中」闪一下。 */
const fileContentCache = new Map<string, string>();

function cacheKey(projectId: string, path: string) {
  return `${projectId}\0${path}`;
}

/**
 * 读工作空间文本文件。
 * - 有缓存：立刻展示，后台静默刷新
 * - 无缓存：不立刻亮「读取中」；超过短延迟仍未返回才提示
 * - 切换 path 时保留上一份正文直到新正文到位（或延迟后仍无内容才显示读取中）
 */
function useFileContent(projectId: string, path: string | null, refreshKey: string | number = 0) {
  const [content, setContent] = useState('');
  /** 当前 content 对应的 path；与请求 path 一致才算已对齐 */
  const [resolvedPath, setResolvedPath] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [showSpinner, setShowSpinner] = useState(false);

  useEffect(() => {
    if (!path) {
      setContent('');
      setResolvedPath(null);
      setError('');
      setShowSpinner(false);
      return;
    }

    let cancelled = false;
    const key = cacheKey(projectId, path);
    const cached = fileContentCache.get(key);

    setError('');
    setShowSpinner(false);

    if (cached !== undefined) {
      // 命中缓存：马上对齐，不出现 loading；后台仍拉一次保持新鲜
      setContent(cached);
      setResolvedPath(path);
    }

    // 无缓存时才考虑「读取中」：本地接口通常 <200ms，延迟后再显示可避免闪一下
    const timer =
      cached === undefined
        ? window.setTimeout(() => {
            if (!cancelled) setShowSpinner(true);
          }, 200)
        : 0;

    api
      .file(projectId, path)
      .then((data) => {
        if (cancelled) return;
        // 老进程曾把 .json 按 MIME 裸直出，响应是文件自己而不是 { content }。
        // 当 undefined 会让预览什么都不画，连错误提示都没有。
        if (typeof data.content !== 'string') {
          setContent('');
          setResolvedPath(path);
          setError('读不到文件正文。如果刚改过接口，重启看板服务再试。');
          setShowSpinner(false);
          return;
        }
        fileContentCache.set(key, data.content);
        setContent(data.content);
        setResolvedPath(path);
        setError('');
        setShowSpinner(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        // 失败时不要继续展示别的文件的旧正文
        setContent('');
        setResolvedPath(path);
        setError(err.message);
        setShowSpinner(false);
      })
      .finally(() => {
        if (timer) window.clearTimeout(timer);
      });

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // refreshKey 变化 = 这份文件刚被工作空间脚本改写过，缓存里的正文已经不作数
  }, [projectId, path, refreshKey]);

  const aligned = path !== null && resolvedPath === path;
  // 有对齐正文时绝不因后台刷新闪 loading；仅无正文且已过延迟才提示
  const loading = Boolean(path) && showSpinner && !aligned;
  const displayContent = aligned ? content : '';

  return { content: displayContent, loading, error: aligned ? error : '' };
}

/**
 * 表格区给外部的句柄：整表检索要知道「现在看的是哪张表」，命中后要能「跳到第几行」。
 * 多表包里 active 是 TableReader 自己的状态，检索条在 Reader 里，靠这个句柄问它。
 */
export interface TableReaderHandle {
  activePath: () => string;
  /** 工作簿当前 sheet；csv 或缺字段时为 undefined */
  activeSheet: () => string | undefined;
  jumpToRow: (row: number, expectMtime?: string) => void;
}

/** 多 sheet（xlsx 拆目录 / 点表分册）或单 csv/tsv；一律走分页接口。 */
function TableReader({
  projectId,
  item,
  sheets,
  jumper,
  onActivePathChange,
  onActiveSheetChange,
  ref,
}: {
  projectId: string;
  item: FileItem;
  sheets: { path: string; name: string; size?: number }[];
  /** 命中行的滚动与临时高亮控制器 */
  jumper?: SearchJumper;
  /** 当前选中的表变了就说一声：上层据此重置检索条（换表 = 换了内容对象） */
  onActivePathChange?: (path: string) => void;
  /** 工作簿切 sheet 也是换了内容对象 */
  onActiveSheetChange?: (sheet: string | undefined) => void;
  ref?: Ref<TableReaderHandle>;
}) {
  const multi = sheets.length > 1;
  const firstPath = sheets[0]?.path || item.path;
  const [active, setActive] = useState(firstPath);
  const [workbookSheet, setWorkbookSheet] = useState<string | undefined>();
  const tableRef = useRef<CsvTableHandle>(null);

  useEffect(() => {
    setActive(firstPath);
    setWorkbookSheet(undefined);
  }, [item.path, firstPath]);

  const currentPath = multi ? active : firstPath;
  useEffect(() => {
    onActivePathChange?.(currentPath);
  }, [currentPath, onActivePathChange]);

  useEffect(() => {
    onActiveSheetChange?.(multi ? undefined : workbookSheet);
  }, [multi, workbookSheet, onActiveSheetChange]);

  // 必须在 early return 之前：单 sheet / 多 sheet 切换时 TableReader 会复用同一实例
  const byPath = useMemo(() => new Map(sheets.map((s) => [s.path, s])), [sheets]);

  // 同上，必须在 early return 之前
  useImperativeHandle(
    ref,
    () => ({
      activePath: () => currentPath,
      activeSheet: () => (multi ? undefined : tableRef.current?.activeSheet() ?? workbookSheet),
      jumpToRow: (row, expectMtime) => tableRef.current?.jumpToRow(row, expectMtime),
    }),
    [currentPath, multi, workbookSheet],
  );

  if (!multi) {
    return (
      <PaginatedCsvTable
        ref={tableRef}
        projectId={projectId}
        path={firstPath}
        jumper={jumper}
        onSheetChange={setWorkbookSheet}
      />
    );
  }

  const activeSheet = byPath.get(active);

  return (
    <div className="flex flex-col gap-3">
      {/*
        单行 Select + label 横排：是业务侧布局组合，不是 Select 组件变体。
        真源默认已是单行（不传 description）；水平「标签+控件」用 flex 即可，不必上行加 variant。
      */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="shrink-0 text-xs text-muted-foreground">数据表</span>
        <Select
          value={active}
          onValueChange={(value) => {
            if (typeof value === 'string' && value) setActive(value);
          }}
        >
          <SelectTrigger
            className="h-9 min-h-9 w-auto min-w-[12rem] max-w-md flex-1 py-0"
            aria-label="选择数据表"
          >
            <SelectValue>
              {(value: string | null) => {
                const sheet = value ? byPath.get(value) : undefined;
                if (!sheet) return null;
                return sheetLabel(sheet.name);
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {sheets.map((sheet) => (
              <SelectItem key={sheet.path} value={sheet.path}>
                {sheetLabel(sheet.name)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {activeSheet && typeof activeSheet.size === 'number' && activeSheet.size > 4 * 1024 * 1024 ? (
        <p className="text-xs text-muted-foreground">
          此表较大（{formatBytes(activeSheet.size)}），下方仅分页预览；完整检索请用摘要里的 SQL 示例。
        </p>
      ) : null}
      <PaginatedCsvTable
        key={active}
        ref={tableRef}
        projectId={projectId}
        path={active}
        jumper={jumper}
      />
    </div>
  );
}

function isConverted(item: FileItem): item is ConvertedItem {
  return 'isDir' in item || 'sheets' in item;
}

/** 图库不是文件而是一摞图，images 就是判据（同 isConverted 的写法）。 */
function isGallery(item: FileItem): item is AssetGroup {
  return 'images' in item;
}

interface ReaderProps {
  projectId: string;
  item: FileItem;
  onClose: () => void;
  /** 扫描到的全部路径：行内代码自动成链只认它 */
  pathSet?: Set<string>;
  /**
   * 站内链接被点中。返回 `external` 表示看板接不住（扫描外的二进制等），交给浏览器新开。
   * 不传就不启用站内链接，正文链接照旧新开窗口。
   */
  onOpenPath?: (path: string) => 'opened' | 'external';
  /** 后退链非空时才给；不给就不显示「后退」 */
  onBack?: () => void;
  /** 宽屏下预览是否已向左展开至主区全宽 */
  expanded?: boolean;
  /** 宽屏提供；窄屏预览本就是全屏，不传则不显示展开按钮 */
  onToggleExpand?: () => void;
  /** 工作空间有 scripts/ingest.py 时才给「重新转换」 */
  canIngest?: boolean;
  /** 与待转换列表共用的转换任务；不传则溯源栏只有「校验原件」 */
  ingest?: IngestControl;
}

interface ReaderBodyExtras {
  /** 顶栏下面的一条（交付稿版本条）。不给就没有 */
  topBar?: ReactNode;
  /** 给了就替换掉正文区（交付稿对比视图） */
  replaceBody?: ReactNode;
  /** 每变一次就打开批注模式（版本条上的「批注」） */
  annotateSignal?: number;
  /** 正在看某一版交付稿：批注提示词换成「改出下一版 + 同步沉淀」 */
  delivery?: { version: string; nextPath: string; rulesVersion?: number };
  /** 批注回执里的沉淀标签被点中：跳到工作台里这条规则 */
  onOpenDeaiRule?: (rule: string) => void;
}

function ReaderBody({
  projectId,
  item,
  onClose,
  expanded = false,
  onToggleExpand,
  canIngest,
  ingest,
  pathSet = EMPTY_PATHS,
  onOpenPath,
  onBack,
  topBar,
  replaceBody,
  annotateSignal = 0,
  delivery,
  onOpenDeaiRule,
}: ReaderProps & ReaderBodyExtras) {
  const fileManager = useFileManagerName();
  // 清单和预览共用一份收藏状态：点这里立刻反映到对应列表的置顶
  const { pins, togglePin } = usePins(projectId);
  const pinned = pins.has(item.path);
  const sheets = useMemo(() => {
    if (isConverted(item) && item.sheets?.length) {
      return item.sheets.map((s) => ({ path: s.path, name: s.name, size: s.size }));
    }
    return [] as { path: string; name: string; size?: number }[];
  }, [item]);

  // 目录型转换产物：csv → 表格；html 原型 → iframe；否则读 _manifest.md
  const multiSheet = sheets.length > 0;
  const isDir = isConverted(item) && item.isDir;
  // 摘要位置由服务端给：新布局里摘要在镜像目录、正文在 SplittingObject/ 下，两者不同级，
  // 拼不出来。旧服务进程不给这个字段，退回旧布局的「产物目录里就有 _manifest.md」。
  const manifestPath = isConverted(item)
    ? item.manifestPath || (isDir ? `${item.path.replace(/\/$/, '')}/_manifest.md` : '')
    : '';
  // 校验读 frontmatter：新布局下它在镜像目录的 _manifest_<名>.md，不在正文目录里。
  // 旧服务进程不给 manifestPath，退回 item.path（服务端会按三种形态解析）。
  const verifyPath = isConverted(item) ? item.manifestPath || item.path : item.path;
  const htmlPath =
    isConverted(item) && item.reader === 'html'
      ? item.htmlPath || (item.ext === '.html' || item.ext === '.htm' ? item.path : '')
      : item.reader === 'html'
        ? item.path
        : '';
  const sqlitePath = isConverted(item) ? item.sqlitePath : undefined;
  const sourceState = isConverted(item) ? item.sourceState : undefined;

  // 目录里有 csv 就按表格包处理（含点表）；item.reader 也可能已是 table
  const mode: 'markdown' | 'table' | 'text' | 'image' | 'html' | 'external' | 'gallery' = multiSheet
    ? 'table'
    : item.reader;

  // PDF 仍是 external（不改扫描契约），但交给浏览器自带的 PDF 查看器内嵌预览：
  // 扫描件和文字件一样能看，不引依赖。目录型产物不走这条。
  const isPdf = mode === 'external' && !isDir && /\.pdf$/i.test(item.path);
  // .docx 同理：扫描仍标 external，这里按扩展名交给 DocxView 在隔离 iframe 里渲染分页版式
  const isDocx = mode === 'external' && !isDir && /\.docx$/i.test(item.path);

  const contentPath =
    mode === 'markdown' && isDir
      ? manifestPath
      : mode === 'markdown' || mode === 'text'
        ? item.path
        : null;

  // 重转会就地改写这份产物，正文和 frontmatter 都得重读一次
  const [reconvertedAt, setReconvertedAt] = useState(0);
  const onReconverted = useCallback(() => setReconvertedAt(Date.now()), []);
  useEffect(() => {
    setReconvertedAt(0);
  }, [item.path]);

  // 表格内容由 TableReader 自行拉取；此处只负责 md / 纯文本
  const { content, loading, error } = useFileContent(
    projectId,
    contentPath,
    `${reconvertedAt}:${item.mtime}`,
  );

  // 目录型表格包 / html 原型：manifest 做摘要、SQL 指南、校验说明
  const { content: manifestContent, loading: manifestLoading, error: manifestError } = useFileContent(
    projectId,
    (multiSheet || mode === 'html') && isDir ? manifestPath : null,
    reconvertedAt,
  );

  const { meta, body, bodyCharOffset } = useMemo(() => {
    if (mode === 'markdown') return splitFrontmatter(content);
    if ((multiSheet || mode === 'html') && manifestContent) return splitFrontmatter(manifestContent);
    return { meta: [] as [string, string][], body: content, bodyCharOffset: 0 };
  }, [content, mode, multiSheet, manifestContent]);
  const sourceByteOffset = mode === 'markdown' ? utf8Len(content.slice(0, bodyCharOffset)) : 0;
  const annotateFile = mode === 'markdown' ? contentPath || item.path : '';
  const annotations = useAnnotations(projectId, annotateFile);
  const canAnnotate = mode === 'markdown';
  const notesDirty = isDocumentChanged(annotations.seenMtime, item.mtime, annotations.notes.length);
  // 批注是一种模式：点了这个按钮、胶囊出现之后，正文才开始接「选取元素 / 选中文字」。
  // 没激活时划选就只是划选，不再自己冒出「批注」按钮。
  const annotate = useAnnotationSession(item.path);
  const setAnnotating = annotate.setActive;
  useEffect(() => {
    // 只跟 path：用户手动收起后，不要因为 notesDirty 还是 true 又被拉开
    setAnnotating(isDocumentChanged(annotations.seenMtime, item.mtime, annotations.notes.length));
  }, [item.path]);
  useEffect(() => {
    if (annotateSignal) setAnnotating(true);
  }, [annotateSignal, setAnnotating]);
  const annotateLabel = annotate.active
    ? '收起批注'
    : annotations.notes.length
      ? `批注（${annotations.notes.length}）`
      : '批注';

  const base = dirOf(mode === 'markdown' && isDir ? manifestPath : item.path);
  // 表格包与 html 原型的摘要：相对路径以摘要文件自己的目录为准（新布局下它与正文分居两地）
  const manifestBase = dirOf(manifestPath || item.path);

  // 批注模式下点链接不跳：交给批注层自己拦（它会 preventDefault，选文字模式还会提示）
  const annotatingRef = useRef(annotate.active);
  annotatingRef.current = annotate.active;
  const onOpenPathRef = useRef(onOpenPath);
  onOpenPathRef.current = onOpenPath;
  const linksEnabled = Boolean(onOpenPath);
  const onInternalLink = useCallback<OnInternalLink>(
    (target, event) => {
      if (annotatingRef.current) return;
      event.preventDefault();
      if (target.startsWith('#')) {
        scrollToAnchor(event.currentTarget, target);
        return;
      }
      const result = onOpenPathRef.current?.(target) ?? 'external';
      if (result === 'external') window.open(api.fileUrl(projectId, target), '_blank', 'noreferrer');
    },
    [projectId],
  );
  const resolveBodyLink = useMemo(
    () => (linksEnabled ? makeResolveLink(projectId, base, pathSet) : undefined),
    [linksEnabled, projectId, base, pathSet],
  );
  const resolveManifestLink = useMemo(
    () => (linksEnabled ? makeResolveLink(projectId, manifestBase, pathSet) : undefined),
    [linksEnabled, projectId, manifestBase, pathSet],
  );
  const manifestUrlTransform = useCallback(
    (url: string) =>
      shouldPassthroughUrl(url) ? url : api.fileUrl(projectId, resolveRelative(manifestBase, url)),
    [projectId, manifestBase],
  );
  // 单文件 HTML（output/docs 下的汇报材料）没有 _manifest.md，校验说明这一栏不该出现
  const hasManifest = (multiSheet || mode === 'html') && isDir;
  const [htmlTab, setHtmlTab] = useState<'preview' | 'manifest'>('preview');
  // 汇报时把预览区撑满整屏：iframe 自己进全屏，不牵动看板其余布局
  const htmlFrameRef = useRef<HTMLIFrameElement>(null);
  // 点表等大包默认先看摘要（规模分布 / SQL），再按需翻数据
  const [tableTab, setTableTab] = useState<'summary' | 'data'>('summary');

  useEffect(() => {
    setTableTab('summary');
    setHtmlTab('preview');
  }, [item.path]);

  // 预览窗内检索：开合与关键词归 PreviewSearch 自己;高亮控制器活得比检索条久,
  // 选中结果后条子就关了,两秒的闪烁还得有人管到头。内容一变用 key 把条子卸掉,
  // 上一份文档的结果不能留在屏幕上。
  const jumperRef = useRef<SearchJumper | null>(null);
  const jumper = jumperRef.current ?? (jumperRef.current = createSearchJumper());
  // 表格区的句柄：整表检索要问它"现在看的是哪张表"，命中后让它翻页并定位到那一行
  const tableHandleRef = useRef<TableReaderHandle | null>(null);
  // 多表包里切换数据表也是"换了内容对象"：进 searchResetKey，把检索条连同结果一起重置
  const [activeTablePath, setActiveTablePath] = useState('');
  const [activeTableSheet, setActiveTableSheet] = useState('');
  // 纯文本的 <pre>、共享滚动区、表格包「数据」页：搜索索引用它们定位正文根
  const textPreRef = useRef<HTMLPreElement>(null);
  const plainScrollRef = useRef<HTMLDivElement>(null);
  const tableSearchRef = useRef<HTMLDivElement>(null);
  const searchResetKey = `${item.path}:${item.mtime}:${tableTab}:${htmlTab}:${reconvertedAt}:${activeTablePath}:${activeTableSheet}`;

  // 换文件、表格包/HTML 原型切 tab、重转后正文重读（mtime 变）：清掉可能还在走的高亮
  useEffect(() => {
    jumper.clear();
  }, [item.path, item.mtime, tableTab, htmlTab, reconvertedAt, jumper]);

  // 预览窗卸载时收掉可能还在走的高亮定时器与 class
  useEffect(() => () => jumper.clear(), [jumper]);

  // markdown / 表格摘要目录：放在滚动区外；条目来自渲染后 DOM，与锚点严格一致
  const mdScrollRef = useRef<HTMLDivElement>(null);
  const [tocState, setTocState] = useState<{ path: string; items: TocItem[] }>({
    path: item.path,
    items: [],
  });
  // 路径变化时同步清空（render 期更新，避免 effect 清掉 layout 刚写入的目录）
  if (tocState.path !== item.path) {
    setTocState({ path: item.path, items: [] });
  }
  // 点表等目录型表格的「摘要」也是长 markdown，同样挂目录
  const showDocToc =
    mode === 'markdown' || (mode === 'table' && isDir && multiSheet && tableTab === 'summary');
  const tocItems = showDocToc && tocState.path === item.path ? tocState.items : [];
  const tablePackage = mode === 'table' && isDir && multiSheet;

  // 搜索按钮只在"此刻有文字可搜"时出现。表格「数据」页和单份 csv/tsv 搜的是**整张表**
  // (服务端流式扫描,浏览器里仍然只有当前这一页);HTML 预览页在隔离 iframe
  // 里读不到、图片/图库/原始格式/读取中失败一律不给假入口。
  const codeLang = mode === 'text' ? codePreviewLanguage(item.ext || item.path) : undefined;
  const codeLabel = codeLang ? codePreviewLabel(item.ext || item.path) || codeLang : '';

  const searchingTable =
    mode === 'table' && (!tablePackage || tableTab === 'data');
  const canSearch =
    (mode === 'markdown' && !loading && !error && Boolean(body)) ||
    (tablePackage && tableTab === 'summary' && !manifestLoading && !manifestError && Boolean(body)) ||
    searchingTable ||
    (mode === 'html' && isDir && hasManifest && htmlTab === 'manifest' && !manifestLoading && !manifestError && Boolean(body)) ||
    (mode === 'text' && !loading && !error && Boolean(content));

  // 正文根：markdown / 表格摘要取 .markdown-body，纯文本取 <pre>，
  // 表格数据页取那张 <table>（按行分块），HTML 校验说明取 .markdown-body
  const getSearchRoot = () => {
    if (mode === 'text') return textPreRef.current;
    if (searchingTable) {
      return (
        tableSearchRef.current?.querySelector('table') ??
        plainScrollRef.current?.querySelector('table') ??
        null
      );
    }
    if (mode === 'html') {
      return plainScrollRef.current?.querySelector<HTMLElement>('.markdown-body') ?? null;
    }
    return mdScrollRef.current?.querySelector<HTMLElement>('.markdown-body') ?? null;
  };
  // 整表检索：数据页 / 单份 csv 的关键词交给服务端流式扫一遍这张表，
  // 命中回来带行号，选中后翻到那一页再滚过去高亮（见 openspec table-full-scan-search）
  const tableSearchSource: PreviewSearchSource = useCallback(
    async (queryText, signal) => {
      const tokens = queryTokens(queryText);
      const targetPath = tableHandleRef.current?.activePath() ?? item.path;
      const sheet = tableHandleRef.current?.activeSheet();
      try {
        const res = await api.tableSearch(projectId, targetPath, queryText, { signal, sheet });
        const hits = res.rows.map((row) => ({
          key: String(row.row),
          // 行号按人的习惯从 1 起数，与表格底部「第 x–y 行」的口径一致
          label: `第 ${(row.row + 1).toLocaleString('zh-CN')} 行`,
          parts: toSnippetParts(csvRowText(row.text), tokens),
          pick: () => tableHandleRef.current?.jumpToRow(row.row, res.mtime),
        }));
        const scanned = res.scannedRows.toLocaleString('zh-CN');
        return {
          hits,
          total: hits.length,
          truncated: res.truncated,
          // 没扫完就不能说"整表" —— 扫到哪儿说到哪儿
          summary: res.partial
            ? `扫到第 ${scanned} 行，命中 ${hits.length} 处`
            : res.truncated
              ? `整表命中超过 ${hits.length} 处`
              : `整表 ${hits.length} 处命中`,
          notice: res.partial
            ? `这张表太大，只扫到第 ${scanned} 行就到了单次检索的时间上限，后面还没扫。`
            : undefined,
          // 空态措辞要点破两件事：搜的是整张表，以及匹配要求是"一行里出现全部关键词"
          emptyHint: res.partial
            ? `只扫到第 ${scanned} 行就到了时间上限，后面还没扫 —— 不代表整张表里没有。换个更短的关键词再试。`
            : `整张表${res.totalRows ? `（共 ${res.totalRows.toLocaleString('zh-CN')} 行）` : ''}都扫过了，没有哪一行同时出现全部关键词。搜索只覆盖当前这张表。`,
        } satisfies PreviewSearchOutcome;
      } catch (err) {
        // 只有"老服务没这条路由"才降级。500 / 断网如实报错 ——
        // 悄悄退回只搜一页，会让人以为整张表里真的没有
        if (err instanceof ApiError && err.status === 404) {
          const blocks = collectBlocks(getSearchRoot());
          const { hits, total, truncated } = searchBlocks(blocks, queryText);
          return {
            total,
            truncated,
            summary: `当前这一页 ${total} 处命中`,
            notice: '接口服务的进程比前端旧，这次只搜了当前这一页；重启 serve 后可搜整张表。',
            emptyHint:
              '这次只搜了当前这一页，不是整张表 —— 接口服务的进程比前端旧，重启 serve 后可搜整张表。',
            hits: hits.map((hit) => ({
              key: String(hit.index),
              parts: hit.parts,
              pick: () => jumper.jump(blocks[hit.index]?.el),
            })),
          } satisfies PreviewSearchOutcome;
        }
        throw err;
      }
    },
    // getSearchRoot 没进依赖：它每次渲染都是新函数，但读的全是 ref，行为不随渲染变
    [projectId, item.path, jumper],
  );

  // 「后退」与搜索同在正文左上角的悬浮条里
  const previewToolbar =
    onBack || canSearch ? (
      <PreviewToolbar>
        {onBack ? (
          <PreviewToolButton label="后退" onClick={onBack}>
            <ArrowLeft className="size-3.5" />
          </PreviewToolButton>
        ) : null}
        {canSearch ? (
          <PreviewSearch
            key={searchResetKey}
            getBlocksRoot={getSearchRoot}
            jumper={jumper}
            source={searchingTable ? tableSearchSource : undefined}
          />
        ) : null}
      </PreviewToolbar>
    ) : null;

  return (
    <aside
      className={cn(
        'flex h-full min-h-0 min-w-0 flex-col bg-background max-[899px]:border-l-0',
        // 展开全屏后去掉左分割线
        expanded ? 'border-l-0' : 'border-l border-border',
        'transition-[border-color] duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
      )}
    >
      <header className="flex h-16 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-sm font-medium">{item.title || item.name}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{item.path}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onToggleExpand ? (
            <HeaderIconButton
              // 窄屏本就是全屏浮层，展开无意义
              className="hidden min-[900px]:inline-flex"
              label={expanded ? '向右收起' : '向左展开'}
              pressed={expanded}
              onClick={onToggleExpand}
            >
              {expanded ? (
                <ArrowRightFromLine className="size-4" />
              ) : (
                <ArrowLeftToLine className="size-4" />
              )}
            </HeaderIconButton>
          ) : null}
          {canAnnotate ? (
            <HeaderIconButton
              className={annotate.active ? 'bg-accent' : undefined}
              label={annotateLabel}
              pressed={annotate.active}
              onClick={annotate.toggle}
            >
              <Pencil
                className={cn(
                  'size-4',
                  annotate.active && 'fill-current',
                  notesDirty && 'text-destructive',
                )}
              />
            </HeaderIconButton>
          ) : null}
          <HeaderIconButton
            label={pinned ? '取消收藏' : '收藏置顶'}
            pressed={pinned}
            onClick={() => togglePin(item.path)}
          >
            <Star className={cn('size-4', pinned && 'fill-current')} />
          </HeaderIconButton>
          {mode === 'table' && isSpreadsheetItem(item) ? (
            <HeaderIconButton
              label="用默认程序打开"
              onClick={() => void api.reveal(projectId, item.path, 'open')}
            >
              <SquareArrowOutUpRight className="size-4" />
            </HeaderIconButton>
          ) : null}
          <HeaderIconButton
            label={`在${fileManager}中显示`}
            onClick={() => void api.reveal(projectId, item.path)}
          >
            <FolderOpen className="size-4" />
          </HeaderIconButton>
          <HeaderIconButton label="关闭" onClick={onClose}>
            <X className="size-4" />
          </HeaderIconButton>
        </div>
      </header>

      {topBar}

      {/*
        带目录的文档面：markdown 正文，以及表格包的「摘要」页。
        目录 absolute 贴预览右缘：展开/收起时位置固定，不参与 flex 分宽（避免左右摇摆）
      */}
      {replaceBody ? (
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-5">
          <div className="mx-auto w-full max-w-[76ch]">{replaceBody}</div>
        </div>
      ) : mode === 'markdown' ? (
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
            {previewToolbar}
            <div
              ref={mdScrollRef}
              data-reader-scroll
              className={cn(
                'h-full min-h-0 min-w-0 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-5',
                // 与目录轨同宽，加载前后布局高度/宽度稳定
                'min-[900px]:pr-[calc(200px+0.75rem)] xl:pr-[calc(220px+0.75rem)]',
              )}
            >
              {loading ? <p className="text-sm text-muted-foreground">读取中…</p> : null}
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              {content && !error ? (
                <div className="mx-auto w-full max-w-[76ch]">
                  <SourceBar
                    key={item.path}
                    meta={meta}
                    sourceState={sourceState}
                    projectId={projectId}
                    path={verifyPath}
                    canIngest={canIngest}
                    ingest={ingest}
                    onReconverted={onReconverted}
                  />
                  <AnnotationLayer
                    notes={annotations.notes}
                    contentKey={body}
                    active={annotate.active}
                    mode={annotate.mode}
                    request={annotate.request}
                    onCreate={(input) => annotations.add(input, item.mtime)}
                    onUpdate={annotations.update}
                    onRequestDone={annotate.clearRequest}
                    onToast={annotate.say}
                    onEscape={() => setAnnotating(false)}
                  >
                    <Markdown
                      key={item.path}
                      sourceFile={annotateFile}
                      sourceByteOffset={sourceByteOffset}
                      urlTransform={(url) =>
                        shouldPassthroughUrl(url)
                          ? url
                          : api.fileUrl(projectId, resolveRelative(base, url))
                      }
                      onHeadingsChange={(items) => setTocState({ path: item.path, items })}
                      resolveLink={resolveBodyLink}
                      onInternalLink={onInternalLink}
                    >
                      {body}
                    </Markdown>
                  </AnnotationLayer>
                </div>
              ) : null}
            </div>

            <div
              className={cn(
                'absolute inset-y-0 right-0 hidden w-[200px] flex-col bg-background px-3 py-4 xl:w-[220px]',
                'min-[900px]:flex',
              )}
            >
              <DocumentToc items={tocItems} scrollContainerRef={mdScrollRef} />
            </div>
            <AnnotationToolbar
              projectId={projectId}
              file={annotateFile}
              mtime={item.mtime}
              notes={annotations.notes}
              seenMtime={annotations.seenMtime}
              session={annotate}
              onRemove={annotations.remove}
              onClear={annotations.clear}
              delivery={delivery}
              onOpenDeaiRule={onOpenDeaiRule}
            />
        </div>
      ) : tablePackage ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-border px-4 pt-3 sm:px-6">
            <Tabs
              value={tableTab}
              onValueChange={(v) => setTableTab(v === 'data' ? 'data' : 'summary')}
            >
              <TabsList variant="line" className="px-0">
                <TabsTrigger value="summary">摘要</TabsTrigger>
                <TabsTrigger value="data">数据</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          <div
            ref={tableSearchRef}
            className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          >
          {previewToolbar}
          {tableTab === 'summary' ? (
            <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
              <div
                ref={mdScrollRef}
                data-reader-scroll
                className={cn(
                  'h-full min-h-0 min-w-0 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-5',
                  'min-[900px]:pr-[calc(200px+0.75rem)] xl:pr-[calc(220px+0.75rem)]',
                )}
              >
                {manifestLoading ? <p className="text-sm text-muted-foreground">读取中…</p> : null}
                {manifestError ? <p className="text-sm text-destructive">{manifestError}</p> : null}
                {manifestContent && !manifestError ? (
                  <div className="mx-auto w-full max-w-[76ch]">
                    <SourceBar
                      key={item.path}
                      meta={meta}
                      sourceState={sourceState}
                      projectId={projectId}
                      path={verifyPath}
                      canIngest={canIngest}
                      ingest={ingest}
                      onReconverted={onReconverted}
                    />
                    {sqlitePath ? (
                      <p className="mb-4 rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] text-muted-foreground">
                        SQL 库：{sqlitePath}
                        <span className="mt-1 block font-sans text-xs">
                          精确检索用下方示例命令查 sqlite，看板只展示摘要与分页样例，不加载全表。
                        </span>
                      </p>
                    ) : null}
                    <Markdown
                      key={`${item.path}-table-manifest`}
                      urlTransform={manifestUrlTransform}
                      onHeadingsChange={(items) => setTocState({ path: item.path, items })}
                      resolveLink={resolveManifestLink}
                      onInternalLink={onInternalLink}
                    >
                      {body}
                    </Markdown>
                  </div>
                ) : !manifestLoading && !manifestError ? (
                  <p className="text-sm text-muted-foreground">
                    这个转换目录没有 _manifest.md，可直接切到「数据」看表。
                  </p>
                ) : null}
              </div>
              <div
                className={cn(
                  'absolute inset-y-0 right-0 hidden w-[200px] flex-col bg-background px-3 py-4 xl:w-[220px]',
                  'min-[900px]:flex',
                )}
              >
                <DocumentToc items={tocItems} scrollContainerRef={mdScrollRef} />
              </div>
            </div>
          ) : (
            <ScrollArea className="min-h-0 min-w-0 flex-1" viewportClassName="px-4 py-4 sm:px-6 sm:py-5">
              <TableReader
                ref={tableHandleRef}
                projectId={projectId}
                item={item}
                sheets={sheets}
                jumper={jumper}
                onActivePathChange={setActiveTablePath}
                onActiveSheetChange={(sheet) => setActiveTableSheet(sheet || '')}
              />
            </ScrollArea>
          )}
          </div>
        </div>
      ) : (
        <div ref={plainScrollRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {previewToolbar}
        <ScrollArea className="min-h-0 min-w-0 flex-1" viewportClassName="px-4 py-4 sm:px-6 sm:py-5">
          {mode === 'text' ? (
            <>
              {loading ? <p className="text-sm text-muted-foreground">读取中…</p> : null}
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              {content && !error ? (
                codeLang ? (
                  <CodeFileView
                    code={content}
                    language={codeLang}
                    label={codeLabel}
                    preRef={textPreRef}
                  />
                ) : (
                  <pre ref={textPreRef} className="font-mono text-xs leading-6 whitespace-pre-wrap">
                    {content.split('\n').map((line, index, lines) => (
                      // 按行包一层块级 span：纯文本才有"块"可索引、可跳转、可高亮。
                      // 换行符留在 span 里当真实文本，折行与复制行为不变（preview-search 决策 2）；
                      // 末行只在原文以换行结尾时才补 '\n'，不往复制结果里添原文没有的换行
                      <span key={index} className="block">
                        {index < lines.length - 1 || content.endsWith('\n') ? `${line}\n` : line}
                      </span>
                    ))}
                  </pre>
                )
              ) : null}
            </>
          ) : null}

          {mode === 'table' ? (
            <TableReader
              ref={tableHandleRef}
              projectId={projectId}
              item={item}
              sheets={multiSheet ? sheets : [{ path: item.path, name: item.name, size: item.size }]}
              jumper={jumper}
              onActivePathChange={setActiveTablePath}
              onActiveSheetChange={(sheet) => setActiveTableSheet(sheet || '')}
            />
          ) : null}

          {mode === 'gallery' && isGallery(item) ? (
            <AssetGalleryReader group={item} projectId={projectId} />
          ) : null}

          {mode === 'image' ? (
            <img
              src={api.fileUrl(projectId, item.path)}
              alt={item.name}
              className="mx-auto max-w-full rounded-lg border border-border"
            />
          ) : null}

          {mode === 'html' ? (
            <div className="flex min-h-[min(70vh,640px)] flex-col gap-3">
              <SourceBar
                key={item.path}
                meta={meta}
                sourceState={sourceState}
                projectId={projectId}
                path={verifyPath}
                canIngest={canIngest}
                ingest={ingest}
                onReconverted={onReconverted}
              />
              <Tabs
                value={htmlTab}
                onValueChange={(v) => setHtmlTab(v === 'manifest' ? 'manifest' : 'preview')}
                className="flex min-h-0 flex-1 flex-col gap-3"
              >
                <TabsList variant="line" className="px-0">
                  <TabsTrigger value="preview">预览</TabsTrigger>
                  {hasManifest ? <TabsTrigger value="manifest">校验说明</TabsTrigger> : null}
                </TabsList>
                <TabsContent value="preview" className="min-h-0 flex-1">
                  {htmlPath ? (
                    <div className="flex h-[min(70vh,640px)] flex-col gap-2">
                      <iframe
                        ref={htmlFrameRef}
                        title={
                          item.title ||
                          (isConverted(item) ? item.htmlName : undefined) ||
                          item.name
                        }
                        src={api.fileUrl(projectId, htmlPath)}
                        sandbox="allow-scripts allow-forms allow-modals allow-popups"
                        className="h-full w-full flex-1 rounded-lg border border-border bg-white"
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void htmlFrameRef.current?.requestFullscreen?.()}
                        >
                          <Expand className="size-3.5" />
                          全屏演示
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void api.reveal(projectId, htmlPath, 'open')}
                        >
                          <SquareArrowOutUpRight className="size-3.5" />
                          用浏览器打开
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => void api.reveal(projectId, htmlPath)}>
                          <FolderOpen className="size-3.5" />
                          在{fileManager}中显示
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">目录里没有找到可预览的 HTML 文件。</p>
                  )}
                </TabsContent>
                <TabsContent value="manifest" className="min-h-0 flex-1">
                  {manifestLoading ? <p className="text-sm text-muted-foreground">读取中…</p> : null}
                  {manifestError ? <p className="text-sm text-destructive">{manifestError}</p> : null}
                  {manifestContent && !manifestError ? (
                    <div className="mx-auto w-full max-w-[76ch]">
                      <Markdown
                        key={`${item.path}-manifest`}
                        urlTransform={manifestUrlTransform}
                        resolveLink={resolveManifestLink}
                        onInternalLink={onInternalLink}
                      >
                        {body}
                      </Markdown>
                    </div>
                  ) : null}
                </TabsContent>
              </Tabs>
            </div>
          ) : null}

          {isPdf ? (
            <div className="flex h-[min(80vh,900px)] flex-col gap-2">
              <iframe
                title={item.title || item.name}
                src={api.fileUrl(projectId, item.path)}
                className="h-full w-full flex-1 rounded-lg border border-border bg-white"
              />
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => void api.reveal(projectId, item.path, 'open')}>
                  <SquareArrowOutUpRight className="size-3.5" />
                  用默认程序打开
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void api.reveal(projectId, item.path)}>
                  <FolderOpen className="size-3.5" />
                  在{fileManager}中显示
                </Button>
              </div>
            </div>
          ) : null}

          {isDocx ? (
            <DocxView
              projectId={projectId}
              path={item.path}
              title={item.title || item.name}
              size={item.size}
              mtime={item.mtime}
            />
          ) : null}

          {mode === 'external' && !isPdf && !isDocx ? (
            <div className="flex flex-col items-start gap-4 rounded-lg border border-dashed border-border px-5 py-8">
              <div className="flex flex-col gap-1">
                <p className="text-sm">这是原始格式文档，网页里不渲染。</p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(item.size)} · {formatRelative(item.mtime)}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => void api.reveal(projectId, item.path, 'open')}>
                  <SquareArrowOutUpRight className="size-3.5" />
                  用默认程序打开
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void api.reveal(projectId, item.path)}>
                  <FolderOpen className="size-3.5" />
                  在{fileManager}中显示
                </Button>
              </div>
            </div>
          ) : null}
        </ScrollArea>
        </div>
      )}
    </aside>
  );
}

/** 产出三组里的 .md 才可能有交付稿（交付稿目录镜像原稿路径） */
const DELIVERY_SOURCE_RE = /^output\/(analysis|docs|decisions)\/.+\.md$/i;

/**
 * 预览区。外面这一层只管去 AI 味的交付稿：原稿有交付稿时在顶栏下显示版本条，
 * 切到某一版就把那一版当成一份 .md 交给 ReaderBody（批注、目录、搜索都照常），
 * 选了对比就用对比视图替换正文。没有交付稿、旧服务进程（接口 404）、工作空间目录丢失时，
 * 与改动前完全一样。
 */
export function Reader({
  workspaceAvailable = true,
  refreshToken,
  deliveryFocus,
  onOpenDeaiRule,
  ...props
}: ReaderProps & {
  /** 工作空间目录丢失（`available === false`）时不请求交付稿接口 */
  workspaceAvailable?: boolean;
  /** SSE 变化令牌：交付稿目录有新版本时重拉 */
  refreshToken?: unknown;
  /** 从工作台跳进来：选中原稿 source 的某一版，并打开批注清单 */
  deliveryFocus?: { source: string; version: string; seq: number } | null;
  onOpenDeaiRule?: (rule: string) => void;
}) {
  const { projectId, item } = props;
  const eligible = workspaceAvailable && Boolean(item.docKey) && DELIVERY_SOURCE_RE.test(item.path);
  const list = useDeliveryVersions(projectId, eligible ? item.docKey : undefined, refreshToken);
  const versions = list?.source === item.path ? list.versions : [];
  const [selected, setSelected] = useState('source');
  const [compare, setCompare] = useState<CompareMode | null>(null);
  const [annotateSignal, setAnnotateSignal] = useState(0);
  const [converting, setConverting] = useState<FileItem | null>(null);
  const [rulesVersion, setRulesVersion] = useState<number | undefined>(undefined);

  useEffect(() => {
    setSelected('source');
    setCompare(null);
  }, [item.path]);

  useEffect(() => {
    if (!deliveryFocus || deliveryFocus.source !== item.path) return;
    if (!versions.some((v) => v.version === deliveryFocus.version)) return;
    setSelected(deliveryFocus.version);
    setCompare(null);
    setAnnotateSignal((n) => n + 1);
    // versions 到位之后再对一次：从工作台跳进来时列表往往还在路上
  }, [deliveryFocus, item.path, versions]);

  // 批注提示词里要写「规则库当前 vN」：有交付稿时顺手取一次，取不到就不写版本号
  const hasVersions = versions.length > 0;
  useEffect(() => {
    if (!hasVersions) return;
    let alive = true;
    api.deaiRules(projectId)
      .then((r) => { if (alive) setRulesVersion(r.version); })
      .catch(() => { if (alive) setRulesVersion(undefined); });
    return () => {
      alive = false;
    };
  }, [projectId, hasVersions]);

  const current = versions.find((v) => v.version === selected);
  const bodyItem: FileItem = current
    ? {
      path: current.path,
      name: `${current.version}.md`,
      ext: '.md',
      reader: 'markdown',
      size: 0,
      mtime: current.mtime || item.mtime,
      title: `${item.title || item.name} · 交付稿 ${current.version}`,
      docKey: current.docKey,
    }
    : item;
  const nextPath = `${deliveryDirOf(item.path)}/${nextVersion(versions.map((v) => v.version))}.md`;

  return (
    <>
      <ReaderBody
        {...props}
        item={bodyItem}
        topBar={hasVersions ? (
          <DeliveryBar
            versions={versions}
            selected={current ? current.version : 'source'}
            onSelect={(v) => {
              setSelected(v);
              setCompare(null);
            }}
            compare={compare}
            onCompare={setCompare}
            onAnnotate={() => {
              setCompare(null);
              setAnnotateSignal((n) => n + 1);
            }}
            onConvert={() => setConverting(bodyItem)}
          />
        ) : undefined}
        replaceBody={current && compare ? (
          <DeliveryDiff projectId={projectId} source={item.path} versions={versions} current={current} mode={compare} />
        ) : undefined}
        annotateSignal={annotateSignal}
        delivery={current ? { version: current.version, nextPath, rulesVersion } : undefined}
        onOpenDeaiRule={onOpenDeaiRule}
      />
      {/* 交付稿不在扫描里：目标 .docx 在不在由服务端判断（409 时再给「覆盖」） */}
      <DocxExportDialog
        projectId={projectId}
        item={converting}
        outputItems={[]}
        onClose={() => setConverting(null)}
        onConverted={(target) => {
          if ((props.onOpenPath?.(target.path) ?? 'external') === 'external') {
            window.open(api.fileUrl(projectId, target.path), '_blank', 'noreferrer');
          }
        }}
      />
    </>
  );
}
