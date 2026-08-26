import { useEffect, useRef, useState } from 'react';
import { ArrowLeftToLine, ArrowRightFromLine, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DocumentToc, Markdown, type TocItem } from '@/components/Markdown';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * 看板帮助文档，占预览位。
 *
 * 和 Reader 分开而不是塞进去：Reader 的每一件外设（收藏、在访达中显示、重新转换、
 * 溯源栏）都要一个工作空间和一个 FileItem，帮助文档两样都没有。共用的是版式与目录，
 * 那两样已经在 Markdown.tsx 里了。
 */
export function HelpPanel({
  onClose,
  expanded,
  onToggleExpand,
}: {
  onClose: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [toc, setToc] = useState<TocItem[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .help()
      .then((doc) => {
        if (!alive) return;
        // ok=false：服务找得到接口但读不到 help.md（模板目录缺失 / 被裁掉）
        if (doc.text) setText(doc.text);
        else setError('这个版本没有随包带上帮助文档。看仓库 README，或升级看板后再试。');
      })
      .catch((err: unknown) => {
        if (!alive) return;
        // 老服务没有 /api/help，会 404；说人话，别把状态码甩给用户
        setError(err instanceof Error ? err.message : '读取帮助文档失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <aside
      className={cn(
        'flex h-full min-h-0 min-w-0 flex-col bg-background max-[899px]:border-l-0',
        expanded ? 'border-l-0' : 'border-l border-border',
        'transition-[border-color] duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
      )}
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-3 sm:px-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-sm font-medium">使用帮助</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            从建空间到收产出
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onToggleExpand ? (
            <Button
              variant="ghost"
              size="icon"
              // 窄屏本就是全屏浮层，展开无意义
              className="hidden min-[900px]:inline-flex"
              title={expanded ? '向右收起' : '向左展开'}
              aria-label={expanded ? '向右收起' : '向左展开'}
              aria-pressed={expanded}
              onClick={onToggleExpand}
            >
              {expanded ? (
                <ArrowRightFromLine className="size-4" />
              ) : (
                <ArrowLeftToLine className="size-4" />
              )}
            </Button>
          ) : null}
          <Button variant="ghost" size="icon" title="关闭" aria-label="关闭" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </header>

      {/* 目录 absolute 贴右缘，和 Reader 的 markdown 面同构，展开收起时不左右摇摆 */}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          data-reader-scroll
          className={cn(
            'h-full min-h-0 min-w-0 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-5',
            'min-[900px]:pr-[calc(200px+0.75rem)] xl:pr-[calc(220px+0.75rem)]',
          )}
        >
          {loading ? <p className="text-sm text-muted-foreground">读取中…</p> : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {text && !error ? (
            <div className="mx-auto w-full max-w-[76ch]">
              <Markdown onHeadingsChange={setToc}>{text}</Markdown>
            </div>
          ) : null}
        </div>

        <div
          className={cn(
            'absolute inset-y-0 right-0 hidden w-[200px] flex-col bg-background px-3 py-4 xl:w-[220px]',
            'min-[900px]:flex',
          )}
        >
          <DocumentToc items={toc} scrollContainerRef={scrollRef} />
        </div>
      </div>
    </aside>
  );
}
