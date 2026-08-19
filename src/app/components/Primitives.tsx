import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight, Copy, Loader2, MoreHorizontal, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  indent,
  onClick,
  children,
  className,
}: {
  active?: boolean;
  /** 树形视图里的层级：每层往右缩 1.125rem，行本身仍然是整行宽（悬停底色不断） */
  indent?: number;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={indent ? { paddingLeft: `calc(0.75rem + ${indent} * 1.125rem)` } : undefined}
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
 * 列表行上的小图标动作。行本身是 <button>，不能再套 button，触发器用 span。
 * Tooltip 与复制按钮同一套（delay 300 + TooltipContent），别再用原生 title。
 */
export function RowIconButton({
  label,
  disabled,
  className,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <TooltipProvider delay={300}>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="button"
              tabIndex={-1}
              aria-label={label}
              aria-disabled={disabled || undefined}
              className={cn(
                'shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground',
                disabled && 'cursor-not-allowed text-muted-foreground/60 hover:bg-transparent hover:text-muted-foreground/60',
                className,
              )}
              onClick={(event: MouseEvent) => {
                event.stopPropagation();
                if (disabled) return;
                onClick();
              }}
            />
          }
        >
          {children}
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * 复制文本的小图标按钮。
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
    <RowIconButton
      label="复制路径"
      className={className}
      onClick={() => {
        void writeClipboard(value).then((ok) => {
          if (ok) setCopied(true);
        });
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </RowIconButton>
  );
}

/** 行尾「更多」菜单里的一条动作。 */
export interface RowAction {
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  onSelect: () => void;
}

/**
 * 行尾的动作收纳。
 * 一行能做的事只会越来越多（复制、转换、定位、以后还有别的），全摊成图标会把行挤没；
 * 所以一律收进「更多」，行上只留一个入口。
 * busy 时触发器换成转圈 —— 菜单是关着的，正在跑的任务必须在行上看得见。
 * 行本身是 <button>，里面不能再套 button：触发器同 RowIconButton 用 span，并挡住冒泡，
 * 否则点「更多」会顺带把这一行打开。
 */
export function RowActions({
  actions,
  busy,
  label = '更多',
}: {
  actions: RowAction[];
  busy?: boolean;
  label?: string;
}) {
  if (!actions.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <span
            role="button"
            tabIndex={-1}
            aria-label={label}
            title={label}
            className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
            onClick={(event: MouseEvent) => event.stopPropagation()}
          />
        }
      >
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <MoreHorizontal className="size-3.5" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {actions.map(({ label: itemLabel, icon: Icon, disabled, onSelect }) => (
          <DropdownMenuItem
            key={itemLabel}
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
            }}
          >
            <Icon />
            {itemLabel}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
