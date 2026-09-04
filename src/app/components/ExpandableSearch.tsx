import { useState } from 'react';
import { Search, X } from 'lucide-react';
import { HeaderTooltip } from '@/components/Primitives';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * 标题栏上的可展开搜索框。收起是一颗搜索图标，点开后变宽。
 * 有输入时右侧换成清空按钮；mousedown 拦住失焦，点完还能接着改关键词。
 */
export function ExpandableSearch({
  value,
  onChange,
  expandedClassName,
  placeholder = '按名称搜索…',
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  expandedClassName: string;
  placeholder?: string;
  'aria-label': string;
}) {
  const [open, setOpen] = useState(false);
  const hasValue = value.length > 0;
  const expanded = open || value.trim().length > 0;

  return (
    <HeaderTooltip label="搜索" disabled={expanded}>
      <div
        className={cn(
          'relative h-8 transition-[width] duration-200 ease-out',
          expanded ? expandedClassName : 'w-8',
        )}
      >
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          placeholder={expanded ? placeholder : ''}
          className={cn('h-8 text-xs', expanded ? 'pr-8 pl-2.5' : 'px-0 caret-transparent')}
          aria-label={ariaLabel}
        />
        {hasValue ? (
          <HeaderTooltip label="清空">
            <button
              type="button"
              className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground hover:text-foreground"
              aria-label="清空搜索"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onChange('')}
            >
              <X className="size-3.5" />
            </button>
          </HeaderTooltip>
        ) : (
          <span className="pointer-events-none absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground">
            <Search className="size-3.5" />
          </span>
        )}
      </div>
    </HeaderTooltip>
  );
}
