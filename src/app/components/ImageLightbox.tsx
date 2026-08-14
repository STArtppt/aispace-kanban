import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus, RotateCcw, X } from 'lucide-react';

import {
  Lightbox,
  LightboxBackdrop,
  LightboxPopup,
  LightboxPortal,
  LightboxTitle,
  LightboxToolbar,
} from '@/components/ui/lightbox';

/**
 * 图片全屏查看：壳层是真源 @startist/lightbox，缩放/平移/翻页是消费端组合。
 * 不改 components/ui/lightbox.tsx（vendored 快照）。
 */
export interface ImageLightboxItem {
  src: string;
  alt?: string;
}

export function ImageLightbox({
  items,
  initialIndex,
  onClose,
}: {
  items: ImageLightboxItem[];
  initialIndex: number;
  onClose: () => void;
}) {
  const wheelCleanupRef = useRef<(() => void) | null>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const draggedRef = useRef(false);
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(0, initialIndex), Math.max(0, items.length - 1)),
  );
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const total = items.length;
  const multi = total >= 2;
  const current = items[index] ?? items[0];
  const canPrev = multi && index > 0;
  const canNext = multi && index < total - 1;

  const resetView = useCallback(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const goPrev = useCallback(() => {
    setIndex((i) => (i <= 0 ? i : i - 1));
  }, []);

  const goNext = useCallback(() => {
    setIndex((i) => (i >= total - 1 ? i : i + 1));
  }, [total]);

  useEffect(() => {
    resetView();
  }, [index, resetView]);

  // Escape 交给 lightbox。方向键必须 capture：Base UI Popup 会在冒泡阶段拦掉 ArrowLeft/Right。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        goPrev();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        goNext();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [goPrev, goNext]);

  const zoomBy = useCallback((factor: number) => {
    setScale((currentScale) =>
      Math.min(4, Math.max(0.25, Number((currentScale * factor).toFixed(3)))),
    );
  }, []);

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

  const handleBackdropClick = (event: ReactMouseEvent) => {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    if (event.target === event.currentTarget) onClose();
  };

  if (!current) return null;

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
          <LightboxTitle className="sr-only">
            {current.alt || (multi ? `${index + 1} / ${total}` : '查看图片')}
          </LightboxTitle>
          <LightboxToolbar onClick={(event) => event.stopPropagation()}>
            {multi ? (
              <span className="min-w-[3.25rem] px-1 text-center text-xs tabular-nums text-zinc-300">
                {index + 1} / {total}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => zoomBy(1 / 1.2)}
              className="rounded p-2 hover:bg-white/10"
              aria-label="缩小"
            >
              <Minus className="size-4" />
            </button>
            <span className="w-14 text-center text-xs tabular-nums">{Math.round(scale * 100)}%</span>
            <button
              type="button"
              onClick={() => zoomBy(1.2)}
              className="rounded p-2 hover:bg-white/10"
              aria-label="放大"
            >
              <Plus className="size-4" />
            </button>
            <button
              type="button"
              onClick={resetView}
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

          {multi ? (
            <>
              <button
                type="button"
                disabled={!canPrev}
                onClick={(event) => {
                  event.stopPropagation();
                  goPrev();
                }}
                className="absolute top-1/2 left-4 z-10 -translate-y-1/2 rounded-lg border border-white/10 bg-zinc-900/90 p-2 text-zinc-100 shadow-2xl transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
                aria-label="上一张"
              >
                <ChevronLeft className="size-5" />
              </button>
              <button
                type="button"
                disabled={!canNext}
                onClick={(event) => {
                  event.stopPropagation();
                  goNext();
                }}
                className="absolute top-1/2 right-4 z-10 -translate-y-1/2 rounded-lg border border-white/10 bg-zinc-900/90 p-2 text-zinc-100 shadow-2xl transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
                aria-label="下一张"
              >
                <ChevronRight className="size-5" />
              </button>
            </>
          ) : null}

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
              <img
                src={current.src}
                alt={current.alt ?? ''}
                draggable={false}
                className="max-h-[88vh] max-w-[88vw] select-none rounded-md"
              />
            </div>
          </div>
        </LightboxPopup>
      </LightboxPortal>
    </Lightbox>
  );
}
