/**
 * 能力注册表 + 统一闸 —— 看板一切写盘 / 起子进程的唯一登记处。
 *
 * 看板对工作空间的写入只走 AGENTS.md 第 1 节「能力清单」里的能力，每项都满足六条安全链路
 * (发起 / 来源 / 寻址 / 写入面 / 执行者 / 可回退)。这里是那份清单在代码里的镜像:
 *   - `scope: 'workspace'` 会写工作空间,与 AGENTS.md 清单按标识一一对应;
 *   - `scope: 'local'` 只动本机状态(注册表、看板缓存、系统弹窗),不进清单但同样过闸。
 *
 * `CAPABILITIES` 必须保持**纯对象字面量**:`scripts/check-capabilities.mjs` 直接 import 它,
 * 拿 `modules` 当「允许出现 fs 写 / spawn 的模块」白名单,拿 `workspace` 标识去比对 AGENTS.md。
 * 新增写能力:这里登记 → 路由调 `guardCapability` → AGENTS.md 清单加一行 → 写 spec → 跑 `pnpm test:capabilities`。
 */

/**
 * @typedef {{
 *   name: string,
 *   scope: 'workspace' | 'local',
 *   executor: 'spawn' | 'direct',
 *   modules: string[],
 *   spec: string | null,
 *   deviation?: string,
 *   allowExtensionOrigin?: boolean,
 * }} Capability
 */

