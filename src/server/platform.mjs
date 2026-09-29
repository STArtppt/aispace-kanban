/**
 * 跨平台的系统调用都集中在这里：打开浏览器、在文件管理器里定位文件、找 Python 解释器与 pandoc、
 * 弹出系统原生目录选择框。三个平台的命令名和参数形态完全不一样，散在各处很容易写着写着只剩 macOS 能用。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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

/** 找一个能用的 Python 3。解释器名各平台不同，挨个试到 `--version` 成功为止。 */
export function findPython() {
  return new Promise((resolve) => {
    const candidates = [...PYTHON_CANDIDATES];
    const tryNext = () => {
      const next = candidates.shift();
      if (!next) return resolve(null);
      const [bin, ...prefix] = next;
      const child = spawn(bin, [...prefix, '--version'], { stdio: 'ignore' });
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        if (ok) resolve([bin, ...prefix]);
        else tryNext();
      };
      child.on('error', () => done(false));
      child.on('close', (code) => done(code === 0));
    };
    tryNext();
  });
}

/** 从工作空间 .env 里只取一个键（不把整份读进环境变量）。读不到返回 null。 */
function envFileValue(root, key) {
  if (!root) return null;
  let text;
  try {
    text = fs.readFileSync(path.join(root, '.env'), 'utf8');
  } catch {
    return null;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const at = line.indexOf('=');
    if (line.slice(0, at).trim() !== key) continue;
    return line.slice(at + 1).trim().replace(/^['"]|['"]$/g, '') || null;
  }
  return null;
}

/** `pandoc --version` 的版本号；跑不起来返回 null。 */
function pandocVersion(bin) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const m = out.trim().match(/^pandoc(?:\.exe)?\s+(\d+(?:\.\d+)*)/);
      resolve(m ? m[1] : null);
    });
  });
}

/**
 * 找 pandoc 3：`PANDOC_BIN` 环境变量 → 工作空间 `.env` 的 `PANDOC_BIN` → `PATH`。
 * 与工作空间 scripts/docxkit/pandoc.py 的查找顺序一致 —— 两边判断不一样，界面上
 * 「转换」可点、脚本却说找不到 pandoc，是最难解释的一种不一致。改一边要改另一边。
 *
 * @param {string} [root] 工作空间根；不给就只看环境变量和 PATH
 * @returns {Promise<{ bin: string, version: string } | { bin: null, version: string | null }>}
 *   找不到时 bin 为 null；version 非空表示找到了但版本低于 3
 */
export async function findPandoc(root) {
  const candidates = [process.env.PANDOC_BIN, envFileValue(root, 'PANDOC_BIN'), 'pandoc'].filter(Boolean);
  let tooOld = null;
  for (const bin of candidates) {
    const version = await pandocVersion(bin);
    if (!version) continue;
    if (Number(version.split('.')[0]) >= 3) return { bin, version };
    tooOld = version;
  }
  return { bin: null, version: tooOld };
}

/** 目录选择框开太久就杀子进程，避免一个挂住的 HTTP 请求一直占着。 */
const PICK_DIRECTORY_TIMEOUT_MS = 120_000;

function unavailableError() {
  return new Error('这台机器上起不了目录选择框，请手工填绝对路径');
}

function timeoutError() {
  const err = new Error('选择框开太久，已经关掉了。请再点一次，或直接在输入框里填绝对路径。');
  err.statusCode = 408;
  return err;
}

function escapeAppleScript(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function stripTrailingSep(abs) {
  if (!abs) return abs;
  if (process.platform === 'win32') {
    const trimmed = abs.replace(/[\\/]+$/, '');
    return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
  }
  return abs.length > 1 ? abs.replace(/\/+$/, '') : abs;
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ timeoutMs?: number, windowsHide?: boolean }} [opts]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runCaptured(cmd, args, { timeoutMs = PICK_DIRECTORY_TIMEOUT_MS, windowsHide = false } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide,
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
      }, 1000);
      reject(timeoutError());
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * 把子进程的退出翻成「选中 / 取消 / 起不来」。
 * 三个平台取消的表现不一样（非零退出、退出码 1、空输出），一律不当错误。
 * 真正起不来（没装 zenity、没有桌面、DISPLAY 为空）才抛中文说明。
 */
