import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppWindow, FileText, FolderOpen, Image, Loader2, Search, Table } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ImageLightbox } from '@/components/ImageLightbox';
import { CopyButton, EmptyState, ListPager, Row, SectionTitle, Stat } from '@/components/Primitives';
import { useFileManagerName } from '@/hooks/useFileManager';
import { api, type ConvertedItem, type FileItem, type IngestJob, type Scan } from '@/lib/api';
import { formatBytes, formatRelative, formatWords, markdownLink } from '@/lib/format';

/** 待转换 / 转换产物列表一页条数 */
const LIST_PAGE_SIZE = 12;
/** 转换任务状态轮询间隔；大 PDF 可能跑几分钟，1.5s 足够且不刷接口 */
const INGEST_POLL_MS = 1500;

function KindIcon({ item }: { item: { reader: string; isDir?: boolean } }) {
  if (item.reader === 'html') return <AppWindow className="size-4 text-muted-foreground" />;
  if (item.isDir || item.reader === 'table') return <Table className="size-4 text-muted-foreground" />;
  if (item.reader === 'image') return <Image className="size-4 text-muted-foreground" />;
  return <FileText className="size-4 text-muted-foreground" />;
}

/** 展示相对 raw/ 的路径，同名文件在不同子目录时能区分 */
function pendingLabel(item: FileItem): string {
  const prefix = 'input/raw/';
  if (item.path.startsWith(prefix)) {
    const rel = item.path.slice(prefix.length);
    return rel || item.name;
  }
  return item.name;
}

/** 名称模糊：空格分词，每段都要在标题/文件名/来源/路径里出现（大小写不敏感） */
function matchConverted(item: ConvertedItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [item.title, item.name, item.source, item.path, item.convertedBy]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return q.split(/\s+/).every((part) => hay.includes(part));
}

/**
 * 「有几篇产出提到过它」。
 * hasOutputs 为 false 时一律不显示：一份产出都还没写的工作空间里，所有资料当然都是
 * 零引用，那时候提示只是噪音。referencedBy 缺失说明服务进程比前端旧，同样不显示。
 */
function referenceLabel(item: ConvertedItem, hasOutputs: boolean): string {
  if (!hasOutputs || !item.referencedBy) return '';
  return item.referencedBy.length ? ` · 被 ${item.referencedBy.length} 篇产出引用` : ' · 还没有产出引用它';
}

function ConvertedRow({
  item,
  hasOutputs,
  openPath,
  onOpen,
}: {
  item: ConvertedItem;
  hasOutputs: boolean;
  openPath: string;
  onOpen: (item: FileItem) => void;
}) {
  return (
    <Row onClick={() => onOpen(item)} active={openPath === item.path}>
      <KindIcon item={item} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm">{item.title || item.name}</span>
        </div>
        {/* 产物自身的相对路径：单文件产物到文件，目录型产物到目录 */}
        <span className="truncate text-xs text-muted-foreground" title={item.path}>
          {item.path}
          {item.reader === 'html' ? ' · HTML 原型' : ''}
          {item.sheets?.length ? ` · ${item.sheets.length} 张表` : ''}
          {item.sqlitePath ? ' · 可 SQL 检索' : ''}
          {item.extractedImages ? ` · ${item.extractedImages} 张图` : ''}
          {referenceLabel(item, hasOutputs)}
        </span>
      </div>
      <CopyButton value={markdownLink(item.title || item.name, item.path)} />
    </Row>
  );
}

function useListPage(total: number, pageSize: number, resetKey: string) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const [page, setPage] = useState(0);

  useEffect(() => {
    setPage(0);
  }, [resetKey]);

  useEffect(() => {
    setPage((p) => Math.min(p, totalPages - 1));
  }, [totalPages]);

  return { page, setPage, totalPages };
}

