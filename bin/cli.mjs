#!/usr/bin/env node
/**
 * workspace-dashboard —— PM 工作空间看板的常驻服务。
 *
 *   workspace-dashboard serve [--port 5180] [--dev]
 *   workspace-dashboard add <工作空间目录> [--name 名字]
 *   workspace-dashboard list
 *   workspace-dashboard remove <id>
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { addProject, PROJECTS_FILE, readProjects, removeProject } from '../src/server/config.mjs';
import { createServer } from '../src/server/http.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 5180;
const DEV_PORT = 5181;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) args[key] = true;
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

  workspace-dashboard serve [--port ${DEFAULT_PORT}] [--dev]   起服务
  workspace-dashboard add <工作空间目录> [--name 名字]        登记一个工作空间
  workspace-dashboard list                                    看已登记的工作空间
  workspace-dashboard remove <id>                             取消登记

登记信息存在 ${PROJECTS_FILE}`);
}

function cmdList() {
  const { projects, activeProjectId } = readProjects();
  if (!projects.length) {
    console.log('还没登记任何工作空间。用 `workspace-dashboard add <目录>` 加一个。');
    return;
  }
  for (const p of projects) {
    console.log(`${p.id === activeProjectId ? '*' : ' '} ${p.id.padEnd(24)} ${p.name.padEnd(20)} ${p.root}`);
  }
}

function cmdServe(args) {
  const port = Number(args.port || process.env.PMWORK_DASHBOARD_PORT || DEFAULT_PORT);
  const dev = Boolean(args.dev);
  let vite = null;

  if (dev) {
    vite = spawn('npx', ['vite', '--port', String(DEV_PORT), '--strictPort'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, PMWORK_API_PORT: String(port) },
    });
    vite.on('exit', (code) => {
      if (code) process.exit(code);
    });
  }

  const server = createServer();
  server.listen(port, () => {
    const appUrl = dev ? `http://localhost:${DEV_PORT}` : `http://localhost:${port}`;
    console.log(`\n  工作空间看板已启动`);
    console.log(`  界面   ${appUrl}`);
    console.log(`  接口   http://localhost:${port}/api`);
    const { projects } = readProjects();
    console.log(`  已登记 ${projects.length} 个工作空间${projects.length ? '' : '（用 add 命令加一个）'}\n`);
  });

  const shutdown = () => {
    vite?.kill();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const args = parseArgs(process.argv.slice(2));
const [command, target] = args._;

try {
  switch (command) {
    case 'serve':
    case undefined:
      cmdServe(args);
      break;
    case 'add': {
      if (!target) throw new Error('要指定工作空间目录，比如 add ../pmwork-template');
      const project = addProject(path.resolve(target), typeof args.name === 'string' ? args.name : '');
      console.log(`已登记：${project.id}  ${project.name}\n${project.root}`);
      break;
    }
    case 'list':
      cmdList();
      break;
    case 'remove':
      if (!target) throw new Error('要指定项目 id，用 list 查看');
      console.log(removeProject(target) ? `已移除 ${target}` : `没有这个项目：${target}`);
      break;
    default:
      usage();
      process.exitCode = 1;
  }
} catch (err) {
  console.error(`出错了：${err.message}`);
  process.exitCode = 1;
}
