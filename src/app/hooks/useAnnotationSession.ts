import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 批注会话：胶囊工具栏开着的这一段时间。
 *
 * 关键约束（与相邻仓 annotation-collect 的采集款一致）：**没激活就没有批注交互**。
 * 划选文字不再自己冒出「批注」按钮 —— 阅读器首先是拿来读的，
 * 只有人点了标题栏那个「批注」，才进入"选中即批注"的状态。
 *
 * 这里只管会话状态，DOM 相关的（描边、标记点、锚点）都在 AnnotationLayer 里，
 * 两边靠 `request` 这一个字段通信：清单里点「定位 / 改」，层收到后滚过去、开框。
 */

export type AnnotateMode = 'pick-element' | 'select-text';

/** 清单 → 正文的一次点名。`nonce` 让"连点两次同一条"也能触发。 */
export interface AnnotateRequest {
  id: string;
  action: 'focus' | 'edit';
  nonce: number;
}

export interface AnnotateToast {
  text: string;
  tone: 'info' | 'warn';
}

/** 提示自己消失的时长。够读完一句中文，又不至于一直挡着正文。 */
const TOAST_MS = 4000;

export interface AnnotationSession {
  active: boolean;
  setActive: (next: boolean) => void;
  toggle: () => void;
  mode: AnnotateMode;
  setMode: (mode: AnnotateMode) => void;
  panelOpen: boolean;
  setPanelOpen: (next: boolean) => void;
  request: AnnotateRequest | null;
  ask: (id: string, action: 'focus' | 'edit') => void;
  clearRequest: () => void;
  toast: AnnotateToast | null;
  say: (text: string, tone?: 'info' | 'warn') => void;
}

/**
 * @param resetKey 换文档就重置整个会话（换一篇要重新点「批注」才进得来）
 */
export function useAnnotationSession(resetKey: string): AnnotationSession {
  const [active, setActiveRaw] = useState(false);
  const [mode, setMode] = useState<AnnotateMode>('pick-element');
  const [panelOpen, setPanelOpen] = useState(false);
  const [request, setRequest] = useState<AnnotateRequest | null>(null);
  const [toast, setToast] = useState<AnnotateToast | null>(null);
  const nonce = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    setMode('pick-element');
    setPanelOpen(false);
    setRequest(null);
    setToast(null);
  }, [resetKey]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const setActive = useCallback((next: boolean) => {
    setActiveRaw(next);
    // 收起时把浮层一起收干净：留一个开着的清单飘在正文上没有意义
    if (!next) {
      setPanelOpen(false);
      setRequest(null);
      setToast(null);
    }
  }, []);

  const say = useCallback((text: string, tone: 'info' | 'warn' = 'info') => {
    setToast({ text, tone });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  const ask = useCallback((id: string, action: 'focus' | 'edit') => {
    nonce.current += 1;
    setRequest({ id, action, nonce: nonce.current });
  }, []);

  return {
    active,
    setActive,
    toggle: useCallback(() => setActive(!active), [active, setActive]),
    mode,
    setMode,
    panelOpen,
    setPanelOpen,
    request,
    ask,
    clearRequest: useCallback(() => setRequest(null), []),
    toast,
    say,
  };
}
