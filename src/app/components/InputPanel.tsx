import { AppWindow, FileText, FolderOpen, Image, Table } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState, Row, SectionTitle, Stat } from '@/components/Primitives';
import { api, type ConvertedItem, type FileItem, type Scan } from '@/lib/api';
import { formatBytes, formatRelative, formatWords } from '@/lib/format';

function KindIcon({ item }: { item: { reader: string; isDir?: boolean } }) {
  if (item.reader === 'html') return <AppWindow className="size-4 text-muted-foreground" />;
  if (item.isDir || item.reader === 'table') return <Table className="size-4 text-muted-foreground" />;
  if (item.reader === 'image') return <Image className="size-4 text-muted-foreground" />;
  return <FileText className="size-4 text-muted-foreground" />;
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

      {input.pending.length ? (
        <section className="flex flex-col gap-2">
          <SectionTitle count={input.pending.length}>待转换的原始资料</SectionTitle>
          <p className="text-xs text-muted-foreground">
            这些文件还没有对应的转换产物，AI 读不到它们的内容。在工作空间里跑一次
            <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
              python3 scripts/ingest.py
            </code>
            即可。
          </p>
          <div className="overflow-hidden rounded-lg border border-border">
            {input.pending.map((item) => (
              <Row key={item.path} onClick={() => onOpen(item)} active={openPath === item.path}>
                <KindIcon item={item} />
                <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(item.size)}</span>
                <span
                  role="button"
                  tabIndex={-1}
                  title="在访达中显示"
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
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <SectionTitle count={input.converted.length}>转换产物</SectionTitle>
        {input.converted.length ? (
          <div className="overflow-hidden rounded-lg border border-border">
            {input.converted.map((item: ConvertedItem) => (
              <Row key={item.path} onClick={() => onOpen(item)} active={openPath === item.path}>
                <KindIcon item={item} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm">{item.title || item.name}</span>
                  </div>
                  <span className="truncate text-xs text-muted-foreground">
                    {item.source || item.name}
                    {item.convertedBy ? ` · ${item.convertedBy}` : ''}
                    {item.reader === 'html' ? ' · HTML 原型' : ''}
                    {item.sheets?.length ? ` · ${item.sheets.length} 张表` : ''}
                    {item.extractedImages ? ` · ${item.extractedImages} 张图` : ''}
                  </span>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{formatWords(item.words)}</span>
              </Row>
            ))}
          </div>
        ) : (
          <EmptyState
            title="还没有转换产物"
            hint="把资料放进 input/raw/，然后在工作空间里跑 scripts/ingest.py"
          />
        )}
      </section>

      {input.assets.length ? (
        <section className="flex flex-col gap-2">
          <SectionTitle count={input.assets.length}>文档里抽出的图片</SectionTitle>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {input.assets.map((item) => (
              <button
                key={item.path}
                type="button"
                onClick={() => onOpen(item)}
                className="group overflow-hidden rounded-lg border border-border bg-muted/40 transition-colors hover:border-foreground/30"
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
