/**
 * 采集包接收端 —— annotation-collect 扩展的投递落点。
 *
 * ## 这条路和贴 URL 采集的分工
 * `capture.mjs` 走公开页面(headless 重抓);这条走**登录后的深层页面** ——
 * 扩展跑在页面自己的上下文里,会话是真的、当前视图状态是真的,
 * 不需要往 headless 里注 cookie / storageState(相邻仓 acgogogo 在那条路上栽过:
 * SPA 把 token 放 localStorage,single-file 只注入 cookies,抓下来的是登录页)。
 *
 * ## 契约不在本仓,照着实现的一端
 * - **契约 C**(`annotation-collect/packages/collect/src/format.ts`)—— 包的形状:
 *   `format` / `version` / `manifest.json` / `summary.md` / 载荷四种。
 * - **契约 D**(同仓 `deliver.ts`)—— 投递:请求体 `{ package, triggeredAt }`,
 *   成功回 `{ accepted: true, location, hostItemId }`,非 2xx 让扩展走 `refused-by-host`
 *   分支(**它会保留批次不清空**,所以这里宁可干净地拒,也不要半解析)。
 *
 * 路径与端口照抄扩展默认值(`http://127.0.0.1:7788/capture-package`),
 * **不加 `/api` 前缀** —— 否则每个用户装完扩展第一件事是去改配置。
 *
 * ## 只读红线
 * 写入范围与 `visual-capture-engine` 拍板的窄例外**一模一样**,一寸不扩:
 * 只写 `visualization/references/<slug>/`、只新建不覆盖、slug 由服务端生成、
 * 包里带来的每一条相对路径都先过 `resolveInside()`。
 * **看板不生成包里没有的内容** —— 一个包里连一份 HTML 都没有时拒收,不自己造 index.html。
 */
import fs from 'node:fs';
import path from 'node:path';
import { MAX_CAPTURE_BYTES, dropStageDir, makeStageDir, slugifyCapture, writeCaptureDir } from './capture.mjs';
import { resolveInside } from './paths.mjs';

/** 扩展硬编码的投递路径。改这里等于让所有已装的扩展失联,别改。 */
export const CAPTURE_PACKAGE_PATH = '/capture-package';

/** 契约 C 的格式标识与本机认到的最高版本。 */
const KNOWN_FORMAT = 'annotation-collect.capture-package';
const KNOWN_VERSION = 1;

/** 看板自己写的那一个文件；包里同名的载荷不许覆盖它。 */
const META_FILE = 'meta.json';
const INDEX_FILE = 'index.html';

function fail(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

/**
 * 读投递请求体,**边读边数字节**。
 * 先攒完再量的话,一个几百 MB 的包已经把内存吃掉了才轮到拒绝。
 *
 * 超限之后**不 `destroy()`,改成把剩下的字节读掉丢掉**:
 * 一断连接,客户端拿到的是「连接被重置」,扩展会判成 `target-unreachable`
 * (「看板没在监听」)并提示用户去启动服务 —— 那是条误导人的岔路。
 * 我们要它走 `refused-by-host`,看到真正的原因,所以这个 4xx 必须送达。
 * 丢掉的 chunk 不进数组,内存是平的,读完多少都不涨。
 */
export async function readPackageBody(req, limit = MAX_CAPTURE_BYTES) {
  const chunks = [];
  let size = 0;
  let oversize = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) oversize = true;
    if (!oversize) chunks.push(chunk);
    else chunks.length = 0;
  }
  if (oversize) {
    throw fail(413, `采集包超过 ${Math.round(limit / 1024 / 1024)} MB 的上限，没有接收。`
      + '一份带整页快照的包通常在几 MB 量级；这么大多半是把不该内联的东西一起抓进来了。');
  }
  if (!size) throw fail(400, '投递请求没有请求体。');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw fail(400, '投递请求体不是合法的 JSON，没有接收。');
  }
}

/**
 * 契约 C 的第一道关 —— 只看外层字段,不深挖。
 * 语义与相邻仓 `inspectPackage()` 保持一致,不认识就明确拒,**绝不"尽力解析一下试试"**:
 * 那会把一次干净的拒绝变成一堆半截数据。
 */
function requireKnownPackage(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw fail(400, '这不是一个采集包：请求体里没有 package.manifest。');
  }
  if (manifest.format !== KNOWN_FORMAT) {
    throw fail(400, `这不是一个采集包：format 是「${String(manifest.format ?? '(缺)')}」，`
      + `看板只接收 ${KNOWN_FORMAT}。`);
  }
  const version = manifest.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw fail(400, '这不是一个采集包：version 字段不是正整数。');
  }
  if (version > KNOWN_VERSION) {
    throw fail(400, `这个包是 v${version}，当前看板只认到 v${KNOWN_VERSION}。`
      + '批次没有被接收，请升级看板后再投一次。');
  }
  return version;
}

/**
 * 把投递过来的文件内容还原成字节。
 *
 * 契约 C 的 `content` 是 `string | Uint8Array`,而投递走的是 `JSON.stringify` ——
 * 文本原样过来,`Uint8Array`(截图那类)会被序列化成 `{"0":12,"1":34,…}`。
 * 两种形态都收;**认不出来的形态一律丢弃并记进说明,不猜**。
 */
function toBytes(content) {
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  if (Array.isArray(content)) return Buffer.from(Uint8Array.from(content));
  if (content && typeof content === 'object') {
    const keys = Object.keys(content);
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      const bytes = new Uint8Array(keys.length);
      for (const k of keys) bytes[Number(k)] = content[k];
      return Buffer.from(bytes);
    }
  }
  return null;
}

