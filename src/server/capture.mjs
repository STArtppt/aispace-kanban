/**
 * 贴 URL 采集 —— **看板唯一往工作空间写文件的地方**。
 *
 * ## 来源
 * 采集核心移植自相邻仓 acgogogo 的 `daemon/capture/index.ts`(2072 行),
 * **只搬两段**:
 *   1. `single-file` 子进程调用 + 「退出码 0 但没产物」的重试逻辑;
 *   2. 三档截图(hero / full / mobile)。
 * **不搬**:登录态 / storageState 注入、consent 点击、预览视频与 ffmpeg 转码、
 * 多状态巡览截图、品牌提取、design-spec / logic-spec 分析线、并发池。
 * 那些都耦合着它自己的 captures-root / brand / auth,搬过来只会把整条分析线拖进来。
 *
 * ## AGPL 边界(硬约束)
 * `single-file-cli` 是 AGPL-3.0。它**只能以独立可执行文件的形式用**:
 * 在 PATH 上找、用 `spawn` 起子进程,**永不 `import`**,也不进 npm `dependencies` ——
 * `scripts/build-npm-package.mjs` 按 import 图重算依赖,写进去会把 AGPL 传染进看板包。
 * spawn 的只是一个字符串,不构成链接。
 *
 * ## Playwright 探测策略
 * 看板是 `npx aispace-kanban` 起的轻量工具,不该为一个可选功能让所有人多下一个 Chromium。
 * 所以 Playwright **运行时动态 import,失败即整体降级**:
 *   - 缺 `single-file` → 参考采集**失败**(参考的本体就是它),原型导入不受影响;
 *   - 缺 `playwright`  → **成功但降级**,参考只出 index.html、原型只出 meta.json。
 * 降级原因写进 `meta.json` 的 `degraded` 和界面,不许只写日志。
 *
 * ## 只读红线的窄例外
 * 写路径只允许落在 `visualization/references/<slug>/` 与 `visualization/prototypes/<slug>/`,
 * 且必须先过 `resolveInside()`;slug 由本模块生成,不接受任何客户端传来的路径片段;
 * **只新建,不覆盖、不删除**。范围见 AGENTS.md 不变量 1 的第二条窄例外。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_DIR } from './config.mjs';
import { resolveInside } from './paths.mjs';

/** 两个目标平面,值就是工作空间内的相对目录 —— 红线允许写的**全部**位置。 */
const PLANE_DIR = {
  reference: path.join('visualization', 'references'),
  prototype: path.join('visualization', 'prototypes'),
};

/** single-file 子进程超时:抓一个普通页面几秒到几十秒,120s 还没完基本就是卡住了 */
const SINGLE_FILE_TIMEOUT_MS = 120_000;
/** 截图整体超时(三档合计),超时即杀、按降级处理 */
const SCREENSHOT_TIMEOUT_MS = 90_000;
/** 单页导航超时 */
const NAV_TIMEOUT_MS = 25_000;
/** 加载缓冲:容错网络慢导致的渲染滞后,等 2s 再开拍(照搬相邻仓实测值) */
const SETTLE_AFTER_LOAD_MS = 2_000;
/**
 * 自包含 HTML 的体积上限。单页正常在几 MB 量级;到 64 MB 说明抓到了不该抓的东西,
 * 写进去只会拖垮之后每一次扫描。
 */
const MAX_HTML_BYTES = 64 * 1024 * 1024;

