import { ExternalLink, MonitorPlay } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EmptyState, SectionTitle } from '@/components/Primitives';
import type { Prototypes } from '@/lib/api';
import { formatRelative } from '@/lib/format';

export function PrototypePanel({ prototypes }: { prototypes: Prototypes }) {
  const { items, origin, clientReady, note, updatedAt } = prototypes;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle count={items.length}>原型</SectionTitle>
        {origin ? (
          <Badge variant="muted" className="font-mono">
            {origin}
          </Badge>
        ) : null}
        {updatedAt ? (
          <span className="text-xs text-muted-foreground">原型树更新于 {formatRelative(updatedAt)}</span>
        ) : null}
      </div>

      {note ? (
        <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
          {note}
          {!clientReady ? (
            <>
              <br />
              在 Axhub Make 里新建项目、把目录指向工作空间的
              <code className="mx-1 rounded bg-background px-1 py-0.5 font-mono">prototypes/</code>
              即可，它会自己构建客户端。
            </>
          ) : null}
        </div>
      ) : null}

      {items.length ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => {
            const disabled = !item.url;
            const Card = (
              <>
                <div className="flex items-center gap-2">
                  <MonitorPlay className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                  {disabled ? null : <ExternalLink className="size-3.5 text-muted-foreground" />}
                </div>
                <span className="truncate font-mono text-[11px] text-muted-foreground">{item.itemKey}</span>
              </>
            );
            return disabled ? (
              <div
                key={item.itemKey}
                className="flex cursor-not-allowed flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3 opacity-60"
              >
                {Card}
              </div>
            ) : (
              <a
                key={item.itemKey}
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="flex flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-foreground/30 hover:bg-accent"
              >
                {Card}
              </a>
            );
          })}
        </div>
      ) : clientReady ? (
        <EmptyState title="还没有原型页面" hint="在 Axhub Make 里生成的页面会自动出现在这里" />
      ) : null}
    </div>
  );
}