function PendingList({
  items,
  projectId,
  openPath,
  onOpen,
}: {
  items: FileItem[];
  projectId: string;
  openPath: string;
  onOpen: (item: FileItem) => void;
}) {
  const { page, setPage } = useListPage(items.length, LIST_PAGE_SIZE, String(items.length));
  const pageItems = items.slice(page * LIST_PAGE_SIZE, (page + 1) * LIST_PAGE_SIZE);
  const fileManager = useFileManagerName();

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {pageItems.map((item) => (
        <Row key={item.path} onClick={() => onOpen(item)} active={openPath === item.path}>
          <KindIcon item={item} />
          <span className="min-w-0 flex-1 truncate text-sm" title={item.path}>
            {pendingLabel(item)}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(item.size)}</span>
          <CopyButton value={markdownLink(pendingLabel(item), item.path)} />
          <span
            role="button"
            tabIndex={-1}
            title={`在${fileManager}中显示`}
            className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              void api.reveal(projectId, item.path);
            }}
          >
            <FolderOpen className="size-3.5" />
          </span>
        </Row>
      ))}
      <ListPager page={page} pageSize={LIST_PAGE_SIZE} total={items.length} onPageChange={setPage} />
    </div>
  );
}

const REF_FILTERS = {
  all: '全部',
  unreferenced: '未被引用',
} as const;

type RefFilter = keyof typeof REF_FILTERS;

function ConvertedList({
  items,
  hasOutputs,
  openPath,
  onOpen,
}: {
  items: ConvertedItem[];
  hasOutputs: boolean;
  openPath: string;
  onOpen: (item: FileItem) => void;
}) {
  const [query, setQuery] = useState('');
  const [refFilter, setRefFilter] = useState<RefFilter>('all');
  // 没产出、或旧服务没给 referencedBy：筛「未被引用」没意义，控件也不出
  const canFilterUnreferenced = hasOutputs && items.some((item) => Array.isArray(item.referencedBy));
  const activeFilter = canFilterUnreferenced ? refFilter : 'all';
  const filtered = useMemo(
    () =>
      items.filter((item) => {
        if (activeFilter === 'unreferenced' && item.referencedBy?.length !== 0) return false;
        return matchConverted(item, query);
      }),
    [items, query, activeFilter],
  );
  const { page, setPage } = useListPage(
    filtered.length,
    LIST_PAGE_SIZE,
    `${query}\0${activeFilter}\0${items.length}`,
  );
  const pageItems = filtered.slice(page * LIST_PAGE_SIZE, (page + 1) * LIST_PAGE_SIZE);
  const searching = query.trim().length > 0;

  return (
    <div className="flex flex-col gap-2">
      {/* 标题左、筛选+搜索右：同一行，避免再占一整行高度 */}
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0 shrink">
          <SectionTitle count={items.length}>转换产物</SectionTitle>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canFilterUnreferenced ? (
            <Select
              value={refFilter}
              onValueChange={(value) => {
                if (value === 'all' || value === 'unreferenced') setRefFilter(value);
              }}
            >
              <SelectTrigger
                className="h-8 min-h-8 w-[7.5rem] py-0 text-xs"
                aria-label="筛选转换产物"
              >
                <SelectValue>
                  {(value: string | null) => (value && value in REF_FILTERS ? REF_FILTERS[value as RefFilter] : null)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{REF_FILTERS.all}</SelectItem>
                <SelectItem value="unreferenced">{REF_FILTERS.unreferenced}</SelectItem>
              </SelectContent>
            </Select>
          ) : null}
          <div className="relative w-[12rem] sm:w-[14rem]">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="按名称搜索…"
              className="h-8 pl-8 text-xs"
              aria-label="搜索转换产物"
            />
          </div>
        </div>
      </div>
      {searching ? (
        <p className="text-xs text-muted-foreground">
          {filtered.length ? `匹配 ${filtered.length} 项` : '没有匹配的转换产物'}
        </p>
      ) : null}
      {filtered.length ? (
        <div className="overflow-hidden rounded-lg border border-border">
          {pageItems.map((item) => (
            <ConvertedRow
              key={item.path}
              item={item}
              hasOutputs={hasOutputs}
              openPath={openPath}
              onOpen={onOpen}
            />
          ))}
          <ListPager
            page={page}
            pageSize={LIST_PAGE_SIZE}
            total={filtered.length}
            onPageChange={setPage}
          />
        </div>
      ) : searching ? (
        <EmptyState title="没有匹配的转换产物" hint="试试更短的关键词，或清空搜索" />
      ) : activeFilter === 'unreferenced' ? (
        <EmptyState
          title="没有未被引用的资料"
          hint="产出正文里出现它的路径或文件名就算引用"
        />
      ) : null}
    </div>
  );
}

