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
let pending: Promise<string> | null = null;

function queryName(): Promise<string> {
  pending ??= api
    .health()
    .then((data) => NAMES[data.platform || ''] || FALLBACK)
    .catch(() => FALLBACK);
  return pending;
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