/** 三档截图的视口。full 用 1280 宽而不是 1920:整页长图看的是信息结构,不是像素 */
const HERO_VIEWPORT = { width: 1920, height: 1080 };
const FULL_VIEWPORT = { width: 1280, height: 900 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

/** 两条缺工具的文案分开,都给可直接复制的安装命令 */
export const SINGLE_FILE_INSTALL = 'npm i -g single-file-cli';
export const PLAYWRIGHT_INSTALL = 'npm i -g playwright && playwright install chromium';

const MISSING_SINGLE_FILE = `本机 PATH 上找不到 single-file 命令。参考的本体就是它抓的自包含页面，缺了没法采集。装一次即可：\n${SINGLE_FILE_INSTALL}`;
const MISSING_PLAYWRIGHT = `本机没有可用的 Playwright，截图这一档整个跳过了，参考本体已经收下。装一次即可（会下载一个 Chromium）：\n${PLAYWRIGHT_INSTALL}`;
const MISSING_PLAYWRIGHT_COVER = `本机没有可用的 Playwright，这次没有封面，链接已经收下、卡片走窗框占位。装一次即可（会下载一个 Chromium）：\n${PLAYWRIGHT_INSTALL}`;

/**
 * 每个工作空间至多一个进行中的采集任务(仿 ingest)。
 * status: running | done | error。不推日志流 —— single-file 与 Playwright 的 stderr
 * 对用户几乎不可读,推给他只是噪音;失败原因已经提炼进 message。
 */
const captureJobs = new Map();

// ── URL 与 slug ──────────────────────────────────────────────────────────────

/** 只收 http/https。前端也会先判一次,这里是不信客户端的那一道。 */
export function normalizeTargetUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  return parsed.toString();
}

/**
 * 生成安全的目录名。
 * **客户端传来的任何路径片段一律不参与** —— 输入只有服务端拿到的标题和 URL。
 * 保留中文(工作空间里全是中文目录名),去掉路径分隔符、控制字符和首尾的点。
 */
function slugify(title, url) {
  const fromTitle = String(title || '').trim();
  let base = fromTitle;
  if (!base) {
    try {
      const u = new URL(url);
      base = `${u.hostname}${u.pathname}`.replace(/\/+$/, '');
    } catch {
      base = '';
    }
  }
  const safe = base
    // 控制字符直接丢掉（页面标题里出现过换行）
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 60);
  return safe || `capture-${Date.now()}`;
}

// ── 写入收口 ─────────────────────────────────────────────────────────────────

/**
 * **唯一的工作空间写入函数。**
 *
 * 先 `resolveInside(root, 'visualization/<平面>/<slug>')` 挡穿越,再找一个还不存在的
 * slug(`<slug>` → `<slug>-2` → `<slug>-3` …)建目录,最后把已经准备好的临时目录整体移进去。
 * **不覆盖、不删除**任何已有目录 —— 同一 URL 采第二次就是多一份,旧的原样留着。
 *
 * 临时目录在工作空间**之外**(看板自家缓存),这样失败 / 超时的半成品永远不会
 * 在 `visualization/` 下留下一个缺 `index.html` 的目录 —— 那种目录会让扫描列出一张点不开的卡片。
 *
 * @param {string} root 工作空间根
 * @param {'reference'|'prototype'} plane
 * @param {string} baseSlug 服务端生成的目录名
 * @param {string} stageDir 已经装好产物的临时目录
 * @returns {{ slug: string, dir: string, rel: string }}
 */
export function writeCaptureDir(root, plane, baseSlug, stageDir) {
  const planeDir = PLANE_DIR[plane];
  if (!planeDir) throw new Error(`未知的采集目标平面：${plane}`);

  // 平面目录本身可能还不存在（老工作空间没有 visualization/）——建它也在红线允许的范围内
  const planeAbs = resolveInside(root, planeDir);
  fs.mkdirSync(planeAbs, { recursive: true });

  let slug = baseSlug;
  let dirAbs = resolveInside(root, path.join(planeDir, slug));
  for (let n = 2; fs.existsSync(dirAbs); n += 1) {
    slug = `${baseSlug}-${n}`;
    dirAbs = resolveInside(root, path.join(planeDir, slug));
    if (n > 999) throw new Error('同名目录太多了，换个页面标题再采');
  }

  // 先整体移入；跨盘（缓存在 ~ 、工作空间在别的卷）时 rename 会 EXDEV，退回拷贝
  try {
    fs.renameSync(stageDir, dirAbs);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(stageDir, dirAbs, { recursive: true });
    fs.rmSync(stageDir, { recursive: true, force: true });
  }

  return { slug, dir: dirAbs, rel: `${planeDir.split(path.sep).join('/')}/${slug}` };
}

