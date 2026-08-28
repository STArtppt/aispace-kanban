import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  AlertTriangle,
  Check,
  Code2,
  Copy,
  Eye,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Lightbox,
  LightboxBackdrop,
  LightboxPopup,
  LightboxPortal,
  LightboxTitle,
  LightboxToolbar,
} from '@/components/ui/lightbox';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { renderMermaid, type MermaidTheme } from '@/lib/mermaid';
import { pickSourceAttrs } from '@/lib/sourceAnchor';
import { cn } from '@/lib/utils';

type RenderStatus =
  | { kind: 'idle' | 'loading' }
  | { kind: 'ready'; svg: string; bindFunctions?: (el: Element) => void }
  | { kind: 'error'; message: string };

/** 跟随 documentElement 的 .dark，与 App 主题开关同步。 */
function useIsDark() {
  const [dark, setDark] = useState(() =>
    typeof document !== 'undefined' ? document.documentElement.classList.contains('dark') : false,
  );
  useEffect(() => {
    const el = document.documentElement;
    const sync = () => setDark(el.classList.contains('dark'));
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

function toMermaidTheme(dark: boolean): MermaidTheme {
  return dark ? 'dark' : 'default';
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message.split('\n')[0];
  return String(error || '未知错误');
}

function sanitizeId(id: string) {
  return id.replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * Markdown ```mermaid 围栏 → 图示预览。
 * 行为对齐 pentou MermaidBlock：预览/源码切换、复制、全屏缩放拖拽。
 * 表面用语义令牌，不照搬 pentou 的 zinc 硬编码。
 */
export function MermaidBlock({
  source,
  className,
  ...props
}: {
  source: string;
  className?: string;
} & Record<string, unknown>) {
  const dark = useIsDark();
  const reactId = sanitizeId(useId());
  const renderRef = useRef(0);
  const svgRef = useRef<HTMLDivElement>(null);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const [status, setStatus] = useState<RenderStatus>({ kind: 'idle' });
  const [view, setView] = useState<'preview' | 'source'>('preview');
  const [copied, setCopied] = useState(false);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);

  const text = source.replace(/\n$/, '');
  const mermaidTheme = toMermaidTheme(dark);

  useEffect(() => {
    if (!text.trim()) {
      setStatus({ kind: 'error', message: '空 mermaid 源' });
      setView('source');
      return;
    }

    const renderVersion = renderRef.current + 1;
    renderRef.current = renderVersion;
    setStatus({ kind: 'loading' });

    renderMermaid(`mermaid-${reactId}-${renderVersion}`, text, mermaidTheme)
      .then((result) => {
        if (renderRef.current !== renderVersion) return;
        setStatus({ kind: 'ready', svg: result.svg, bindFunctions: result.bindFunctions });
        setView((current) => (current === 'source' ? current : 'preview'));
      })
      .catch((error) => {
        if (renderRef.current !== renderVersion) return;
        const msg = getErrorMessage(error);
        const isLoadError = /failed to load|fetch dynamically imported module|import/i.test(msg);
        setStatus({
          kind: 'error',
          message: isLoadError ? 'mermaid 模块加载失败，已退回源码显示' : `mermaid 渲染失败：${msg}`,
        });
        setView('source');
      });
  }, [mermaidTheme, reactId, text]);

  useEffect(() => {
    if (status.kind !== 'ready' || !svgRef.current) return;
    status.bindFunctions?.(svgRef.current);
  }, [status]);

  const handleCopy = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const el = document.createElement('textarea');
        el.value = text;
        el.style.cssText = 'position:fixed;top:-9999px;left:-9999px';
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 复制失败时静默，源码仍可选手动选
    }
  }, [text]);

  const showSource = view === 'source' || status.kind === 'error';

  const a2 = pickSourceAttrs(props);

  return (
    <div
      className={cn('relative my-4 overflow-hidden rounded-lg border border-border bg-card', className)}
      {...a2}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/60 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          mermaid
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setView(showSource ? 'preview' : 'source')}
            disabled={status.kind !== 'ready' && !showSource}
            className="h-auto gap-1 px-2 py-1 text-xs text-muted-foreground"
            title={showSource ? '显示图示' : '显示源码'}
          >
            {showSource ? <Eye className="size-3" /> : <Code2 className="size-3" />}
            {showSource ? '预览' : '源码'}
          </Button>
          {showSource ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              className="h-auto gap-1 px-2 py-1 text-xs text-muted-foreground"
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied ? '已复制' : '复制'}
            </Button>
          ) : (
            <TooltipProvider delay={300}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      ref={fullscreenButtonRef}
                      type="button"
                      onClick={() => setFullscreenOpen(true)}
                      disabled={status.kind !== 'ready'}
                      className={cn(
                        'rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                        'disabled:cursor-not-allowed disabled:opacity-40',
                      )}
                      aria-label="全屏查看"
                    />
                  }
                >
                  <Maximize2 className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent showArrow={false}>全屏查看</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>

      {status.kind === 'loading' ? (
        <div className="flex min-h-40 items-center justify-center gap-2 bg-muted/40 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          正在渲染图示...
        </div>
      ) : null}

      {status.kind === 'error' ? (
        <div className="border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          <span className="inline-flex items-center gap-1.5">
            <AlertTriangle className="size-3.5" />
            {status.message}
          </span>
        </div>
      ) : null}

      {showSource ? (
        <pre className="max-h-[520px] overflow-auto bg-muted/40 p-4 font-mono text-sm text-foreground">
          <code className="language-mermaid">{text}</code>
        </pre>
      ) : status.kind === 'ready' ? (
        <button
          type="button"
          onClick={() => setFullscreenOpen(true)}
          className="block w-full cursor-zoom-in bg-background p-4 text-left"
          title="全屏查看"
        >
          <div
            ref={svgRef}
            className="mermaid-svg mx-auto flex max-w-full justify-center overflow-x-auto text-foreground"
            dangerouslySetInnerHTML={{ __html: status.svg }}
          />
        </button>
      ) : null}

      {fullscreenOpen && status.kind === 'ready' ? (
        <MermaidFullscreenModal
          svg={status.svg}
          bindFunctions={status.bindFunctions}
          dark={dark}
          onClose={() => {
            setFullscreenOpen(false);
            fullscreenButtonRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

function MermaidFullscreenModal({
  svg,
  bindFunctions,
  dark,
  onClose,
}: {
  svg: string;
  bindFunctions?: (el: Element) => void;
  dark: boolean;
  onClose: () => void;
}) {
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const draggedRef = useRef(false);
  const wheelCleanupRef = useRef<(() => void) | null>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const zoomBy = useCallback((factor: number) => {
    setScale((current) => Math.min(4, Math.max(0.25, Number((current * factor).toFixed(3)))));
  }, []);

  const bindContent = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) bindFunctions?.(node);
    },
    [bindFunctions],
  );

  const attachWheel = useCallback(
    (node: HTMLDivElement | null) => {
      wheelCleanupRef.current?.();
      wheelCleanupRef.current = null;
      if (!node) return;
      const handleWheel = (event: WheelEvent) => {
        event.preventDefault();
        zoomBy(event.deltaY > 0 ? 1 / 1.2 : 1.2);
      };
      node.addEventListener('wheel', handleWheel, { passive: false });
      wheelCleanupRef.current = () => node.removeEventListener('wheel', handleWheel);
    },
    [zoomBy],
  );

  // lightbox 遮罩恒暗；default 主题 lineColor 叠上去会丢边，给图一块与内联预览一致的底板
  const surfaceClass = dark ? 'bg-card' : 'bg-background';

  const handleBackdropClick = (event: ReactMouseEvent) => {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <Lightbox
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <LightboxPortal>
        <LightboxBackdrop />
        <LightboxPopup
          onMouseMove={(event) => {
            if (!dragRef.current) return;
            const dx = event.clientX - dragRef.current.x;
            const dy = event.clientY - dragRef.current.y;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) draggedRef.current = true;
            setPan({
              x: dragRef.current.panX + dx,
              y: dragRef.current.panY + dy,
            });
          }}
          onMouseUp={() => {
            dragRef.current = null;
          }}
          onMouseLeave={() => {
            dragRef.current = null;
          }}
          onClick={handleBackdropClick}
        >
          <LightboxTitle className="sr-only">全屏查看图示</LightboxTitle>
          <LightboxToolbar onClick={(event) => event.stopPropagation()}>
            <button type="button" onClick={() => zoomBy(1 / 1.2)} className="rounded p-2 hover:bg-white/10" aria-label="缩小">
              <Minus className="size-4" />
            </button>
            <span className="w-14 text-center text-xs tabular-nums">{Math.round(scale * 100)}%</span>
            <button type="button" onClick={() => zoomBy(1.2)} className="rounded p-2 hover:bg-white/10" aria-label="放大">
              <Plus className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                setScale(1);
                setPan({ x: 0, y: 0 });
              }}
              className="rounded p-2 hover:bg-white/10"
              aria-label="重置"
            >
              <RotateCcw className="size-4" />
            </button>
            <button
              type="button"
              onMouseDown={(event) => {
                event.stopPropagation();
                onClose();
              }}
              onClick={(event) => event.stopPropagation()}
              className="rounded p-2 hover:bg-white/10"
              aria-label="关闭"
            >
              <X className="size-4" />
            </button>
          </LightboxToolbar>

          <div
            ref={attachWheel}
            className="flex h-full w-full items-center justify-center overflow-hidden"
            onClick={handleBackdropClick}
          >
            <div
              className="cursor-grab active:cursor-grabbing"
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
              onClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                draggedRef.current = false;
                dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
              }}
            >
              <div
                ref={bindContent}
                className={cn(
                  'rounded-xl p-6 [&_svg]:max-h-[88vh] [&_svg]:max-w-[88vw]',
                  surfaceClass,
                )}
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>
          </div>
        </LightboxPopup>
      </LightboxPortal>
    </Lightbox>
  );
}
