/**
 * 应用版本解析（CLI --version / /api/health / 侧栏）。
 *
 * 单一真相源策略（与 pentou 对齐，git tag 注入）：
 *   1. env PMWORK_VERSION | APP_VERSION（CI 覆盖）
 *   2. package.json#version，且不是仓库占位 0.0.0 / 0.0.1（npm 发版注入后走这里）
 *   3. 有 .git 时取最新 v* tag；HEAD 恰在该 tag 上则裸版本，否则加 -dev[+短 hash]
 *   4. 没 .git 时退回 package.json，哪怕是占位号
 *      （装成 npm 包后没有 git，首版 0.0.1 就是发出去的那个号）
 *   5. 回落 0.0.0-dev
 *
 * public 上的 v* 与 main 祖先图往往不相连，故用 `git tag -l` 而非 `git describe`。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 仓库内占位版本：发版前不手改 package.json，正式号由 tag / --version 注入。 */
const PLACEHOLDER_VERSIONS = new Set(['0.0.0', '0.0.1']);

function defaultExecGit(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** 去掉可选前导 `v`，得到 semver 主体。 */
export function stripVersionPrefix(raw) {
  const s = String(raw).trim();
  return s.startsWith('v') || s.startsWith('V') ? s.slice(1) : s;
}

function readPackageVersion(projectRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    if (pkg.version == null || pkg.version === '') return null;
    return stripVersionPrefix(String(pkg.version));
  } catch {
    return null;
  }
}

function resolveFromGitTags(projectRoot, execGit) {
  if (!fs.existsSync(path.join(projectRoot, '.git'))) return null;

  const list = execGit(['tag', '-l', 'v*', '--sort=-v:refname'], projectRoot);
  if (!list) return null;
  const latest = list.split('\n').map((line) => line.trim()).find(Boolean);
  if (!latest) return null;

  const base = stripVersionPrefix(latest);
  if (!base) return null;

  const tagCommit = execGit(['rev-list', '-n', '1', latest], projectRoot);
  const head = execGit(['rev-parse', 'HEAD'], projectRoot);
  if (tagCommit && head && tagCommit === head) return base;

  const short = execGit(['rev-parse', '--short', 'HEAD'], projectRoot);
  return short ? `${base}-dev+${short}` : `${base}-dev`;
}

/**
 * 解析当前应用版本字符串（无前导 v）。
 * @param {string} projectRoot 包根（含 package.json；开发时为仓库根）
 * @param {{ env?: NodeJS.ProcessEnv, execGit?: (args: string[], cwd: string) => string | null }} [options]
 */
export function resolveAppVersion(projectRoot, options = {}) {
  const env = options.env ?? process.env;
  const execGit = options.execGit ?? defaultExecGit;

  const fromEnv = (env.PMWORK_VERSION ?? env.APP_VERSION)?.trim();
  if (fromEnv) return stripVersionPrefix(fromEnv);

  const pkgVer = readPackageVersion(projectRoot);
  if (pkgVer && !PLACEHOLDER_VERSIONS.has(pkgVer)) return pkgVer;

  const fromGit = resolveFromGitTags(projectRoot, execGit);
  if (fromGit) return fromGit;

  // 装成 npm 包后没有 .git：占位号就是发版注入进去的那个号（首版 0.0.1）。
  if (pkgVer && !fs.existsSync(path.join(projectRoot, '.git'))) return pkgVer;

  return '0.0.0-dev';
}