/** 临时目录:看板自家缓存,不在工作空间里。 */
function makeStageDir() {
  const root = path.join(CONFIG_DIR, 'capture-tmp');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'cap-'));
}

function dropStageDir(stageDir) {
  try {
    fs.rmSync(stageDir, { recursive: true, force: true });
  } catch {
    // 清不掉只是留个临时目录在缓存里，不该因此让任务失败
  }
}

// ── single-file 子进程 ───────────────────────────────────────────────────────

/**
 * 只认**起子进程时**的 ENOENT（PATH 上没有 single-file）。
 *
 * 不能直接判 `err.code === 'ENOENT'`：读产物用的 `fs.statSync` 在「single-file 跑完了
 * 但没落盘」时抛的也是 ENOENT，那种情况是**目标页没抓到**，不是没装工具。
 * 混在一起的话，一个连不上的地址会被报成「请先装 single-file」，把人指向错误的方向。
 */
function isMissingBinary(err) {
  return Boolean(err && typeof err === 'object' && err.missingBinary === true);
}

/** 起一次 single-file。超时先 SIGTERM，1.5s 后 SIGKILL。 */
function runSingleFileOnce(url, outputPath) {
  return new Promise((resolve, reject) => {
    // --filename-conflict-action=overwrite：默认 uniquify 会在目标已存在时改写成
    // `index (2).html`，导致目录里出现两份 HTML 且读 index.html 取错文件。
    // 我们的临时目录本来就是空的，但把这条一起搬过来，免得将来重试时踩到。
    const args = ['--filename-conflict-action=overwrite', url, outputPath];
    let child;
    try {
      child = spawn('single-file', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      if (err?.code === 'ENOENT') err.missingBinary = true;
      return reject(err);
    }
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 1500);
    }, SINGLE_FILE_TIMEOUT_MS);

    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (err) => {
      clearTimeout(timer);
      // spawn 自己失败：ENOENT = PATH 上根本没有这个命令，打上标记供上层区分
      if (err?.code === 'ENOENT') err.missingBinary = true;
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new Error(`抓取超时：single-file 跑了 ${SINGLE_FILE_TIMEOUT_MS / 1000} 秒还没结束，已经杀掉。`));
      }
      if (code === 0) return resolve();
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      reject(new Error(detail || `single-file 以退出码 ${code} 结束`));
    });
  });
}

/**
 * 抓自包含 HTML。
 *
 * **「退出码 0 但没产物」的重试逻辑连注释一起从相邻仓搬过来:**
 * single-file-cli 在 SPA 水合期有偶发竞态(「Execution context not found」):退出码仍为 0
 * 但不落盘任何文件,实测同命令重跑即成功。故以**「读到产物」为成败判据**,失败重试一次。
 */
async function captureWithSingleFile(url, outputPath) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await runSingleFileOnce(url, outputPath);
    } catch (err) {
      if (isMissingBinary(err)) throw err; // 没装 single-file，重试无意义
      lastError = err;
      continue;
    }
    try {
      const stats = fs.statSync(outputPath);
      if (stats.size > MAX_HTML_BYTES) {
        // 产物过大是确定性结论，重试没有意义
        throw Object.assign(
          new Error(
            `抓下来的页面有 ${(stats.size / 1024 / 1024).toFixed(1)} MB，超过 ${MAX_HTML_BYTES / 1024 / 1024} MB 上限，没有写入工作空间。`
              + '这种体积通常意味着页面里嵌了大量视频或大图，收进来只会拖垮之后每一次扫描。',
          ),
          { fatal: true },
        );
      }
      return stats.size;
    } catch (err) {
      if (err.fatal) throw err;
      // statSync 的 ENOENT 说的是「跑完了但没落盘」（SPA 水合期竞态），
      // 换成人话再往上抛，别让它冒充「没装 single-file」
      lastError = err.code === 'ENOENT'
        ? new Error('single-file 跑完了但没有产出文件（目标页可能没加载起来）')
        : err;
    }
  }
  throw lastError || new Error('single-file 没有产出文件');
}