function interpretPick({ code, stdout, stderr }) {
  const chosen = stripTrailingSep(stdout.replace(/\r?\n/g, '').trim());
  if (chosen) return { picked: true, path: chosen };
  const err = (stderr || '').trim();
  const looksCanceled = code === 0 || code === 1
    || /user canceled|user cancelled|-128/i.test(err);
  const looksBroken = err
    && /unable|cannot|error|display|failed|not found|找不到|no display/i.test(err)
    && !/cancel/i.test(err);
  if (looksCanceled && !looksBroken) return { picked: false };
  throw unavailableError();
}

function macosPickArgs(prompt) {
  const escaped = escapeAppleScript(prompt);
  // System Events 置前，否则对话框会弹到浏览器后面，用户以为没反应。
  // 用户取消是 AppleScript -128，这里收成空串，由 interpretPick 当取消。
  const script = [
    'tell application "System Events" to activate',
    'try',
    `  return POSIX path of (choose folder with prompt "${escaped}")`,
    'on error number -128',
    '  return ""',
    'end try',
  ].join('\n');
  return ['osascript', ['-e', script]];
}

function windowsPickArgs(prompt) {
  // -EncodedCommand 吃 UTF-16LE base64，中文提示词和中文路径都不会在命令行上烂掉。
  const safe = String(prompt).replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dialog.Description = '${safe}'`,
    '$dialog.ShowNewFolderButton = $true',
    '$form = New-Object System.Windows.Forms.Form',
    '$form.TopMost = $true',
    "$form.StartPosition = 'Manual'",
    '$form.Location = New-Object System.Drawing.Point(-2000, -2000)',
    '$form.Size = New-Object System.Drawing.Size(1, 1)',
    '$form.ShowInTaskbar = $false',
    '$result = $dialog.ShowDialog($form)',
    '$path = $dialog.SelectedPath',
    '$form.Dispose()',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $path) {',
    '  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    '  [Console]::Out.Write($path)',
    '}',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return ['powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded]];
}

function zenityArgs(prompt) {
  return ['zenity', ['--file-selection', '--directory', `--title=${prompt}`]];
}

function kdialogArgs(prompt) {
  return ['kdialog', ['--getexistingdirectory', os.homedir() || '/', `--title=${prompt}`]];
}

/**
 * 在服务所在的机器上弹出系统原生目录选择框，返回用户选中的绝对路径。
 * 取消 → `{ picked: false }`；命令不存在 / 没有桌面 → 抛中文 Error。
 *
 * @param {{ prompt?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ picked: boolean, path?: string }>}
 */
export async function pickDirectory({
  prompt = '选择工作空间目录',
  timeoutMs = PICK_DIRECTORY_TIMEOUT_MS,
} = {}) {
  const run = (cmd, args, extra = {}) =>
    runCaptured(cmd, args, { timeoutMs, ...extra }).then(interpretPick);

  if (process.platform === 'darwin') {
    const [cmd, args] = macosPickArgs(prompt);
    try {
      return await run(cmd, args);
    } catch (err) {
      if (err.code === 'ENOENT') throw unavailableError();
      throw err;
    }
  }

  if (process.platform === 'win32') {
    const [cmd, args] = windowsPickArgs(prompt);
    try {
      return await run(cmd, args, { windowsHide: true });
    } catch (err) {
      if (err.code === 'ENOENT') throw unavailableError();
      throw err;
    }
  }

  const [zCmd, zArgs] = zenityArgs(prompt);
  try {
    return await run(zCmd, zArgs);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      if (err.statusCode) throw err;
      throw unavailableError();
    }
  }
  const [kCmd, kArgs] = kdialogArgs(prompt);
  try {
    return await run(kCmd, kArgs);
  } catch (err) {
    if (err.code === 'ENOENT' || !err.statusCode) throw unavailableError();
    throw err;
  }
}
