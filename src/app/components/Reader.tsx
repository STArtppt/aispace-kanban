import { useEffect, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import {
  ArrowLeftToLine,
  ArrowRightFromLine,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  SquareArrowOutUpRight,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DocumentToc, Markdown, type TocItem } from '@/components/Markdown';
import { api, type ConvertedItem, type FileItem } from '@/lib/api';
import { formatBytes, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

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

function SourceBar({ meta }: { meta: [string, string][] }) {
  const [open, setOpen] = useState(false);
  if (!meta.length) return null;
  const warning = meta.find(([k]) => k === 'warning');
  const source = meta.find(([k]) => k === 'source');
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
        {warning ? (
          <Badge variant="outline" className="border-destructive text-destructive">
            内容存疑
          </Badge>
        ) : null}
      </button>
      {open ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-border px-3 py-2.5">
          {meta.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{key}</dt>
              <dd className={key === 'warning' ? 'text-destructive' : 'font-mono text-[11px] break-all'}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function CsvTable({ text }: { text: string }) {
  const rows = useMemo(() => {
    const parsed = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true });
    return parsed.data;
  }, [text]);
  if (!rows.length) return <p className="text-sm text-muted-foreground">这张表是空的。</p>;
  const [head, ...body] = rows;
  if (!head?.length) return <p className="text-sm text-muted-foreground">这张表是空的。</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-muted/60">
          <tr>
            {head.map((cell, i) => (
              <th key={i} className="border-b border-border px-3 py-2 text-left text-xs font-medium whitespace-nowrap">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, i) => (
            <tr key={i} className="hover:bg-accent/50">
              {head.map((_, j) => (
                <td key={j} className="border-b border-border px-3 py-2 align-top whitespace-pre-wrap">
                  {row[j] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
        {body.length} 行 × {head.length} 列
      </div>
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
function useFileContent(projectId: string, path: string | null) {
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
  }, [projectId, path]);

  const aligned = path !== null && resolvedPath === path;
  // 有对齐正文时绝不因后台刷新闪 loading；仅无正文且已过延迟才提示
  const loading = Boolean(path) && showSpinner && !aligned;
  const displayContent = aligned ? content : '';

  return { content: displayContent, loading, error: aligned ? error : '' };
}

/** 多 sheet（xlsx 拆目录）或单 csv/tsv 表格预览。 */
function TableReader({
  projectId,
  item,
  sheets,
}: {
  projectId: string;
  item: FileItem;
  sheets: { path: string; name: string }[];
}) {
  const multi = sheets.length > 1;
  const firstPath = sheets[0]?.path || item.path;
  const [active, setActive] = useState(firstPath);
  const { content, loading, error } = useFileContent(projectId, active || null);

  useEffect(() => {
    setActive(firstPath);
  }, [item.path, firstPath]);

  if (!multi) {
    return (
      <>
        {loading ? <p className="text-sm text-muted-foreground">读取中…</p> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {content && !error ? <CsvTable text={content} /> : null}
      </>
    );
  }

  return (
    <Tabs value={active} onValueChange={(v) => setActive(String(v))} className="gap-3">
      <TabsList variant="line" className="px-0">
        {sheets.map((sheet) => (
          <TabsTrigger key={sheet.path} value={sheet.path} title={sheet.name}>
            {sheetLabel(sheet.name)}
          </TabsTrigger>
        ))}
      </TabsList>
      {sheets.map((sheet) => (
        <TabsContent key={sheet.path} value={sheet.path} className="min-h-0 min-w-0">
          {active === sheet.path ? (
            <>
              {loading ? <p className="text-sm text-muted-foreground">读取中…</p> : null}
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              {content && !error ? <CsvTable text={content} /> : null}
            </>
          ) : null}
        </TabsContent>
      ))}
    </Tabs>
  );
}

function isConverted(item: FileItem): item is ConvertedItem {
  return 'isDir' in item || 'sheets' in item;
}

export function Reader({
  projectId,
  item,
  onClose,
  expanded = false,
  onToggleExpand,
}: {
  projectId: string;
  item: FileItem;
  onClose: () => void;
  /** 宽屏下预览是否已向左展开至主区全宽 */
  expanded?: boolean;
  /** 宽屏提供；窄屏预览本就是全屏，不传则不显示展开按钮 */
  onToggleExpand?: () => void;
}) {
  const sheets = useMemo(() => {
    if (isConverted(item) && item.sheets?.length) {
      return item.sheets.map((s) => ({ path: s.path, name: s.name }));
    }
    return [] as { path: string; name: string }[];
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

  const mode: 'markdown' | 'table' | 'text' | 'image' | 'html' | 'external' = multiSheet
    ? 'table'
    : item.reader;

  const contentPath =
    mode === 'markdown' && isDir
      ? manifestPath
      : mode === 'markdown' || mode === 'text'
        ? item.path
        : null;

  // 表格内容由 TableReader 自行拉取；此处只负责 md / 纯文本
  const { content, loading, error } = useFileContent(projectId, contentPath);

  // 多 sheet / html 原型：manifest 做溯源与「校验说明」页
  const { content: manifestContent, loading: manifestLoading, error: manifestError } = useFileContent(
    projectId,
    (multiSheet || mode === 'html') && isDir ? manifestPath : null,
  );

  const { meta, body } = useMemo(() => {
    if (mode === 'markdown') return splitFrontmatter(content);
    if ((multiSheet || mode === 'html') && manifestContent) return splitFrontmatter(manifestContent);
    return { meta: [] as [string, string][], body: content };
  }, [content, mode, multiSheet, manifestContent]);

  const base = dirOf(mode === 'markdown' && isDir ? manifestPath : item.path);
  const [htmlTab, setHtmlTab] = useState<'preview' | 'manifest'>('preview');

  // markdown 目录：放在滚动区外；条目来自渲染后 DOM，与锚点严格一致
  const mdScrollRef = useRef<HTMLDivElement>(null);
  const [tocState, setTocState] = useState<{ path: string; items: TocItem[] }>({
    path: item.path,
    items: [],
  });
  // 路径变化时同步清空（render 期更新，避免 effect 清掉 layout 刚写入的目录）
  if (tocState.path !== item.path) {
    setTocState({ path: item.path, items: [] });
  }
  const tocItems = mode === 'markdown' && tocState.path === item.path ? tocState.items : [];

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
          <Button
            variant="ghost"
            size="icon"
            title="在访达中显示"
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
        markdown：正文可滚 + 右侧目录
        目录 absolute 贴预览右缘：展开/收起时位置固定，不参与 flex 分宽（避免左右摇摆）
        宽屏 markdown 始终预留右轨，避免标题解析后目录突然出现把正文挤一下
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
                <SourceBar meta={meta} />
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

          {/* 宽屏常驻右轨：「目录」标题始终在；无标题时 DocumentToc 内显示「暂无目录」 */}
          <div
            className={cn(
              // 贴右绝对定位：预览变宽时右缘不动，目录不跟着正文 reflow 摇摆
              'absolute inset-y-0 right-0 hidden w-[200px] flex-col bg-background px-3 py-4 xl:w-[220px]',
              'min-[900px]:flex',
            )}
          >
            <DocumentToc items={tocItems} scrollContainerRef={mdScrollRef} />
          </div>
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
            <>
              {multiSheet && meta.length ? <SourceBar meta={meta} /> : null}
              <TableReader
                projectId={projectId}
                item={item}
                sheets={multiSheet ? sheets : [{ path: item.path, name: item.name }]}
              />
            </>
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
              <SourceBar meta={meta} />
              <Tabs
                value={htmlTab}
                onValueChange={(v) => setHtmlTab(v === 'manifest' ? 'manifest' : 'preview')}
                className="flex min-h-0 flex-1 flex-col gap-3"
              >
                <TabsList variant="line" className="px-0">
                  <TabsTrigger value="preview">预览</TabsTrigger>
                  <TabsTrigger value="manifest">校验说明</TabsTrigger>
                </TabsList>
                <TabsContent value="preview" className="min-h-0 flex-1">
                  {htmlPath ? (
                    <div className="flex h-[min(70vh,640px)] flex-col gap-2">
                      <iframe
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
                          onClick={() => void api.reveal(projectId, htmlPath, 'open')}
                        >
                          <SquareArrowOutUpRight className="size-3.5" />
                          用浏览器打开
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => void api.reveal(projectId, htmlPath)}>
                          <FolderOpen className="size-3.5" />
                          在访达中显示
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
                  在访达中显示
                </Button>
              </div>
            </div>
          ) : null}
        </ScrollArea>
      )}
    </aside>
  );
}
