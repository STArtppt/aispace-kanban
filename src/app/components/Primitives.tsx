import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** 统计数字块。层级靠边框和灰底，不靠阴影，不上彩色。 */
export function Stat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'default' | 'attention';
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          'font-display text-2xl leading-none',
          tone === 'attention' && 'text-destructive',
        )}
      >
        {value}
      </span>
      {hint ? <span className="truncate text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

export function SectionTitle({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <h2 className="flex items-baseline gap-2 text-sm font-medium">
      {children}
      {typeof count === 'number' ? (
        <span className="text-xs font-normal text-muted-foreground">{count}</span>
      ) : null}
    </h2>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
      <p className="text-sm text-muted-foreground">{title}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground/80">{hint}</p> : null}
    </div>
  );
}

export function Row({
  active,
  onClick,
  children,
  className,
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-accent',
        active && 'bg-muted',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** 复制到剪贴板；灯箱工具条这类深色壳层不能用 CopyButton，就直接用它自己拼按钮。 */
export async function writeClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 落到下面的兜底
    }
  }
  // 从别的机器用 http 访问看板时没有 clipboard API，退回 execCommand
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(area);
  return ok;
}

/**
 * 复制文本的小图标按钮。
 * 列表行本身是 <button>，按钮不能嵌套，所以触发器渲染成 span + role="button"。
 * 提示文案固定「复制路径」，复制成功只用图标反馈（✓），不改文案。
 */
export function CopyButton({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <TooltipProvider delay={300}>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="button"
              tabIndex={-1}
              aria-label="复制路径"
              className={cn(
                'shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground',
                className,
              )}
              onClick={(event: MouseEvent) => {
                event.stopPropagation();
                void writeClipboard(value).then((ok) => {
                  if (ok) setCopied(true);
                });
              }}
            />
          }
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </TooltipTrigger>
        <TooltipContent>复制路径</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** 列表底部分页条：不足一页时不渲染。 */
export function ListPager({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  if (total <= pageSize) return null;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border bg-muted/30 px-3 py-2">
      <span className="text-xs text-muted-foreground">
        第 {from}–{to} 项，共 {total} 项
      </span>
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
    </div>
  );
}
