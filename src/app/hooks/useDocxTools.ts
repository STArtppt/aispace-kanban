import { useCallback, useEffect, useState } from 'react';
import { api, type Health } from '@/lib/api';

/**
 * docx 工具链在这台机器、这个工作空间上能不能用：Python / pandoc / 脚本、服务是否可写。
 * 取不到（旧服务、网络错误）就是 null —— 调用方按「不知道」处理：不置灰，交给服务端的错误去说明。
 */
export function useDocxTools(projectId: string, enabled = true) {
  const [health, setHealth] = useState<Health | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      setHealth(await api.healthFor(projectId));
    } catch {
      setHealth(null);
    }
  }, [projectId]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  return {
    health,
    reload: load,
    /** 非环回监听时的说明；可写或不知道时为空串 */
    readOnlyReason: health?.writable === false ? '看板没有监听本机回环地址，写操作已禁用；请用默认的 127.0.0.1 启动看板' : '',
    /** 缺 pandoc 时的说明；有或不知道时为空串 */
    pandocReason: health?.docxTools && health.docxTools.pandoc === false
      ? (health.docxTools.pandocVersion
        ? `本机的 pandoc 版本过低（${health.docxTools.pandocVersion}），需要 3 以上，装好后重启看板`
        : '本机没有 pandoc 3，装好后重启看板')
      : '',
    /** 明确知道这个工作空间缺脚本时为 true；不知道时为 false */
    scriptsMissing: health?.docxTools?.scripts === false,
  };
}