/**
 * 在看板里触发 scripts/ingest.py。
 * canIngest 缺失（旧服务）时整块不渲染，退回文案里的终端命令提示。
 * 写盘由工作空间脚本完成，看板只负责 spawn + 轮询状态；文件变化走已有 SSE。
 */
function IngestControls({ projectId, canIngest }: { projectId: string; canIngest?: boolean }) {
  const [job, setJob] = useState<IngestJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 为 true 时 effect 持续轮询，直到状态离开 running */
  const [polling, setPolling] = useState(false);

  const applyJob = useCallback((next: IngestJob) => {
    setJob(next);
    if (next.status === 'running') setPolling(true);
    else setPolling(false);
    if (next.status === 'error') setError(next.message || '转换失败');
    else if (next.status === 'done') setError('');
  }, []);

  // 切项目：清状态，并查一次是否已有进行中的任务（刷新页面后还能接上）
  useEffect(() => {
    if (!canIngest || !projectId) {
      setJob(null);
      setError('');
      setBusy(false);
      setPolling(false);
      return undefined;
    }
    let cancelled = false;
    void api
      .ingestStatus(projectId)
      .then((status) => {
        if (!cancelled) applyJob(status);
      })
      .catch(() => {
        // 旧服务没有这个接口：静默；点「开始转换」时再报错
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, canIngest, applyJob]);

  useEffect(() => {
    if (!polling || !projectId) return undefined;
    let cancelled = false;
    const timer = setInterval(() => {
      void api
        .ingestStatus(projectId)
        .then((status) => {
          if (!cancelled) applyJob(status);
        })
        .catch((err) => {
          if (!cancelled) {
            setPolling(false);
            setError((err as Error).message);
          }
        });
    }, INGEST_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [polling, projectId, applyJob]);

  if (!canIngest) return null;

  const running = job?.status === 'running' || busy;

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const started = await api.startIngest(projectId);
      applyJob(started);
    } catch (err) {
      setError((err as Error).message);
      setPolling(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={running} onClick={() => void start()}>
          {running ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              转换中…
            </>
          ) : (
            '开始转换'
          )}
        </Button>
        {running ? (
          <span className="text-xs text-muted-foreground">
            {job?.message || '正在转换 input/raw/ …'}
          </span>
        ) : null}
        {job?.status === 'done' && !running ? (
          <span className="text-xs text-muted-foreground">{job.message || '转换完成'}</span>
        ) : null}
      </div>
      {error ? <p className="whitespace-pre-wrap text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/** 抽出的图走灯箱，不占右侧预览。切工作空间时关掉，避免串图。 */
function AssetGrid({ items, projectId }: { items: FileItem[]; projectId: string }) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const openIndex = openPath ? items.findIndex((item) => item.path === openPath) : -1;

  useEffect(() => {
    setOpenPath(null);
  }, [projectId]);

  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {items.map((item) => (
          <button
            key={item.path}
            type="button"
            onClick={() => setOpenPath(item.path)}
            className="group cursor-zoom-in overflow-hidden rounded-lg border border-border bg-muted/40 transition-colors hover:border-foreground/30"
          >
            <img
              src={api.fileUrl(projectId, item.path)}
              alt={item.name}
              loading="lazy"
              className="aspect-[4/3] w-full object-cover"
            />
            <span className="block truncate px-2 py-1.5 text-left text-[11px] text-muted-foreground">
              {item.name}
            </span>
          </button>
        ))}
      </div>
      {openIndex >= 0 ? (
        <ImageLightbox
          key={openPath}
          items={items.map((item) => ({
            src: api.fileUrl(projectId, item.path),
            alt: item.name,
          }))}
          initialIndex={openIndex}
          onClose={() => setOpenPath(null)}
        />
      ) : null}
    </>
  );
}

export function InputPanel({
  scan,
  projectId,
  openPath,
  onOpen,
}: {
  scan: Scan;
  projectId: string;
  openPath: string;
  onOpen: (item: FileItem) => void;
}) {
  const { input } = scan;
  const hasOutputs = scan.output.stats.total > 0;
  // 旧服务进程没有 canIngest：整块按钮不出现，只保留终端命令提示
  const canIngest = Boolean(input.canIngest);

  return (
    <div className="flex flex-col gap-6">
      {/* 固定 3 列 + 固定间距：预览开合时高度稳定 */}
      <div className="grid grid-cols-3 gap-2">
        <Stat label="原始资料" value={input.stats.raw} hint={formatBytes(input.stats.bytes)} />
        <Stat label="已转换" value={input.stats.converted} hint={formatWords(input.stats.words)} />
        <Stat
          label="待转换"
          value={input.stats.pending}
          hint={
            input.stats.warnings
              ? `${input.stats.pending ? '还没进入可读状态' : '资料都已入库'} · ${input.stats.warnings} 份存疑`
              : input.stats.pending
                ? '还没进入可读状态'
                : '资料都已入库'
          }
          tone={input.stats.pending || input.stats.warnings ? 'attention' : 'default'}
        />
      </div>

      <section className="flex flex-col gap-2">
        <SectionTitle count={input.pending.length}>待转换的原始资料</SectionTitle>
        <p className="text-xs text-muted-foreground">
          {input.pending.length
            ? '这些文件还没有对应的转换产物，AI 读不到它们的内容。'
            : '原始资料放进 input/raw/ 后会出现在这里。'}
          {canIngest ? (
            '点下面「开始转换」，看板会在工作空间里跑 scripts/ingest.py（大 PDF 可能要几分钟）。'
          ) : (
            <>
              在工作空间里跑一次
              <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                python3 scripts/ingest.py
              </code>
              即可。
            </>
          )}
        </p>
        <IngestControls projectId={projectId} canIngest={canIngest} />
        {input.pending.length ? (
          <PendingList
            items={input.pending}
            projectId={projectId}
            openPath={openPath}
            onOpen={onOpen}
          />
        ) : (
          <EmptyState title="暂无待转换文件" />
        )}
      </section>

      <section className="flex flex-col gap-2">
        {input.converted.length ? (
          <ConvertedList
            items={input.converted}
            hasOutputs={hasOutputs}
            openPath={openPath}
            onOpen={onOpen}
          />
        ) : (
          <>
            <SectionTitle count={0}>转换产物</SectionTitle>
            <EmptyState
              title="还没有转换产物"
              hint={
                canIngest
                  ? '把资料放进 input/raw/，再点「开始转换」'
                  : '把资料放进 input/raw/，然后在工作空间里跑 scripts/ingest.py'
              }
            />
          </>
        )}
      </section>

      {input.assets.length ? (
        <section className="flex flex-col gap-2">
          <SectionTitle count={input.assets.length}>文档里抽出的图片</SectionTitle>
          <AssetGrid items={input.assets} projectId={projectId} />
        </section>
      ) : null}

      {input.indexPath ? (
        <section className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
          <div className="flex flex-col">
            <span className="text-sm">资料台账 INDEX.md</span>
            <span className="text-xs text-muted-foreground">
              脚本生成的表格 + 人工批注区
              {input.converted[0]?.mtime ? ` · 资料最后入库 ${formatRelative(input.converted[0].mtime)}` : ''}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              onOpen({
                path: input.indexPath,
                name: 'INDEX.md',
                reader: 'markdown',
                size: 0,
                mtime: '',
              })
            }
          >
            打开
          </Button>
        </section>
      ) : null}
    </div>
  );
}
