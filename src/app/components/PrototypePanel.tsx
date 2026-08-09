import { ExternalLink, MonitorPlay } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EmptyState, SectionTitle } from '@/components/Primitives';
import type { PrototypeItem, Prototypes } from '@/lib/api';
import { formatRelative } from '@/lib/format';

function kindLabel(kind?: PrototypeItem['kind']) {
  if (kind === 'zip') return 'zip';
  if (kind === 'folder') return '文件夹';
  return '';
}

export function PrototypePanel({ prototypes }: { prototypes: Prototypes }) {
  const { items, note, updatedAt } = prototypes;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle count={items.length}>原型</SectionTitle>
        {updatedAt ? (
          <span className="text-xs text-muted-foreground">最近更新 {formatRelative(updatedAt)}</span>
        ) : null}
      </div>

      {note ? (
        <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
          {note}
        </div>
      ) : null}

      {items.length ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => {
            const disabled = !item.url;
            const kind = kindLabel(item.kind);
            const CardBody = (
              <>
                {/* 缩略图区：静态导出包没有现成封面图，用统一视觉占位 + 标题首字 */}
                <div className="relative flex aspect-[16/10] items-center justify-center overflow-hidden rounded-md border border-border bg-muted/50">
                  <div className="absolute inset-0 opacity-[0.06]"
                    style={{
                      backgroundImage:
                        'linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)',
                      backgroundSize: '24px 24px',
                    }}
                  />
                  <div className="relative flex flex-col items-center gap-2 text-muted-foreground">
                    <MonitorPlay className="size-8" />
                    <span className="max-w-[90%] truncate px-2 text-center text-xs font-medium text-foreground/80">
                      {item.title}
                    </span>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{item.title}</div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                      {item.sourcePath || item.itemKey}
                    </div>
                  </div>
                  {kind ? (
                    <Badge variant="muted" className="shrink-0 font-mono text-[10px]">
                      {kind}
                    </Badge>
                  ) : null}
                  {disabled ? null : <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
                </div>
              </>
            );

            if (disabled) {
              return (
                <div
                  key={item.itemKey}
                  className="flex cursor-not-allowed flex-col gap-3 rounded-lg border border-border bg-card p-3 opacity-60"
                >
                  {CardBody}
                </div>
              );
            }

            return (
              <a
                key={item.itemKey}
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:border-foreground/30 hover:bg-accent"
              >
                {CardBody}
              </a>
            );
          })}
        </div>
      ) : (
        <EmptyState
          title="还没有原型页面"
          hint="把 axhub-make 导出的 HTML 包（zip 或解压后的文件夹，根目录含 index.html）放进 prototypes/ 即可"
        />
      )}
    </div>
  );
}
