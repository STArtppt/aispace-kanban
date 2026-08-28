import { useState, type FormEvent, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CaptureControl } from '@/hooks/useCaptureJob';
import type { CapturePlane } from '@/lib/api';

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
 * 参考 tab 与原型 tab 顶部的 URL 输入条。两边形状一致，文案与目标平面不同。
 *
 * 三态都在这一条里说清：
 *   - 进行中：按钮禁用 + 转圈 + 服务端那句「正在采…」
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
}: {
  plane: CapturePlane;
  control: CaptureControl;
  placeholder: string;
  /** 按钮文字：参考是「采集」，原型是「导入」 */
  actionLabel: string;
  /** 入口旁的适用范围说明，两个 tab 各写各的 */
  scopeNote: ReactNode;
}) {
  const [url, setUrl] = useState('');
  const [localError, setLocalError] = useState('');
  const { job, running, error, unsupported, start } = control;

  // 另一个 tab 正在采时这边也该禁用 —— 服务端一个工作空间只允许一轮
  const otherRunning = running && job?.status === 'running' && job.plane !== plane;
  const disabled = unsupported || running;

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

  // 本轮任务是不是这个 tab 发起的：另一个 tab 的进度不该占着这里的位置
  const mine = job?.plane === plane;

  return (
    <div className="flex flex-col gap-2">
      <form className="flex flex-wrap items-center gap-2" onSubmit={submit}>
        <Input
          className="min-w-0 flex-1 basis-64"
          value={url}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => {
            setUrl(e.target.value);
            if (localError) setLocalError('');
          }}
        />
        <Button type="submit" disabled={disabled || !url.trim()}>
          {running && mine ? <Loader2 className="animate-spin" /> : null}
          {running && mine ? '进行中' : actionLabel}
        </Button>
      </form>

      <p className="text-xs text-muted-foreground">{scopeNote}</p>

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