// ── Playwright(可选) ────────────────────────────────────────────────────────

/**
 * `npm root -g` 的结果，进程内只问一次(问不到也记住,别每次采集都起一个 npm)。
 * @type {string | null | undefined} undefined = 还没问过；null = 问不到
 */
let globalNodeModulesCache;

/**
 * 找全局 node_modules。
 *
 * **不能从 `process.execPath` 推**：npm 的 prefix 和 node 的安装目录经常不是一回事
 * (实测本机 node 在 `~/.hermes/node`、npm prefix 在 `~/.local`；nvm / volta /
 * 自定义 prefix 也都是这样)。文案让用户跑的是 `npm i -g playwright`，
 * 那就老老实实问 npm 自己装到哪了 —— 推错等于文案骗人。
 */
async function globalNodeModules() {
  if (globalNodeModulesCache !== undefined) return globalNodeModulesCache;
  globalNodeModulesCache = await new Promise((resolve) => {
    let child;
    try {
      child = spawn('npm', ['root', '-g'], { stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' });
    } catch {
      return resolve(null);
    }
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const dir = out.trim().split('\n').pop()?.trim() || '';
      resolve(code === 0 && dir ? dir : null);
    });
  });
  return globalNodeModulesCache;
}

/**
 * 运行时探测 Playwright。
 *
 * 先按普通模块名 import(用户把它装进了看板的依赖树时命中);
 * 不成再去全局 node_modules 找 —— 文案让用户跑的是 `npm i -g playwright`,
 * 而全局包不在本文件的 node_modules 查找链上,不补这一档等于文案骗人。
 * 两条都不成就返回 null,整体降级(不报错、不阻塞)。
 */
async function loadPlaywright() {
  try {
    return unwrapPlaywright(await import('playwright'));
  } catch {
    // 落到全局目录再试
  }
  const globalRoot = await globalNodeModules();
  if (!globalRoot) return null;
  const entry = path.join(globalRoot, 'playwright', 'index.js');
  try {
    if (!fs.existsSync(entry)) return null;
    return unwrapPlaywright(await import(pathToFileURL(entry).href));
  } catch {
    return null;
  }
}

/**
 * playwright 的入口是 CommonJS：用 ESM `import()` 拿到的命名空间里
 * **没有** `chromium`（Node 的 CJS 命名导出静态分析认不出来），真东西在 `default` 上。
 * 不做这层解包，探测会「成功」但 `playwright.chromium` 是 undefined，
 * 于是每次采集都在截图那一步抛错、静默降级 —— 装了也等于没装。
 */
function unwrapPlaywright(mod) {
  if (mod?.chromium) return mod;
  if (mod?.default?.chromium) return mod.default;
  return null;
}

/**
 * 起一个 browser 跑一段活，**无论成功、失败还是整体超时都在 `finally` 里关掉它**。
 *
 * 关的动作必须落在这一层：`withTimeout` 只是让外层 race 先返回，被它甩掉的那个 promise
 * 还在后台跑；如果把 close 写在里面那段活自己的 finally 里，超时后浏览器要等到
 * 那段活自己了结才关。看板是本机常驻的长命进程，这条不看住就是几天后内存里躺着十个 Chromium。
 */
