/**
 * 跨平台的系统调用都集中在这里：打开浏览器、在文件管理器里定位文件、找 Python 解释器。
 * 三个平台的命令名和参数形态完全不一样，散在各处很容易写着写着只剩 macOS 能用。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

/** 各平台文件管理器的名字，只用于界面文案（前端拿 platform 自己查表）。 */
export const FILE_MANAGER = {
  darwin: '访达',
  win32: '文件资源管理器',
};

/**
 * 起一个不管结果的系统进程。
 * 命令不在 PATH 上（精简 Linux 常常没有 xdg-open）时 spawn 是**异步**报错，
 * 不接住 error 事件会把常驻服务整个带崩 —— 看板只是个只读工具，不值得为这个挂掉。
 */
function detached(cmd, args) {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => console.warn(`调用系统命令失败：${cmd} —— ${err.message}`));
    child.unref();
    return true;
  } catch (err) {
    console.warn(`调用系统命令失败：${cmd} —— ${err.message}`);
    return false;
  }
}

/** 用系统默认浏览器打开一个地址。打不开也只是少个便利，不影响服务本身。 */
export function openInBrowser(url) {
  if (process.platform === 'darwin') return detached('open', [url]);
  // Windows 的 start 是 cmd 内建命令，第一个空串是窗口标题占位（省了它会把地址当标题）
  if (process.platform === 'win32') return detached('cmd.exe', ['/c', 'start', '', url]);
  return detached('xdg-open', [url]);
}

/**
 * 把文件交给系统：`mode === 'open'` 用默认程序打开，否则在文件管理器里定位到它。
 *
 * - macOS：`open -R` 就是"在访达中显示"
 * - Windows：`explorer /select,<路径>` 必须是**一个参数**，逗号后面不能有空格
 * - Linux：没有通用的"定位到某个文件"命令，退而求其次打开它所在的目录
 */
export function revealInSystem(abs, mode = 'reveal') {
  const reveal = mode !== 'open';
  if (process.platform === 'darwin') {
    return detached('open', reveal ? ['-R', abs] : [abs]);
  }
  if (process.platform === 'win32') {
    if (reveal) return detached('explorer.exe', [`/select,${abs}`]);
    return detached('cmd.exe', ['/c', 'start', '', abs]);
  }
  return detached('xdg-open', [reveal ? path.dirname(abs) : abs]);
}

/**
 * Python 3 解释器候选，按顺序试到能跑为止（新建工作空间要调模板的 init_workspace.py）。
 * Windows 上装完 Python 一般只有 `py` 启动器和 `python`，`python3` 常常是个跳去应用商店的假货，
 * 所以那边把 `py -3` 排在最前面。
 */
export const PYTHON_CANDIDATES = process.platform === 'win32'
  ? [['py', '-3'], ['python'], ['python3']]
  : [['python3'], ['python']];
