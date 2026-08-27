import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/** 各平台文件管理器的叫法。定位动作发生在服务所在的机器上，不能拿浏览器的 navigator 判断。 */
const NAMES: Record<string, string> = {
  darwin: '访达',
  win32: '文件资源管理器',
  linux: '文件管理器',
};
const FALLBACK = NAMES.darwin;

/** 只查一次就够：服务不会中途换操作系统。多个组件共用这一份 promise。 */
let pendingHealth: Promise<{ platform?: string }> | null = null;

function queryHealth(): Promise<{ platform?: string }> {
  pendingHealth ??= api.health().catch(() => ({}) as { platform?: string });
  return pendingHealth;
}

function queryName(): Promise<string> {
  return queryHealth().then((data) => NAMES[data.platform || ''] || FALLBACK);
}

/** 各平台拼路径用的分隔符。跟文件名的叫法一样是服务所在机器的事，不看浏览器。 */
const SEPARATORS: Record<string, string> = { win32: '\\' };

/**
 * 「复制绝对路径」拼路径用的分隔符（Windows 是 \，其余都是 /）。
 * 默认 '/'：平台拿不到时（老服务进程、请求失败）先保正斜杠能算路用。
 */
export function usePathSeparator() {
  const [sep, setSep] = useState('/');
  useEffect(() => {
    let alive = true;
    void queryHealth().then((data) => {
      if (alive && SEPARATORS[data.platform || '']) setSep(SEPARATORS[data.platform || '']);
    });
    return () => {
      alive = false;
    };
  }, []);
  return sep;
}

/**
 * 「在 XX 中显示」里的 XX。
 * 拿不到（老服务进程没这个字段、请求失败）时退回「访达」—— 宁可文案不准，也不让按钮变空。
 */
export function useFileManagerName() {
  const [name, setName] = useState(FALLBACK);
  useEffect(() => {
    let alive = true;
    void queryName().then((value) => {
      if (alive) setName(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return name;
}
