import { useCallback, useMemo, useSyncExternalStore } from 'react';

/**
 * 列表行的「收藏置顶」。
 * 纯前端偏好（工作空间只读，不往里写任何东西），按工作空间存相对路径。
 * 清单和预览两处都要能收藏，且要立刻互相看见 —— 所以状态放在模块级，
 * 用 useSyncExternalStore 广播，而不是各自 useState 各存一份。
 *
 * 键名沿用 aispace-kanban:output-pins：最早只给产出文档用，后来扩到所有清单；
 * 不改键，已收藏的产出才不会丢。
 */
const PIN_KEY = 'aispace-kanban:output-pins';

type PinStore = Record<string, string[]>;

/** 没收藏时统一返回同一个空数组：快照引用不变，组件才不会被无谓重渲 */
const EMPTY: string[] = [];

let cache: PinStore | null = null;
const listeners = new Set<() => void>();

function readStore(): PinStore {
  if (cache) return cache;
  const next: PinStore = {};
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PIN_KEY) || '{}');
    if (raw && typeof raw === 'object') {
      for (const [id, list] of Object.entries(raw as Record<string, unknown>)) {
        if (Array.isArray(list)) {
          next[id] = list.filter((path): path is string => typeof path === 'string');
        }
      }
    }
  } catch {
    // 存坏了当作没收藏过：少几颗星，也好过整个视图崩掉
  }
  cache = next;
  return cache;
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

/** 某个工作空间收藏了哪些路径，以及切换收藏的入口 */
export function usePins(projectId: string) {
  const paths = useSyncExternalStore(subscribe, () => readStore()[projectId] || EMPTY);
  const pins = useMemo(() => new Set(paths), [paths]);

  const togglePin = useCallback(
    (path: string) => {
      const store = readStore();
      const current = store[projectId] || EMPTY;
      const next = current.includes(path)
        ? current.filter((item) => item !== path)
        : [...current, path];
      if (next.length) store[projectId] = next;
      else delete store[projectId];
      localStorage.setItem(PIN_KEY, JSON.stringify(store));
      for (const notify of listeners) notify();
    },
    [projectId],
  );

  return { pins, togglePin };
}