/** 清单里按 role 索引路径。清单坏了就当没有,不抛 —— 抛了会把一个能落的包拒掉。 */
function roleOf(manifest, filePath) {
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const hit = files.find((f) => f && f.path === filePath);
  return hit && typeof hit.role === 'string' ? hit.role : '';
}

/**
 * 挑出当 `index.html` 的那一份:先整页快照,没有就第一个元素片段。
 * 两者都没有 → 拒收。**绝不自己造一个 index.html**(只读红线:写进去的每个字节都得是包里带来的)。
 */
function pickIndexPath(manifest, contents) {
  const paths = contents.map((f) => f.path);
  const page = paths.find((p) => roleOf(manifest, p) === 'page-html');
  if (page) return page;
  const fragment = paths.find((p) => roleOf(manifest, p) === 'fragment-html');
  if (fragment) return fragment;
  return '';
}

/** 来源页面地址:优先取第一条载荷的出处 URL,退回站点 origin。 */
function sourceUrlOf(manifest) {
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  for (const item of items) {
    const url = item?.anchor?.provenance?.url;
    if (typeof url === 'string' && url) return url;
  }
  const origin = manifest.site?.origin;
  return typeof origin === 'string' ? origin : '';
}

/**
 * 收一个采集包,落成一份参考条目。
 *
 * @param {{ id: string, name: string, root: string }} project 目标工作空间
 * @param {any} body 契约 D 的请求体 `{ package, triggeredAt }`
 * @returns {{ accepted: true, location: string, hostItemId: string }}
 */
export function receiveCapturePackage(project, body) {
  const pkg = body?.package;
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw fail(400, '投递请求体里没有 package 字段，按契约 D 应该是 { package, triggeredAt }。');
  }
  const manifest = pkg.manifest;
  const version = requireKnownPackage(manifest);

  const contents = (Array.isArray(pkg.files) ? pkg.files : []).filter(
    (f) => f && typeof f.path === 'string' && f.path,
  );
  const indexPath = pickIndexPath(manifest, contents);
  if (!indexPath) {
    throw fail(400, '这个包里没有可展示的页面（既没有整页快照，也没有元素片段），没有接收。'
      + '看板只会把包里带来的页面落盘，不会替你生成一份。'
      + '请在扩展里至少采一次整页快照或一个元素片段再投。');
  }

  // 落盘前先在看板自家缓存里摆好，失败 / 越界都不会在 visualization/ 下留半截目录
  const stageDir = makeStageDir();
  const skipped = [];
  try {
    for (const file of contents) {
      const isIndex = file.path === indexPath;
      // 保留名：meta.json 是看板自己写的；index.html 只让选中的那一份占
      if (!isIndex && (file.path === META_FILE || file.path === INDEX_FILE)) {
        skipped.push(`${file.path}（与看板自己的文件重名）`);
        continue;
      }
      let abs;
      try {
        // 清单里的相对路径**一律先过闸**：夹带 ../ 或绝对路径的条目在这里被挡下
        abs = resolveInside(stageDir, isIndex ? INDEX_FILE : file.path);
      } catch {
        skipped.push(`${file.path}（路径越出了条目目录）`);
        continue;
      }
      const bytes = toBytes(file.content);
      if (bytes === null) {
        skipped.push(`${file.path}（内容不是文本也不是字节数组）`);
        continue;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, bytes);
    }

    // 清单没随文件一起投来时，把请求体里的那份原样序列化补上（字段顺序按 JSON 解析后的原序，
    // 不重排、不补字段）—— 没有清单的话，这个包对 AI 那一半读者就是瞎的
    const manifestAbs = path.join(stageDir, 'manifest.json');
    if (!fs.existsSync(manifestAbs)) {
      fs.writeFileSync(manifestAbs, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    }

    const site = manifest.site && typeof manifest.site === 'object' ? manifest.site : {};
    const sourceUrl = sourceUrlOf(manifest);
    const meta = {
      source: 'plugin',
      title: typeof site.title === 'string' ? site.title : '',
      sourceUrl,
      // 如实反映包里的值。**不改写成「已脱敏」「安全」这类说法** ——
      // 那边的脱敏是尽力而为的模式匹配，措辞变强等于替它做了它拒绝做的承诺
      scrubbed: manifest.redaction?.enabled === true,
      // 包自带的免责声明，原文照搬，一个字不动
      notice: typeof manifest.notice === 'string' ? manifest.notice : '',
      capturedAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : '',
      deliveredAt: typeof body?.triggeredAt === 'string' ? body.triggeredAt : new Date().toISOString(),
      package: {
        format: manifest.format,
        version,
        packageId: typeof manifest.packageId === 'string' ? manifest.packageId : '',
        generator: manifest.generator && typeof manifest.generator === 'object' ? manifest.generator : {},
        // 清单里指着 index.html 那一份的原路径。不记的话，清单里的引用会看着像断链
        indexFrom: indexPath,
      },
    };
    if (skipped.length) meta.skippedFiles = skipped;
    fs.writeFileSync(path.join(stageDir, META_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

    // slug 由服务端生成（沿用贴 URL 采集那一套），客户端传来的任何路径片段都不参与
    const baseSlug = slugifyCapture(site.title, sourceUrl);
    const written = writeCaptureDir(project.root, 'reference', baseSlug, stageDir);

    let location = `工作空间「${project.name}」→ ${written.rel}/`;
    if (skipped.length) location += `（有 ${skipped.length} 个文件没落盘：${skipped.join('；')}）`;

    return { accepted: true, location, hostItemId: written.slug };
  } catch (err) {
    dropStageDir(stageDir);
    throw err;
  }
}
