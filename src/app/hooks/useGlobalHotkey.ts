import { useEffect, useRef } from 'react';

/**
 * 本仓第一个 **App 级**全局快捷键。此前所有 keydown 都是组件局部的
 * （`ImageLightbox` 的方向键、检索条的 Esc），挂在打开着的那个组件上；
 * 未决问题弹窗要能在任意视图唤出，没有组件可挂，只能挂到 document 上。
 *
 * 一并放在这里的 `isTypingTarget` 是另一半约定：**输入框里的按键不劫持**。
 * 带修饰键的快捷键（⌘K）在输入框里照样生效，那是命令面板的通行做法；
 * 而裸键（方向键、数字键）必须让给输入框，否则用户打字时光标会乱跑。
 */

/** 焦点是否落在能打字的地方（输入框、文本域、可编辑区、下拉的搜索框） */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * 监听一个带修饰键的全局快捷键。
 *
 * 用 capture 阶段：Base UI 的 Popup 会在冒泡阶段拦掉一部分按键（`ImageLightbox`
 * 的方向键就是为此才用 capture），弹窗自己开着时再按一次 ⌘K 要能关掉它。
 *
 * @param key 主键，大小写不敏感（'k'）
 * @param handler 命中时调用。身份可变，内部用 ref 兜住，不必让调用方 useCallback
 * @param enabled false 时不挂监听
 */
export function useGlobalHotkey(key: string, handler: () => void, enabled = true) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== key.toLowerCase()) return;
      event.preventDefault();
      event.stopPropagation();
      handlerRef.current();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [key, enabled]);
}
