import type { ReactNode } from 'react';
import { ExternalLink, MonitorPlay } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/**
 * 「视觉呈现」两个 tab 共用的一张卡片：16:10 预览区 + 标题 + 一行来源。
 *
 * 有封面就铺满预览区，没有就落回浏览器窗框占位 —— **不得出现破图**：
 * 图加载失败时把封面撤掉，退回占位。
 */
export function ShowcaseCard({
  title,
  subtitle,
  cover,
  href,
  badge,
  disabledHint,
}: {
  title: string;
  subtitle?: string;
  /** 封面图地址；空 = 走窗框占位 */
  cover?: string;
  /** 新窗口打开的地址；空 = 卡片不可点击 */
  href?: string;
  badge?: ReactNode;
  /** 不可点击时说明原因（如「地址不合法」），显示在来源那一行下面 */
  disabledHint?: string;
}) {
  const body = (
    <>
      <div className="relative flex aspect-[16/10] items-center justify-center overflow-hidden rounded-md border border-border bg-muted/50">
        {cover ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            className="absolute inset-0 size-full object-cover object-top"
            onError={(e) => {
              // 封面读不到就藏掉这张 img，露出下面的窗框占位
              e.currentTarget.style.display = 'none';
            }}
          />
        ) : null}
        {/* 占位：淡格纹 + 显示器图标 + 标题首行。封面盖在它上面 */}
        <div
          className="absolute inset-0 opacity-[0.06]"
          style={{
            backgroundImage:
              'linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
        />
        {cover ? null : (
          <div className="relative flex flex-col items-center gap-2 text-muted-foreground">
            <MonitorPlay className="size-8" />
            <span className="max-w-[90%] truncate px-2 text-center text-xs font-medium text-foreground/80">
              {title}
            </span>
          </div>
        )}
      </div>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{title}</div>
          {subtitle ? (
            <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{subtitle}</div>
          ) : null}
          {disabledHint ? (
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{disabledHint}</div>
          ) : null}
        </div>
        {badge ? (
          <Badge variant="muted" className="shrink-0 font-mono text-[10px]">
            {badge}
          </Badge>
        ) : null}
        {href ? <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /> : null}
      </div>
    </>
  );

  if (!href) {
    return (
      <div className="flex cursor-not-allowed flex-col gap-3 rounded-lg border border-border bg-card p-3 opacity-60">
        {body}
      </div>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:border-foreground/30 hover:bg-accent"
    >
      {body}
    </a>
  );
}

/** 两个 tab 的卡片网格用同一套断点 */
export function ShowcaseGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div>;
}