async function withBrowser(playwright, label, timeoutMs, fn) {
  const browser = await playwright.chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  try {
    return await withTimeout(fn(browser), timeoutMs, label);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（${ms / 1000} 秒）`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * 导航并等页面稳定:优先 networkidle;挂着持续打点(GTM/GA 心跳)的页面可能永远凑不出
 * 500ms 网络静默,超时则降级以 load 重试一次。(照搬相邻仓,那边是踩过的实案。)
 */
async function gotoSettled(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS });
  } catch {
    await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
  }
  await page.waitForTimeout(SETTLE_AFTER_LOAD_MS);
}

/**
 * 三档截图,**每一档各自 try**:单档失败只丢那一档,已经落盘的不受影响,任务不因此判失败。
 *
 * 一处故意偏离相邻仓:**mobile 不做响应式探测,三张都截**。
 * 不响应式的页面截出来是「它在手机上就是这样」,本身就是有用的信息,
 * 还省掉一段会误判的探测代码。
 *
 * 每次采集起一个 browser,`finally` 里必关(超时也要关)——
 * 看板是本机常驻的长命进程,这条不看住就是几天后内存里躺着十个 Chromium。
 *
 * @returns {Promise<{ shots: string[], title: string }>}
 */
async function captureScreenshots(browser, url, stageDir) {
  const shotsDir = path.join(stageDir, 'screenshots');
  fs.mkdirSync(shotsDir, { recursive: true });
  const shots = [];
  let title = '';
  {
    const page = await browser.newPage({ viewport: { ...HERO_VIEWPORT } });
    await gotoSettled(page, url);
    try {
      title = (await page.title()) || '';
    } catch {
      title = '';
    }

    for (const [kind, viewport, fullPage] of [
      ['hero', HERO_VIEWPORT, false],
      ['full', FULL_VIEWPORT, true],
      ['mobile', MOBILE_VIEWPORT, true],
    ]) {
      try {
        await page.setViewportSize(viewport);
        await page.screenshot({ path: path.join(shotsDir, `${kind}.png`), fullPage });
        shots.push(`screenshots/${kind}.png`);
      } catch {
        // 单档失败只丢这一档；写了一半的 png 一并删掉，别让扫描列出一张破图
        try {
          fs.rmSync(path.join(shotsDir, `${kind}.png`), { force: true });
        } catch {
          /* 删不掉就算了 */
        }
      }
    }
  }
  return { shots, title };
}

/** 原型只要一张封面(首屏视口,不要长图)。同样每次起一个 browser、finally 必关。 */
async function captureCover(browser, url, stageDir) {
  let title = '';
  let cover = false;
  {
    const page = await browser.newPage({ viewport: { ...HERO_VIEWPORT } });
    await gotoSettled(page, url);
    try {
      title = (await page.title()) || '';
    } catch {
      title = '';
    }
    await page.screenshot({ path: path.join(stageDir, 'cover.png'), fullPage: false });
    cover = true;
  }
  return { cover, title };
}

/** 从抓下来的 index.html 里取 <title>，和 references.mjs 的读法一致。 */
function readHtmlTitle(indexAbs) {
  try {
    const head = fs.readFileSync(indexAbs, 'utf8').slice(0, 8000);
    return head.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || '';
  } catch {
    return '';
  }
}

// ── 两条采集路径 ─────────────────────────────────────────────────────────────

/**
 * 参考:index.html(必须)+ 三档截图(可选)+ meta.json。
 * 缺 single-file → 抛错(任务失败);缺 playwright → 降级但成功。
 */
async function runReferenceCapture(root, url) {
  const stageDir = makeStageDir();
  try {
    const indexAbs = path.join(stageDir, 'index.html');
    try {
      await captureWithSingleFile(url, indexAbs);
    } catch (err) {
      if (isMissingBinary(err)) {
        throw Object.assign(new Error(MISSING_SINGLE_FILE), { missingTool: 'single-file' });
      }
      throw err;
    }

    const degraded = [];
    let shots = [];
    let pageTitle = '';
    let shotError = '';
    const playwright = await loadPlaywright();
    if (!playwright) {
      degraded.push('screenshots');
    } else {
      try {
        const outcome = await withBrowser(playwright, '截图', SCREENSHOT_TIMEOUT_MS, (browser) =>
          captureScreenshots(browser, url, stageDir));
        shots = outcome.shots;
        pageTitle = outcome.title;
      } catch (err) {
        // 截图整体失败 / 超时：只丢截图这一档，index.html 照常落盘。
        // **但一定要留痕** —— 相邻仓吃过静默吞错的亏，现场失因不可考。
        shotError = err?.message || String(err);
        console.warn('[capture] 截图整档失败，按降级处理：', shotError);
        shots = [];
      }
      if (shots.length < 3) degraded.push('screenshots');
      if (!shots.length) {
        // 一张都没有就别留空目录，免得扫描以为有截图
        fs.rmSync(path.join(stageDir, 'screenshots'), { recursive: true, force: true });
      }
    }

    const title = readHtmlTitle(indexAbs) || pageTitle || '';
    const meta = {
      title: title || slugify('', url),
      sourceUrl: url,
      capturedAt: new Date().toISOString(),
      source: 'url-capture',
      // 采集没有脱敏管线：抓到什么就是什么。这个字段只是告知读到它的 AI，**不是安全保证**
      scrubbed: false,
      screenshots: shots,
      ...(degraded.length ? { degraded } : {}),
    };
    fs.writeFileSync(path.join(stageDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

    const written = writeCaptureDir(root, 'reference', slugify(title, url), stageDir);
    return {
      slug: written.slug,
      rel: written.rel,
      title: meta.title,
      degraded,
      degradedHint: degraded.includes('screenshots')
        ? (playwright
          ? `这次没能截全三张图，参考本体已经收下了。${shotError ? `原因：${shotError}` : ''}`
          : MISSING_PLAYWRIGHT)
        : '',
    };
  } finally {
    // 成功时 stageDir 已经被移走，rm 是空操作；失败时这一句保证不留半成品
    dropStageDir(stageDir);
  }
}

/**
 * 原型 URL 导入:**只写 meta.json + 可选 cover.png,绝不抓页面 HTML**。
 * 云端发布的原型是 SPA,抓下来既失真又没意义 —— 用户点它就是要开那个原站。
 * Playwright 不可用时仍写 meta.json 并判成功,只是没有封面。
 */
async function runPrototypeImport(root, url) {
  const stageDir = makeStageDir();
  try {
    const degraded = [];
    let pageTitle = '';
    let coverError = '';
    const playwright = await loadPlaywright();
    if (!playwright) {
      degraded.push('cover');
    } else {
      try {
        const outcome = await withBrowser(playwright, '封面截图', SCREENSHOT_TIMEOUT_MS, (browser) =>
          captureCover(browser, url, stageDir));
        pageTitle = outcome.title;
        if (!outcome.cover) degraded.push('cover');
      } catch (err) {
        coverError = err?.message || String(err);
        console.warn('[capture] 封面截图失败，按降级处理：', coverError);
        degraded.push('cover');
        fs.rmSync(path.join(stageDir, 'cover.png'), { force: true });
      }
    }

    const title = pageTitle || slugify('', url);
    const meta = {
      kind: 'url',
      title,
      // target 原样保存用户贴的地址：点卡片开的就是这条
      target: url,
      capturedAt: new Date().toISOString(),
      source: 'url-capture',
      ...(degraded.length ? { degraded } : {}),
    };
    fs.writeFileSync(path.join(stageDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

    const written = writeCaptureDir(root, 'prototype', slugify(pageTitle, url), stageDir);
    return {
      slug: written.slug,
      rel: written.rel,
      title,
      degraded,
      degradedHint: degraded.includes('cover')
        ? (playwright
          ? `这次没能截到封面，链接已经收下了，卡片走窗框占位。${coverError ? `原因：${coverError}` : ''}`
          : MISSING_PLAYWRIGHT_COVER)
        : '',
    };
  } finally {
    dropStageDir(stageDir);
  }
}

// ── 任务表 ───────────────────────────────────────────────────────────────────

function jobView(job) {
  if (!job) {
    return {
      status: 'idle',
      plane: '',
      target: '',
      message: '',
      startedAt: '',
      finishedAt: '',
      slug: '',
      sourcePath: '',
      degraded: [],
      degradedHint: '',
    };
  }
  return {
    status: job.status,
    plane: job.plane,
    target: job.target,
    message: job.message || '',
    startedAt: job.startedAt || '',
    finishedAt: job.finishedAt || '',
    slug: job.slug || '',
    sourcePath: job.sourcePath || '',
    degraded: job.degraded || [],
    degradedHint: job.degradedHint || '',
  };
}

export function captureStatus(projectId) {
  return jobView(captureJobs.get(projectId));
}

/**
 * 发起一次采集。立刻返回 running,进度靠 GET 轮询;落盘会被 `visualization/` 的 SSE 捕获,
 * 清单自己刷新。
 *
 * @param {{ id: string, root: string }} project
 * @param {'reference'|'prototype'} plane
 * @param {string} rawUrl 用户贴的地址(**只取这一个字段**,请求体里别的路径字段一律忽略)
 */
export function startCapture(project, plane, rawUrl) {
  if (plane !== 'reference' && plane !== 'prototype') {
    const err = new Error('采集目标只能是参考或原型');
    err.statusCode = 400;
    throw err;
  }
  const url = normalizeTargetUrl(rawUrl);
  if (!url) {
    const err = new Error('请贴一条 http / https 开头的网址');
    err.statusCode = 400;
    throw err;
  }

  const existing = captureJobs.get(project.id);
  if (existing?.status === 'running') {
    const err = new Error(
      `这个工作空间已有采集在进行中（${existing.target}），等这一轮结束再试。`,
    );
    err.statusCode = 409;
    throw err;
  }

  const job = {
    status: 'running',
    plane,
    target: url,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    slug: '',
    sourcePath: '',
    degraded: [],
    degradedHint: '',
    message: plane === 'reference'
      ? `正在采集 ${url} … 抓页面加截图通常要十几秒到一分钟。`
      : `正在导入 ${url} … 只截一张封面，通常十几秒。`,
  };
  captureJobs.set(project.id, job);

  const work = plane === 'reference'
    ? runReferenceCapture(project.root, url)
    : runPrototypeImport(project.root, url);

  work.then(
    (result) => {
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      job.slug = result.slug;
      job.sourcePath = result.rel;
      job.degraded = result.degraded;
      job.degradedHint = result.degradedHint;
      job.message = plane === 'reference'
        ? `已收进 ${result.rel}/`
        : `已收进 ${result.rel}/，卡片点击开的是原站`;
    },
    (err) => {
      job.status = 'error';
      job.finishedAt = new Date().toISOString();
      // 原样把工具给的原因带出去，不写「操作失败请重试」这类空话
      job.message = err?.message || '采集失败，但没拿到原因';
    },
  );

  return jobView(job);
}

/** 给外部(冒烟脚本 / 将来的插件接收端)判定平面用,不必再抄一份字面量。 */
export const CAPTURE_PLANES = Object.keys(PLANE_DIR);

/** 缺工具的安装命令也导出:接口层要把它带给前端,前端不硬编码第二份。 */
export const CAPTURE_TOOL_HINTS = {
  singleFile: { install: SINGLE_FILE_INSTALL, missing: MISSING_SINGLE_FILE },
  playwright: { install: PLAYWRIGHT_INSTALL, missing: MISSING_PLAYWRIGHT },
};