/** @type {Record<string, Capability>} */
export const CAPABILITIES = {
  // ── 写工作空间(与 AGENTS.md 能力清单一一对应) ─────────────────────────
  'workspace-init': {
    name: '新建工作空间',
    scope: 'workspace',
    executor: 'spawn',
    modules: ['http.mjs'],
    spec: 'workspace-template-update',
  },
  'raw-ingest': {
    name: '资料转换',
    scope: 'workspace',
    executor: 'spawn',
    modules: ['http.mjs', 'platform.mjs'],
    spec: 'raw-source-status',
  },
  'db-schema-refresh': {
    name: '刷新 schema',
    scope: 'workspace',
    executor: 'spawn',
    modules: ['http.mjs', 'platform.mjs'],
    spec: 'database-source',
  },
  'visual-capture': {
    name: '贴 URL 采集',
    scope: 'workspace',
    executor: 'direct',
    modules: ['capture.mjs'],
    spec: 'visual-capture',
  },
  'capture-package-inbox': {
    name: '采集包接收',
    scope: 'workspace',
    executor: 'direct',
    modules: ['capture-inbox.mjs', 'capture.mjs'],
    spec: 'capture-package-inbox',
    deviation: '发起:由浏览器扩展投递触发,不在看板上点;来源:放行浏览器扩展来源。'
      + '补偿:写入面只有 visualization/references/<slug>/ 且只新建,包先过契约校验。',
    allowExtensionOrigin: true,
  },
  'prototype-refresh': {
    name: '刷新原型',
    scope: 'workspace',
    executor: 'spawn',
    modules: ['http.mjs'],
    spec: 'prototype-refresh',
    deviation: '写入面:脚本写工作空间外原型目录的 .workspace-inbox.md。'
      + '补偿:原型目录必须经 .workspace-link.json 回指本工作空间,脚本名与参数由服务端固定。',
  },
  'question-feedback': {
    name: '保存未决问题',
    scope: 'workspace',
    executor: 'direct',
    modules: ['questions.mjs', 'patchMarkdown.mjs'],
    spec: 'open-questions-workbench',
  },
  'reference-inbox-refresh': {
    name: '刷新参考收件箱',
    scope: 'workspace',
    executor: 'spawn',
    modules: ['http.mjs', 'platform.mjs'],
    spec: 'reference-inbox-refresh',
  },
  'record-status': {
    name: '保存产出物状态',
    scope: 'workspace',
    executor: 'direct',
    modules: ['records.mjs', 'patchMarkdown.mjs'],
    spec: 'output-item-workbench',
  },
  'record-notes': {
    name: '批注落盘',
    scope: 'workspace',
    executor: 'direct',
    modules: ['notes.mjs'],
    spec: 'annotation-status-loop',
  },
  'output-archive': {
    name: '一次归档',
    scope: 'workspace',
    executor: 'spawn',
    modules: ['http.mjs', 'platform.mjs'],
    spec: 'output-archive',
  },
  'feedback-sent': {
    name: '反馈单发送记录',
    scope: 'workspace',
    executor: 'direct',
    modules: ['feedback.mjs', 'patchMarkdown.mjs'],
    spec: 'workbench-feedback',
  },
  'docx-template-refine': {
    name: '提炼 Word 模板',
    scope: 'workspace',
    executor: 'spawn',
    modules: ['docxTools.mjs', 'platform.mjs'],
    spec: 'docx-template-refine',
  },
  'md-docx-export': {
    name: '转成 Word',
    scope: 'workspace',
    executor: 'spawn',
    modules: ['docxTools.mjs', 'platform.mjs'],
    spec: 'md-docx-export',
  },
  'delivery-finalize': {
    name: '交付稿定稿',
    scope: 'workspace',
    executor: 'spawn',
    modules: ['finalize.mjs', 'docxTools.mjs', 'platform.mjs'],
    spec: 'delivery-finalize',
    deviation: '写入面:读用户在系统选文件框里亲手选中的一个工作空间外 .docx。'
      + '补偿:路径只在服务端内存,前端只拿一次性令牌;不提供按路径读外部文件的接口;记录里只写原文件名。',
  },
  'output-rename': {
    name: '产出原稿重命名',
    scope: 'workspace',
    executor: 'spawn',
    modules: ['http.mjs', 'docxTools.mjs', 'platform.mjs'],
    spec: 'output-rename',
  },
  'converted-copy-to-output': {
    name: '转换产物复制到产出',
    scope: 'workspace',
    executor: 'spawn',
    modules: ['http.mjs', 'docxTools.mjs', 'platform.mjs'],
    spec: 'converted-copy-to-output',
  },
  'raw-source-organize': {
    name: '原始资料重命名 / 移动',
    scope: 'workspace',
    executor: 'spawn',
    modules: ['http.mjs', 'docxTools.mjs', 'platform.mjs'],
    spec: 'raw-source-organize',
  },

  // ── 只动本机状态(不进 AGENTS.md 清单,同样过闸) ──────────────────────
  'project-registry': {
    name: '工作空间登记 / 修改 / 移出',
    scope: 'local',
    executor: 'direct',
    modules: ['config.mjs'],
    spec: null,
  },
  'directory-picker': {
    name: '系统目录选择框',
    scope: 'local',
    executor: 'spawn',
    modules: ['platform.mjs'],
    spec: 'directory-picker',
  },
  'reveal-in-system': {
    name: '在系统里打开 / 定位',
    scope: 'local',
    executor: 'spawn',
    modules: ['platform.mjs'],
    spec: null,
  },
  'note-history-cache': {
    name: '没有记录时的批注缓存',
    scope: 'local',
    executor: 'direct',
    modules: ['note-history.mjs'],
    spec: 'annotation-status-loop',
  },
  // 下面两项没有写接口:伺服 zip 原型时解压到缓存、启动时读 git 版本。登记只为让检查脚本放行这两个模块
  'prototype-zip-cache': {
    name: '原型 zip 解压缓存',
    scope: 'local',
    executor: 'spawn',
    modules: ['prototypes.mjs'],
    spec: 'prototype-preview',
  },
  'version-probe': {
    name: '读源码 git 版本',
    scope: 'local',
    executor: 'spawn',
    modules: ['version.mjs'],
    spec: null,
  },
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * 会起子进程或写盘的接口：监听非环回地址时一律拒绝。
 * 看板没有鉴权，`--host 0.0.0.0` 是给评审只读分享用的，不能变成局域网里的可执行入口。
 */
function rejectIfRemoteWrite(res, allowMutations) {
  if (allowMutations) return false;
  json(res, 403, {
    error: '当前服务监听的不是本机回环地址，已禁用会改动本机状态的操作'
      + '（新建 / 登记 / 转换资料等）。只读浏览不受影响；'
      + '要在看板里操作，请用默认的 127.0.0.1 再起一次服务。',
  });
  return true;
}

/**
 * **来源判定 —— 所有会写盘 / 起子进程的接口共用这一个函数。**
 *
 * 环回 ≠ 可信:服务端没有 token,`readBody` 连 Content-Type 都不看,
 * 于是浏览器里**任意一个网页**都能用 `enctype="text/plain"` 的表单往 `127.0.0.1:<端口>` POST,
 * body 拼成合法 JSON 就被收下 —— 这种表单提交不触发预检,`allowMutations` 那条闸拦不住它。
 * 所以再加一道:请求表明自己来自别的站点时一律拒绝。
 *
 * 判据两条(浏览器一定会带其中之一,非浏览器客户端如 curl 两条都没有 → 放行):
 *   1. `Sec-Fetch-Site` 存在且不是 same-origin / none → 拒(cross-site、same-site 都拒);
 *   2. 没有该头但有 `Origin`,且 Origin 的 host 与本次请求的 Host 不同 → 拒。
 *
 * ## 扩展来源(实测过,不是猜的)
 * 装真实扩展跑一次投递,打到 `127.0.0.1` 的请求带的是:
 * `Origin: chrome-extension://<id>`、**`Sec-Fetch-Site: none`**、`Sec-Fetch-Mode: cors`,
 * 而且**没有预检**(`host_permissions` 让它不走网页那套 CORS)。
 *
 * `none` 这个值很要命:它会从上面第 1 条直接放行,第 2 条又因为该头存在而被跳过 ——
 * 也就是说**任何一个已装的扩展本来能打通全部写接口**。所以这里把扩展来源单独拎出来先判:
 * 只有采集包接收端(`/capture-package`)放行,其余一律拒。
 *
 * 头里没有能区分「我们这个扩展」和「别的扩展」的东西,放行只认协议。
 * 接受这个代价:扩展要用户自己装,而这条路的写入面只有 `visualization/references/<slug>/`,
 * 包还得先过契约 C 的校验 —— 比把它对所有网页敞开小得多。
 *
 * 只读接口(扫描、读文件、SSE)不过这道闸:它们不改本机状态,
 * 而只读分享(`--host`)场景本来就要能跨机器访问。
 *
 * @param {{ allowExtensionOrigin?: boolean }} [opts] 只由注册表里 `allowExtensionOrigin: true` 的能力(采集包接收)传 true
 * @returns {boolean} true = 已经回了 403，调用方直接 return
 */
function rejectIfForeignOrigin(req, res, { allowExtensionOrigin = false } = {}) {
  const site = req.headers['sec-fetch-site'];
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  // chrome-extension: / moz-extension: / safari-web-extension: 都以 -extension: 收尾
  if (/^[a-z][a-z0-9+.-]*-extension:$/i.test(origin.slice(0, origin.indexOf(':') + 1))) {
    if (allowExtensionOrigin) return false;
    json(res, 403, {
      error: `这个请求来自浏览器扩展（${origin}）。看板只在采集包接收端接受扩展投递，`
        + '其它操作请在看板自己的页面上做。',
    });
    return true;
  }
  if (site && site !== 'same-origin' && site !== 'none') {
    json(res, 403, {
      error: `这个请求来自其它站点（Sec-Fetch-Site: ${site}），看板不接受跨站的写操作。`
        + '请在看板自己的页面上操作。',
    });
    return true;
  }
  if (!site && req.headers.origin) {
    let originHost = '';
    try {
      originHost = new URL(req.headers.origin).host;
    } catch {
      originHost = '';
    }
    if (originHost !== (req.headers.host || '')) {
      json(res, 403, {
        error: `这个请求的来源（${req.headers.origin}）不是看板自己，已拒绝。请在看板自己的页面上操作。`,
      });
      return true;
    }
  }
  return false;
}

/**
 * 写接口的统一闸：先非环回禁写、再来源判定 —— 顺序与搬迁前每个路由手写的两行一致，
 * 调用方仍须在**读请求体之前**调它(该被拒的请求不该先把请求体读进内存)。
 * 扩展来源放不放行由注册表决定，调用方不能自己传。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} id 能力标识,必须已在 CAPABILITIES 登记
 * @param {{ allowMutations?: boolean }} opts
 * @returns {boolean} true = 已经回了 403 / 500，调用方直接 return
 */
export function guardCapability(req, res, id, { allowMutations }) {
  const capability = Object.hasOwn(CAPABILITIES, id) ? CAPABILITIES[id] : undefined;
  if (!capability) {
    // 路由写错标识是代码 bug：宁可这一个接口 500，也不能在没登记的情况下放行写入
    console.error(`[capabilities] 能力标识未登记：${id}（${req.method} ${req.url}）`);
    json(res, 500, { error: `服务端错误：能力「${id}」没有登记，已拒绝执行。` });
    return true;
  }
  if (rejectIfRemoteWrite(res, allowMutations)) return true;
  return rejectIfForeignOrigin(req, res, { allowExtensionOrigin: capability.allowExtensionOrigin === true });
}
