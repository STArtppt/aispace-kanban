import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import {
  ArrowLeftToLine,
  ArrowRightFromLine,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Expand,
  FolderOpen,
  Loader2,
  RefreshCw,
  SquareArrowOutUpRight,
  Star,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AssetGalleryReader } from '@/components/AssetGalleryReader';
import { DocumentToc, Markdown, type TocItem } from '@/components/Markdown';
import { useFileManagerName } from '@/hooks/useFileManager';
import { type IngestControl } from '@/hooks/useIngestJob';
import { useOutputPins } from '@/hooks/useOutputPins';
import {
  api,
  type AssetGroup,
  type ConvertedItem,
  type FileItem,
  type SourceVerification,
} from '@/lib/api';
import { formatBytes, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

/** 表格预览每页行数（不含表头）；大点表只拉一页，避免整文件进内存 */
const TABLE_PAGE_SIZE = 50;

/** 只做展示用的 frontmatter 拆分，和服务端那份保持一致的宽松规则。 */
function splitFrontmatter(text: string): { meta: [string, string][]; body: string } {
  if (!text.startsWith('---')) return { meta: [], body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { meta: [], body: text };
  const raw = text.slice(text.indexOf('\n') + 1, end);
  const meta: [string, string][] = [];
  for (const line of raw.split(/\r?\n/)) {
    const kv = /^([\w.-]+):\s*(.*)$/.exec(line);
    if (kv && kv[2]) meta.push([kv[1], kv[2]]);
  }
  return { meta, body: text.slice(end + 4).replace(/^\r?\n/, '') };
}

function dirOf(path: string) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** 把 markdown 里的相对图片路径解析成后端的文件接口地址。 */
function resolveRelative(base: string, url: string) {
  if (/^(https?:|data:|#)/.test(url)) return url;
  const segments = `${base}/${url}`.split('/');
  const stack: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return stack.join('/');
}

function sheetLabel(name: string) {
  return name.replace(/\.(csv|tsv)$/i, '') || name;
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
  /** 产物自身的相对路径，校验接口按它反查 frontmatter 里的来源 */
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
                <tr key={i} className="hover:bg-accent/50">
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

/** 走 /table 分页接口；大点表也不会再撞「文件太大」。 */
function PaginatedCsvTable({ projectId, path }: { projectId: string; path: string }) {
  const [page, setPage] = useState(0);
  const [head, setHead] = useState<string[]>([]);
  const [body, setBody] = useState<string[][]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [size, setSize] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setPage(0);
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .table(projectId, path, { offset: page * TABLE_PAGE_SIZE, limit: TABLE_PAGE_SIZE })
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
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setHead([]);
        setBody([]);
        setTotalRows(0);
        setError(err.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, path, page]);

  if (loading && !head.length) {
    return <p className="text-sm text-muted-foreground">读取表格中…</p>;
  }
  if (error) return <p className="text-sm text-destructive">{error}</p>;

  return (
    <div className="flex flex-col gap-2">
      {loading ? <p className="text-xs text-muted-foreground">翻页加载中…</p> : null}
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
function useFileContent(projectId: string, path: string | null, refreshKey = 0) {
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

/** 多 sheet（xlsx 拆目录 / 点表分册）或单 csv/tsv；一律走分页接口。 */
function TableReader({
  projectId,
  item,
  sheets,
}: {
  projectId: string;
  item: FileItem;
  sheets: { path: string; name: string; size?: number }[];
}) {
  const multi = sheets.length > 1;
  const firstPath = sheets[0]?.path || item.path;
  const [active, setActive] = useState(firstPath);

  useEffect(() => {
    setActive(firstPath);
  }, [item.path, firstPath]);

  // 必须在 early return 之前：单 sheet / 多 sheet 切换时 TableReader 会复用同一实例
  const byPath = useMemo(() => new Map(sheets.map((s) => [s.path, s])), [sheets]);

  if (!multi) {
    return <PaginatedCsvTable projectId={projectId} path={firstPath} />;
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
      <PaginatedCsvTable key={active} projectId={projectId} path={active} />
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

export function Reader({
  projectId,
  item,
  onClose,
  expanded = false,
  onToggleExpand,
  canIngest,
  ingest,
}: {
  projectId: string;
  item: FileItem;
  onClose: () => void;
  /** 宽屏下预览是否已向左展开至主区全宽 */
  expanded?: boolean;
  /** 宽屏提供；窄屏预览本就是全屏，不传则不显示展开按钮 */
  onToggleExpand?: () => void;
  /** 工作空间有 scripts/ingest.py 时才给「重新转换」 */
  canIngest?: boolean;
  /** 与待转换列表共用的转换任务；不传则溯源栏只有「校验原件」 */
  ingest?: IngestControl;
}) {
  const fileManager = useFileManagerName();
  // 收藏只对产出文档有意义：会置顶的那份清单只有「产出文档」视图有
  const canPin = item.path.startsWith('output/');
  const { pins, togglePin } = useOutputPins(projectId);
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
  const manifestPath = isDir ? `${item.path.replace(/\/$/, '')}/_manifest.md` : '';
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
  const { content, loading, error } = useFileContent(projectId, contentPath, reconvertedAt);

  // 目录型表格包 / html 原型：manifest 做摘要、SQL 指南、校验说明
  const { content: manifestContent, loading: manifestLoading, error: manifestError } = useFileContent(
    projectId,
    (multiSheet || mode === 'html') && isDir ? manifestPath : null,
    reconvertedAt,
  );

  const { meta, body } = useMemo(() => {
    if (mode === 'markdown') return splitFrontmatter(content);
    if ((multiSheet || mode === 'html') && manifestContent) return splitFrontmatter(manifestContent);
    return { meta: [] as [string, string][], body: content };
  }, [content, mode, multiSheet, manifestContent]);

  const base = dirOf(mode === 'markdown' && isDir ? manifestPath : item.path);
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

  return (
    <aside
      className={cn(
        'flex h-full min-h-0 min-w-0 flex-col bg-background max-[899px]:border-l-0',
        // 展开全屏后去掉左分割线
        expanded ? 'border-l-0' : 'border-l border-border',
        'transition-[border-color] duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
      )}
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-3 sm:px-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-sm font-medium">{item.title || item.name}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{item.path}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onToggleExpand ? (
            <Button
              variant="ghost"
              size="icon"
              // 窄屏本就是全屏浮层，展开无意义
              className="hidden min-[900px]:inline-flex"
              title={expanded ? '向右收起' : '向左展开'}
              aria-label={expanded ? '向右收起' : '向左展开'}
              aria-pressed={expanded}
              onClick={onToggleExpand}
            >
              {expanded ? (
                <ArrowRightFromLine className="size-4" />
              ) : (
                <ArrowLeftToLine className="size-4" />
              )}
            </Button>
          ) : null}
          {canPin ? (
            <Button
              variant="ghost"
              size="icon"
              title={pinned ? '取消收藏' : '收藏置顶'}
              aria-label={pinned ? '取消收藏' : '收藏置顶'}
              aria-pressed={pinned}
              onClick={() => togglePin(item.path)}
            >
              <Star className={cn('size-4', pinned && 'fill-current')} />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            title={`在${fileManager}中显示`}
            onClick={() => void api.reveal(projectId, item.path)}
          >
            <FolderOpen className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" title="关闭" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </header>

      {/*
        带目录的文档面：markdown 正文，以及表格包的「摘要」页。
        目录 absolute 贴预览右缘：展开/收起时位置固定，不参与 flex 分宽（避免左右摇摆）
      */}
      {mode === 'markdown' ? (
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
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
                  path={item.path}
                  canIngest={canIngest}
                  ingest={ingest}
                  onReconverted={onReconverted}
                />
                <Markdown
                  key={item.path}
                  urlTransform={(url) => api.fileUrl(projectId, resolveRelative(base, url))}
                  onHeadingsChange={(items) => setTocState({ path: item.path, items })}
                >
                  {body}
                </Markdown>
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
                  path={item.path}
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
                      onHeadingsChange={(items) => setTocState({ path: item.path, items })}
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
              <TableReader projectId={projectId} item={item} sheets={sheets} />
            </ScrollArea>
          )}
        </div>
      ) : (
        <ScrollArea className="min-h-0 min-w-0 flex-1" viewportClassName="px-4 py-4 sm:px-6 sm:py-5">
          {mode === 'text' ? (
            <>
              {loading ? <p className="text-sm text-muted-foreground">读取中…</p> : null}
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              {content && !error ? (
                <pre className="font-mono text-xs leading-6 whitespace-pre-wrap">{content}</pre>
              ) : null}
            </>
          ) : null}

          {mode === 'table' ? (
            <TableReader
              projectId={projectId}
              item={item}
              sheets={multiSheet ? sheets : [{ path: item.path, name: item.name, size: item.size }]}
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
                  path={item.path}
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
                      <Markdown key={`${item.path}-manifest`}>{body}</Markdown>
                    </div>
                  ) : null}
                </TabsContent>
              </Tabs>
            </div>
          ) : null}

          {mode === 'external' ? (
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
      )}
    </aside>
  );
}
