import { useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Info, Link2, Loader2 } from 'lucide-react';
import { HeaderTooltip } from '@/components/Primitives';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { CaptureControl } from '@/hooks/useCaptureJob';
import type { CapturePlane } from '@/lib/api';
import { cn } from '@/lib/utils';

/** 前端先判一次，非法地址就地提示、不发请求（服务端还会再判一次，那是不信客户端的那道）。 */
function isHttpUrl(text: string): boolean {
  try {
    const u = new URL(text.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 参考 tab 与原型 tab 顶部的一排：左边是状态文字，右边是 URL 输入。两边形状一致，文案与目标平面不同。
 *
 * 输入框照抄标题栏的可展开搜索框（ExpandableSearch）：收起是一颗图标，点开向左展开；
 * 适用范围说明收进旁边的 ⓘ，悬停才出，不再常驻占一行。
 *
 * 三态都在这一条下面说清：
 *   - 进行中：输入框保持展开 + 转圈 + 服务端那句「正在采…」
 *   - 成功：中性底色说明收进了哪个目录；**降级也走这一档**（卡片已经出现了，
 *     只是少了图），另给一行说明少了什么、装什么补上
 *   - 失败：destructive（orange）+ 服务端返回的原因**原样显示**
 *
 * orange 只给真正的失败 —— 降级不是失败，用它就是在骗用户。
 */
export function CaptureBar({
  plane,
  control,
  placeholder,
  actionLabel,
  scopeNote,
  status,
}: {
  plane: CapturePlane;
  control: CaptureControl;
  placeholder: string;
  /** 按钮文字：参考是「采集」，原型是「导入」 */
  actionLabel: string;
  /** 入口旁 ⓘ 里的适用范围说明，两个 tab 各写各的 */
  scopeNote: ReactNode;
  /** 同一排左侧的状态文字（最近更新等） */
  status?: ReactNode;
}) {
  const [url, setUrl] = useState('');
  const [open, setOpen] = useState(false);
  const [localError, setLocalError] = useState('');
  const { job, running, error, unsupported, start } = control;

  // 另一个 tab 正在采时这边也该禁用 —— 服务端一个工作空间只允许一轮
  const otherRunning = running && job?.status === 'running' && job.plane !== plane;
  const disabled = unsupported || running;

  // 本轮任务是不是这个 tab 发起的：另一个 tab 的进度不该占着这里的位置
  const mine = job?.plane === plane;
  const busy = running && mine;
  const expanded = open || url.trim().length > 0 || busy;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = url.trim();
    if (!isHttpUrl(text)) {
      setLocalError('请贴一条 http:// 或 https:// 开头的网址');
      return;
    }
    setLocalError('');
    void start(plane, text);
    setUrl('');
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-8 min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{status}</div>

        <TooltipProvider delay={300}>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="适用范围说明"
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                />
              }
            >
              <Info className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-sm text-left leading-relaxed">
              {scopeNote}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <form onSubmit={submit} className="shrink-0">
          <HeaderTooltip label={`贴链接${actionLabel}`} disabled={expanded}>
            <div
              className={cn(
                'relative h-8 transition-[width] duration-200 ease-out',
                expanded ? 'w-[14rem] sm:w-[22rem]' : 'w-8',
              )}
            >
              <Input
                value={url}
                disabled={disabled}
                placeholder={expanded ? placeholder : ''}
                aria-label={`贴链接${actionLabel}`}
                className={cn('h-8 text-xs', expanded ? 'pr-8 pl-2.5' : 'px-0 caret-transparent')}
                onFocus={() => setOpen(true)}
                onBlur={() => setOpen(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') e.currentTarget.blur();
                }}
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (localError) setLocalError('');
                }}
              />
              {busy ? (
                <span className="pointer-events-none absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                </span>
              ) : url.trim() ? (
                <HeaderTooltip label={actionLabel}>
                  <button
                    type="submit"
                    disabled={disabled}
                    aria-label={actionLabel}
                    className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground hover:text-foreground"
                    // 拦住失焦，否则点按钮前输入框先收起
                    onMouseDown={(event) => event.preventDefault()}
                  >
                    <ArrowRight className="size-3.5" />
                  </button>
                </HeaderTooltip>
              ) : (
                <span className="pointer-events-none absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground">
                  <Link2 className="size-3.5" />
                </span>
              )}
            </div>
          </HeaderTooltip>
        </form>
      </div>

      {unsupported ? (
        <Alert>
          <AlertDescription>
            当前看板服务还没有采集能力 —— 重启看板服务（<code className="font-mono">pnpm serve</code>
            {' / '}
            <code className="font-mono">pnpm dev</code>）后这个入口就能用。下面的清单不受影响。
          </AlertDescription>
        </Alert>
      ) : null}

      {localError ? (
        <Alert variant="destructive">
          <AlertDescription>{localError}</AlertDescription>
        </Alert>
      ) : null}

      {otherRunning ? (
        <Alert>
          <AlertDescription>
            另一边正在采集（{job?.target}），一个工作空间同时只跑一轮，等它结束再试。
          </AlertDescription>
        </Alert>
      ) : null}

      {/* 服务端返回的失败原因原样显示，不写「操作失败请重试」这类空话 */}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription className="whitespace-pre-line">{error}</AlertDescription>
        </Alert>
      ) : null}

      {mine && job?.status === 'running' ? (
        <Alert>
          <AlertDescription>{job.message}</AlertDescription>
        </Alert>
      ) : null}

      {/* 成功：降级也是成功。中性底色 + 一行「少了什么、装什么补上」，不上 orange */}
      {mine && job?.status === 'done' ? (
        <Alert>
          <AlertDescription className="whitespace-pre-line">
            {job.message}
            {job.degradedHint ? `\n${job.degradedHint}` : ''}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
