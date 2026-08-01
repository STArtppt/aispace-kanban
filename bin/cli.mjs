#!/usr/bin/env node
/**
 * aispace-kanban —— PM 工作空间看板的常驻服务。
 *
 *   aispace-kanban serve [--port 5180] [--host 127.0.0.1] [--no-open] [--dev]
 *   aispace-kanban add <工作空间目录> [--name 名字]
 *   aispace-kanban list
 *   aispace-kanban remove <id>
 *
 * 这个文件同时是 npm 包的入口（npx -y @startist/aispace-kanban），
 * 所以第一件事是查 Node 版本 —— 版本不够要给中文提示，别让用户吃一脸原始堆栈。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(NODE_MAJOR) || NODE_MAJOR < 20) {
  console.error(`\n  工作空间看板需要 Node.js 20 或更高版本，当前是 v${process.versions.node}。`);
  console.error('  （自动刷新靠 fs.watch 的递归监听，Linux 上要 Node 20 才支持。）');
  console.error('  去 https://nodejs.org 装个 LTS 再来。\n');
  process.exit(1);
}

const {
  addProject,
  PROJECTS_FILE,
  projectStatus,
  readProjects,
  removeProject,
  updateProject,
} = await import('../src/server/config.mjs');
const { createServer } = await import('../src/server/http.mjs');
const { openInBrowser } = await import('../src/server/platform.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 5180;
const DEV_PORT = 5181;
/** 端口被占用时往上顺延几个再放弃 */
const PORT_PROBE_RANGE = 10;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/** 不带值的开关。不列在这里的话 `--no-open serve` 会把 serve 当成它的值吃掉。 */
const BOOL_FLAGS = new Set(['dev', 'no-open', 'help', 'version']);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '-h' || item === '-v') {
      args[item === '-h' ? 'help' : 'version'] = true;
    } else if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = argv[i + 1];
      if (BOOL_FLAGS.has(key) || !next || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(item);
    }
  }
  return args;
}

function usage() {
  console.log(`工作空间看板

  aispace-kanban [serve]                                 起服务并打开浏览器
  aispace-kanban add <工作空间目录> [--name 名字]        登记一个工作空间
  aispace-kanban list                                    看已登记的工作空间
  aispace-kanban relink <id> <新目录> [--name 名字]      目录改名/移动后接回来
  aispace-kanban remove <id>                             取消登记（不删本地文件）

serve 的选项：
  --port <n>      端口，默认 ${DEFAULT_PORT}（被占用时自动往上顺延至多 ${PORT_PROBE_RANGE} 个）
  --host <addr>   监听地址，默认 127.0.0.1（只有本机能连）
  --no-open       不自动打开浏览器
  --dev           同时起 Vite（${DEV_PORT}）热更前端，只在源码仓库里能用

登记信息存在 ${PROJECTS_FILE}`);
}

/** 端口能不能听。占用的判据就是"听不上"，不猜是谁占的。 */
function canListen(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

async function findFreePort(start, host) {
  for (let port = start; port <= start + PORT_PROBE_RANGE; port += 1) {
    if (await canListen(port, host)) return port;
  }
  return 0;
}

function cmdList() {
  const { projects, activeProjectId } = readProjects();
  if (!projects.length) {
    console.log('还没登记任何工作空间。用 `aispace-kanban add <目录>` 加一个。');
    return;
  }
  for (const p of projects) {
    const status = projectStatus(p);
    const flag = status.ok ? '' : `  ← ${status.reasons.join('、')}，用 relink 接回来`;
    console.log(`${p.id === activeProjectId ? '*' : ' '} ${p.id.padEnd(24)} ${p.name.padEnd(20)} ${p.root}${flag}`);
  }
}

async function cmdServe(args) {
  const wanted = Number(args.port || process.env.PMWORK_DASHBOARD_PORT || DEFAULT_PORT);
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > 65535) {
    throw new Error(`端口不对：${args.port}`);
  }
  const host = typeof args.host === 'string' ? args.host : '127.0.0.1';
  const dev = Boolean(args.dev);
  const open = !args['no-open'];

  // dev 模式要起 Vite，而 npm 包里只有构建好的 dist/，没有前端源码和 devDependencies
  if (dev && !fs.existsSync(path.join(ROOT, 'vite.config.ts'))) {
    throw new Error('--dev 需要前端源码，只能在看板的源码仓库里用；装成 npm 包时直接跑 serve 就行');
  }

  const port = await findFreePort(wanted, host);
  if (!port) {
    throw new Error(`${wanted}~${wanted + PORT_PROBE_RANGE} 这些端口都被占着，用 --port 指一个别的`);
  }
  if (port !== wanted) console.log(`  端口 ${wanted} 被占用了，改用 ${port}`);

  let vite = null;
  if (dev) {
    // Windows 上 npx 是 npx.cmd，spawn 不走 shell 就找不到它
    vite = spawn('npx', ['vite', '--port', String(DEV_PORT), '--strictPort'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, PMWORK_API_PORT: String(port) },
    });
    vite.on('exit', (code) => {
      if (code) process.exit(code);
    });
  }

  const server = createServer();
  server.listen(port, host, () => {
    const shown = LOOPBACK.has(host) ? 'localhost' : host;
    const appUrl = dev ? `http://${shown}:${DEV_PORT}` : `http://${shown}:${port}`;
    console.log(`\n  工作空间看板已启动`);
    console.log(`  界面   ${appUrl}`);
    console.log(`  接口   http://${shown}:${port}/api`);
    const { projects } = readProjects();
    console.log(`  已登记 ${projects.length} 个工作空间${projects.length ? '' : '（在界面上「添加工作空间」，或用 add 命令）'}`);
    console.log(`  按 Ctrl+C 停\n`);
    // dev 模式下 Vite 还要几秒才起得来，这时候打开浏览器只会看到连接失败，所以不自动开
    if (open && !dev) openInBrowser(appUrl);
  });

  const shutdown = () => {
    vite?.kill();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** 包版本号，用于 --version。读不到不是问题，别为这个报错。 */
function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const args = parseArgs(process.argv.slice(2));
const [command, target] = args._;

if (args.help || args.h) {
  usage();
  process.exit(0);
}
if (args.version || args.v) {
  console.log(readVersion());
  process.exit(0);
}

try {
  switch (command) {
    case 'serve':
    case undefined:
      await cmdServe(args);
      break;
    case 'add': {
      if (!target) throw new Error('要指定工作空间目录，比如 add ~/work/某个工作空间');
      const project = addProject(path.resolve(target), typeof args.name === 'string' ? args.name : '');
      console.log(`已登记：${project.id}  ${project.name}\n${project.root}`);
      break;
    }
    case 'list':
      cmdList();
      break;
    case 'relink': {
      const newRoot = args._[2];
      if (!target || !newRoot) throw new Error('用法：relink <id> <新目录>，id 用 list 查看');
      const project = updateProject(target, {
        root: path.resolve(newRoot),
        name: typeof args.name === 'string' ? args.name : '',
      });
      console.log(`已接回：${project.id}  ${project.name}\n${project.root}`);
      break;
    }
    case 'remove':
      if (!target) throw new Error('要指定项目 id，用 list 查看');
      console.log(
        removeProject(target)
          ? `已移出看板 ${target}（只删登记信息，本地文件没动）`
          : `没有这个项目：${target}`,
      );
      break;
    default:
      usage();
      process.exitCode = 1;
  }
} catch (err) {
  console.error(`出错了：${err.message}`);
  process.exitCode = 1;
}
