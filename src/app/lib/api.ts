export type ReaderKind =
  | 'markdown'
  | 'table'
  | 'image'
  | 'text'
  | 'html'
  | 'external'
  /** 一摞图片（input/assets/ 下的一个图库），预览区排缩略图，不是单个文件 */
  | 'gallery';

/**
 * 产出正文里的标注计数（约定见 templates/pm-aispace 的 pm-project-handover 技能）：
 * 推断 = 资料没写、AI 推出来的；口述待确认 = 来自会议或聊天；空白 = 该有结论但资料里没有。
 * 这三类是**有意留下的产出**，不是缺陷，所以界面上用中性灰，不上 orange。
 */
export interface Annotations {
  inferred: number;
  verbal: number;
  blank: number;
  total: number;
}

export interface FileItem {
  path: string;
  name: string;
  ext?: string;
  reader: ReaderKind;
  size: number;
  mtime: string;
  title?: string;
  words?: number;
  status?: string;
  date?: string;
  /** 按 input/.ingestignore 命中被忽略：不算待转换。旧服务进程没有这个字段。 */
  ignored?: boolean;
  /** 一条标注都没有时服务端不返回；旧服务进程也没有。缺了就什么都不显示。 */
  annotations?: Annotations;
}

export interface ConvertedItem extends FileItem {
  isDir: boolean;
  /**
   * 产物在目录树里的位置，相对 input/converted/。新布局下 converted/ 与 raw/ 同构，
   * 树就是资料自己的整理方式。可选：旧服务进程不返回它，缺了就退回按原件目录建树。
   */
  treePath?: string;
  /**
   * 摘要 `_manifest*.md` 的路径。新布局里摘要在镜像目录、正文在 SplittingObject/ 下，
   * 两者不同级，不能再按 `path + '/_manifest.md'` 拼。可选：旧服务进程不返回。
   */
  manifestPath?: string;
  sheets?: FileItem[];
  /** html 原型包：目录内可预览的 .html 相对路径 */
  htmlPath?: string;
  htmlName?: string;
  /** 点表等产物的 sqlite 路径（看板只展示路径/SQL 指南，不读二进制） */
  sqlitePath?: string;
  source?: string;
  /**
   * 产物记着的原件现在怎么样：'ok' = 还在且没动过，'missing' = 已被删掉或改名（溯源断了），
   * 'stale' = 还在，但 mtime 晚于产物（转换后动过，产物可能已经不对）。
   * 可选：产物没记 source 时服务端不返回，旧服务进程也没有 —— 缺了就什么都不显示，
   * 退回改动前的行为。注意 'missing' 不是错误：转完删原件省空间是正当用法，界面上按中性提示处理；
   * 'stale' 才要人重转一次，走 orange。它由 mtime 推断，会有误报，要坐实得调 verifySource。
   */
  sourceState?: 'ok' | 'missing' | 'stale';
  sourceSha256?: string;
  convertedBy?: string;
  convertedAt?: string;
  warning?: string;
  extractedImages?: number;
  /**
   * 哪些产出文档提到了这份资料（output/ 下的相对路径）。空数组 = 一篇都没提到。
   * 可选：旧服务进程不返回它，缺字段时前端不显示引用信息、也不报「零引用」，
   * 退回改动前的行为。
   */
  referencedBy?: string[];
}

/**
 * 一个数据源在 input/converted/_sources/<源名>/ 下的一份产物。
 * 形状与转换产物同构（服务端复用的就是同一个 describeConverted），多两种正文形态：
 *
 *  - 查询产物：结果 csv 挂在 `sheets` 上（一份产物一行，不拆成「摘要 + 结果」两行）；
 *  - 拆分了的 schema 快照：单表明细在 `tables` 里（SplittingObject/<表>.md）。
 */
export interface DatabaseSourceItem extends ConvertedItem {
  /**
   * 拆分了的 schema 快照的表数。任何情况下新服务都会给。
   * 大库上服务端不再下发 `tables`，前端优先读这个数、缺省回落 `tables?.length`。
   */
  tableCount?: number;
  /**
   * 拆分了的 schema 快照的单表明细。可选：没拆分、表数超过拆分阈值、或旧服务进程时缺省。
   * 大库上不要依赖它的 length，改读 `tableCount`。
   */
  tables?: FileItem[];
}

/**
 * 数据源的状态。'ok' 之外的三种都要在界面上标出来（走 orange），因为它们都要人去处理：
 *  - 'unsupported' 引擎本轮不支持（只做 PostgreSQL / MySQL）
 *  - 'unreadable'  这份 yaml 读不出来（语法错、缺 database）
 *  - 'orphan'      产物还在，但 input/sources/ 下没有对应的配置了
 */
export type DatabaseSourceState = 'ok' | 'unsupported' | 'unreadable' | 'orphan';

/**
 * input/sources/<源名>.yaml 描述的一个数据库源。
 *
 * **不含任何凭据** —— yaml 里本来就只写环境变量名，看板也绝不读工作空间的 `.env`
 * （读它的是工作空间自己的 scripts/db_ingest.py）。这个接口的响应里不会出现
 * 口令、token 或完整连接串。
 */
export interface DatabaseSource {
  /** 源名，也就是 yaml 的文件名（去掉 .yaml）。触发采集时传的就是它 */
  key: string;
  /** 显示名，yaml 里的 `name`；没写就退回源名 */
  name: string;
  state: DatabaseSourceState;
  /** state 不是 'ok' 时的中文原因，直接显示给用户 */
  stateReason?: string;
  /** 'postgresql' | 'mysql' | 用户写的任何值（那时 state 是 'unsupported'）。读不出配置时缺省 */
  engine?: string;
  database?: string;
  schemas?: string[];
  /** 配置文件的工作空间内相对路径。orphan 的源没有配置文件，所以可选 */
  configPath?: string;
  /** 产物目录 input/converted/_sources/<源名>。还没采过就缺省 */
  productDir?: string;
  /** schema 快照采于何时（快照 frontmatter 里的 converted_at）。没采过就缺省 */
  snapshotAt?: string;
  /** 这个源下的产物：schema 快照 + 查询产物。没采过是空数组 */
  items: DatabaseSourceItem[];
}

/**
 * input/assets/ 下按首层目录聚成的一个图库：一份文档抽出的图算一堆，
 * 没有归属的图归到「未分类」。path 指向图库所在目录，name 是目录名，
 * title 优先用来源文档的标题。
 */
export interface AssetGroup extends FileItem {
  images: FileItem[];
}

/** /api/projects/:id/table 分页预览大 CSV / 工作簿里的一张 sheet，不把整文件塞进 JSON */
export interface TablePage {
  path: string;
  headerLine: string;
  lines: string[];
  totalRows: number;
  offset: number;
  limit: number;
  size: number;
  mtime: string;
  /**
   * 工作簿里的全部工作表名（按原有顺序）。
   * 旧服务进程没有、csv/tsv 没有；缺了就当单表。
   */
  sheets?: string[];
  /**
   * 本次返回的工作表名。缺了就当单表。
   */
  sheet?: string;
}

/** /api/projects/:id/table-search 的一条命中 */
export interface TableSearchHit {
  /** 数据行序号，从 0 起，**不含表头** —— 前端拿它算页码并定位 <tr> */
  row: number;
  /** 该行的原始文本。服务端不解析 CSV，前端自己按单行解析成单元格 */
  text: string;
}

/**
 * /api/projects/:id/table-search 整表检索的结果。
 * 匹配口径是「一行里出现全部关键词」，结果按行号先后排 —— 与预览窗内 markdown 那套
 * 模糊排序不是一回事，界面上要说清楚（见 openspec 的 table-full-scan-search）。
 */
export interface TableSearchResult {
  path: string;
  rows: TableSearchHit[];
  /** 实际扫过的数据行数 */
  scannedRows: number;
  /** 命中数到了上限，rows 只有前若干条 */
  truncated: boolean;
  /** 超出时间预算、文件没扫完。界面 **必须如实说**，不能显示成「没找到」 */
  partial: boolean;
  /** 客户端断开导致的提前收尾；正常拿到响应时不会为 true，缺了当 false */
  aborted?: boolean;
  /** 总数据行数。没扫完且服务端手上没有行数缓存时不给，缺了就别显示总数 */
  totalRows?: number;
  size: number;
  mtime: string;
  /**
   * 工作簿里的全部工作表名。旧服务进程没有、csv/tsv 没有；缺了就当单表。
   */
  sheets?: string[];
  /**
   * 本次检索的工作表名。缺了就当单表。
   */
  sheet?: string;
}

export interface PrototypeItem {
  itemKey: string;
  title: string;
  /** 看板伺服的入口地址，新窗口打开。`kind === 'url'` 时为空 —— 那种形态没有本地产物 */
  url: string;
  /**
   * bundle 的两种物理形态：folder = 已解压目录；zip = 由看板缓存解压。
   * 'url' 是云端发布的原型（axhub-make 发布、figma make 的 publish / share 链接），
   * 本地只有 meta.json 和可选封面。
   * **前端据此决定点击行为**：'url' 直接开外部 `target`，其余开看板伺服的 `url`。
   * 可选：旧服务进程没有这个字段，缺了就当 bundle 处理（退回改动前的行为）。
   */
  kind?: 'folder' | 'zip' | 'url';
  /**
   * `kind === 'url'` 时的目标地址，新窗口直接打开，不经看板伺服。
   * 服务端已经校过协议：非 http/https 一律置空 —— 空串 = 地址不合法，卡片不可点击。
   */
  target?: string;
  /** 封面图地址（url 形态的 cover.png）。没有就走窗框占位，不得出现破图 */
  cover?: string;
  sourcePath?: string;
  mtime?: string;
}

/**
 * visualization/prototypes/ 下的原型清单（已构建的 HTML 包 + 云端发布链接）。
 * clientReady / serverRunning / origin 是旧 Axhub 开发服务时代的字段，
 * 新逻辑里 clientReady≈有可预览包、serverRunning 同义、origin 常为空 —— 都保留作兼容。
 */
export interface Prototypes {
  clientReady: boolean;
  serverRunning: boolean;
  origin: string;
  items: PrototypeItem[];
  note: string;
  updatedAt?: string;
  /**
   * 工作空间根上还有非空的旧 `prototypes/` 时才出现（值就是 'prototypes'）。
   * **只用于在空态里给一行迁移提示** —— 看板对工作空间只读，不代替用户搬家。
   * 可选：搬完了、或旧服务进程没这个字段时都缺省，缺了就不显示提示。
   */
  legacyDir?: string;
}

/**
 * visualization/references/ 下的一份参考：收下来的别人的页面。
 * 判定条件只有一条 —— 目录根上有 index.html；其余全可选。
 */
export interface ReferenceItem {
  itemKey: string;
  title: string;
  /** 查看器壳页地址（看板自己的 HTML，里面 iframe 装被隔离的原始页面），新窗口打开 */
  url: string;
  /** 采集来源地址。手工摆进来的参考没有这个 */
  sourceUrl?: string;
  /**
   * manual = 用户手工摆进来（也是 meta.json 缺失 / 坏掉时的退路）。
   * url-capture / plugin 是后面两个 change（贴 URL 采集、浏览器插件投递）用的取值，
   * 类型里先写全，省得下次再动契约。
   */
  source?: 'manual' | 'url-capture' | 'plugin';
  /** 这页有没有经过脱敏。**只是告知，不是安全保证** */
  scrubbed?: boolean;
  capturedAt?: string;
  sourcePath?: string;
  mtime?: string;
  /** 卡片封面（screenshots/hero.png）。没有就走窗框占位 */
  cover?: string;
  /** 实际存在的那几张截图的地址，键是 hero / full / mobile */
  screenshots?: Partial<Record<'hero' | 'full' | 'mobile', string>>;
}

/** 参考清单。形状与 Prototypes 同类，但没有 Axhub 时代那三个兼容字段。 */
export interface References {
  items: ReferenceItem[];
  note: string;
  updatedAt?: string;
}

export interface ProjectMeta {
  exists: boolean;
  path: string;
  raw: string;
  mtime?: string;
  error?: string;
  data: Record<string, any> | null;
  missing: string[];
  filled: string[];
  provenance: Record<string, string>;
  confidence: Record<string, string>;
  stats: { filled: number; missing: number; total: number; completeness: number } | null;
}

export interface Scan {
  project: { id: string; name: string; root: string };
  /**
   * false = 登记的目录不在了（被改名、移走或删掉），下面的清单全都不作数。
   * 可选：服务进程可能比前端旧（改完代码没重启），缺字段时一律当「正常」处理，
   * 宁可退回改动前的行为，也不能因为少个字段白屏。
   */
  available?: boolean;
  unavailableReasons?: string[];
  scannedAt: string;
  meta: ProjectMeta;
  input: {
    raw: FileItem[];
    converted: ConvertedItem[];
    assets: FileItem[];
    /**
     * assets 按图库分好的样子。可选：旧服务进程不返回它，
     * 缺了就退回改动前的行为 —— 所有图片平铺成一个网格。
     */
    assetGroups?: AssetGroup[];
    pending: FileItem[];
    indexPath: string;
    /**
     * 工作空间里有 scripts/ingest.py 时为 true，前端才显示「开始转换」按钮。
     * 可选：旧服务进程没有这个字段时退回纯文字提示（改动前的行为）。
     */
    canIngest?: boolean;
    /**
     * input/sources/*.yaml 配的数据库源，每个源挂着它在 input/converted/_sources/ 下的产物。
     *
     * **可选，而且这个可选就是「数据库源」tab 的唯一判据**：
     * 空数组是合法状态（有 `input/sources/` 目录但还没配源），前端要渲染空态和添加入口；
     * 字段缺省才是「跟数据库无关 / 旧服务进程」，不渲染那个 tab。
     *
     * 注意 `input/converted/_sources/` 下的产物**不在** `converted` 里，
     * `stats.converted` 也不含它们：数据库和文件是两条来源，混在一个清单里会让
     * 「已转换」的语义糊掉。
     */
    sources?: DatabaseSource[];
    /**
     * 工作空间里有 scripts/db_ingest.py 时为 true，前端才显示「刷新 schema」按钮。
     * 可选：只有 `sources` 存在时服务端才给这个字段；缺了就只显示清单不给按钮。
     */
    canIngestSources?: boolean;
    stats: {
      raw: number;
      converted: number;
      assets: number;
      pending: number;
      /**
       * 按 input/.ingestignore 忽略的份数：不算待转换，但仍计入 raw 总量。
       * 可选：旧服务进程没有这个字段，缺了就不显示这一项。
       */
      ignored?: number;
      warnings: number;
      /** 原件已不在 / 原件转换后动过的产物份数。可选：旧服务进程没有这两个字段，缺了就不显示。 */
      orphaned?: number;
      stale?: number;
      words: number;
      bytes: number;
    };
  };
  output: {
    analysis: FileItem[];
    docs: FileItem[];
    decisions: FileItem[];
    stats: {
      analysis: number;
      docs: number;
      decisions: number;
      total: number;
      words: number;
      lastUpdated: string;
      /** 带标注的产出份数 / 标注总条数。可选：旧服务进程没有这两个字段。 */
      annotated?: number;
      annotations?: number;
    };
  };
  /**
   * visualization/references/ 的参考清单。
   * 可选：**旧服务进程没有这个字段**（改完代码没重启 serve）。新服务哪怕工作空间里
   * 根本没有 visualization/ 也会返回空结构，所以「字段缺失」就等于「服务进程比前端旧」——
   * 这时参考 tab 显示「重启看板服务」，原型 tab 照常工作，不得白屏。
   */
  references?: References;
  prototypes: Prototypes;
}

export interface ProjectStatus {
  ok: boolean;
  reasons: string[];
}

export interface Project {
  id: string;
  name: string;
  root: string;
  createdAt: string;
  updatedAt: string;
  status?: ProjectStatus;
}

export interface RelinkCandidate {
  root: string;
  name: string;
  mtime: string;
}

/**
 * 一份可用来「新建工作空间」的模板。
 * 整份 TemplateList 都可选：老服务没有 /api/templates，前端就藏选择器和复制按钮。
 */
export interface WorkspaceTemplate {
  id: string;
  name: string;
  description?: string;
  builtin?: boolean;
}

/** GET /api/help 的返回。老服务没有这个接口（404），调用方要兜住。 */
export interface HelpDoc {
  ok?: boolean;
  text?: string;
}

export interface TemplateList {
  templates?: WorkspaceTemplate[];
  userRoot?: string;
  createPrompt?: string;
}

/**
 * POST/GET /api/projects/:id/ingest 的任务状态。
 * idle = 这个进程里还没跑过；running 时前端轮询；done/error 时展示 message。
 */
export type IngestStatus = 'idle' | 'running' | 'done' | 'error';

export interface IngestJob {
  status: IngestStatus;
  message: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  log?: string;
  /**
   * 本次指定的目标（input/raw/ 下的文件或目录的相对路径）。空或缺省 = 转整个 input/raw/。
   * 可选：旧服务进程没有这个字段，缺了就不当「单个目标的任务」展示。
   */
  path?: string;
}

/**
 * POST/GET /api/projects/:id/capture 的采集任务状态。
 * 与 IngestJob 同构：一个工作空间同一时刻至多一个进行中的采集。
 * idle = 这个服务进程里还没采过；running 时前端轮询；done/error 时展示 message。
 */
export type CaptureStatus = 'idle' | 'running' | 'done' | 'error';

/** 采集目标平面：参考收整页 + 三张截图，原型只收链接 + 一张封面。 */
export type CapturePlane = 'reference' | 'prototype';

export interface CaptureJob {
  status: CaptureStatus;
  /** 本轮采的是哪一边。idle 时为空串 */
  plane: CapturePlane | '';
  /** 用户贴的地址（服务端已规范化） */
  target: string;
  /**
   * 三态各自的人话：running 是「正在采…」，done 是「已收进 <目录>/」，
   * error 是**工具给的原因原样带出来**。前端直接显示它，不要自己写「操作失败请重试」。
   */
  message: string;
  startedAt?: string;
  finishedAt?: string;
  /** 成功时服务端生成的目录名（同一 URL 采第二次是 `<slug>-2`，不覆盖旧的） */
  slug?: string;
  /** 成功时的工作空间内相对路径，如 `visualization/references/某页` */
  sourcePath?: string;
  /**
   * 这次少了哪些档位。`screenshots` = 参考没出截图，`cover` = 原型没出封面。
   * **非空不等于失败** —— status 仍是 done，卡片照常出现，只是少了图。
   */
  degraded?: string[];
  /**
   * 降级的人话说明，缺工具时**带可直接复制的安装命令**。
   * 它跟着 done 一起显示，用中性语气，不要走 orange —— orange 只给真正的失败。
   */
  degradedHint?: string;
}

/**
 * POST/GET /api/projects/:id/db-source 的数据源采集任务状态。
 * 与 IngestJob 同构，但**在服务端是另一把锁**：正在转一份大 PDF 的时候照样能刷 schema。
 * idle = 这个服务进程里还没采过；running 时前端轮询；done/error 时展示 message。
 */
export interface SourceIngestJob {
  status: IngestStatus;
  /**
   * 三态各自的人话。error 时是**脚本自己打的那句中文**（缺哪个环境变量、该装哪个包、
   * 只读会话为什么设不上）—— 直接显示它，不要自己写「操作失败请重试」。
   */
  message: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  log?: string;
  /** 本轮采的是哪个源（源名）。idle 时为空串 */
  source?: string;
}

/**
 * GET /api/projects/:id/verify-source 的结果：重算原件 sha256 跟产物记的比。
 * 'unknown' = 比不了（没记来源 / 没记 sha256 / 来源是目录），reason 里是中文原因，
 * 这种情况不要拿扫描的 mtime 结论冒充哈希结论。
 */
export interface SourceVerification {
  path: string;
  source: string;
  sourceSha256: string;
  state: 'ok' | 'stale' | 'missing' | 'unknown';
  reason?: string;
  actualSha256?: string;
  size?: number;
  checkedAt: string;
}

/**
 * 预览批注归档后的一条。number 是归档当时页面上的编号。
 * 旧服务没有这套接口（404），调用方要兜住，退回「没有历史」。
 */
export interface NoteHistoryItem {
  quote: string;
  comment: string;
  structure: string;
  start?: number;
  end?: number;
  number?: number;
}

export interface NoteHistoryBatch {
  id: string;
  archivedAt: string;
  notes: NoteHistoryItem[];
}

export interface NoteHistory {
  file: string;
  batches: NoteHistoryBatch[];
  batch?: NoteHistoryBatch;
}

/**
 * 请求失败时抛的错误。`status` 是 HTTP 状态码 —— 调用方靠它区分
 * 「老服务进程没有这个接口」(404，可以降级) 与「真的出错了」(500 / 其它，必须如实报)。
 * 只带 message 的老写法照旧能用（catch 里读 `.message`）。
 */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ error: res.statusText }));
    // 前端已经构建到新版、接口服务还是老进程时会撞上这个。直接把原因写进提示，
    // 不然「未知接口」看着像路由写错了，实际只是没重启 serve。
    if (res.status === 404 && typeof detail.error === 'string' && detail.error.startsWith('未知接口')) {
      throw new ApiError(`${detail.error}（接口服务的进程可能比前端旧，重启 serve 再试）`, res.status);
    }
    throw new ApiError(detail.error || `请求失败（${res.status}）`, res.status);
  }
  return res.json() as Promise<T>;
}

export const api = {
  /**
   * platform 是服务**所在机器**的 process.platform，用来定「在访达中显示」这类文案。
   * version 是看板自己的版本（env / 发版注入的 package.json / git v* tag）。
   * 两者都可选：老服务进程没有，缺了 platform 按 macOS 的说法走、version 不显示。
   */
  health: () => request<{ ok: boolean; platform?: string; version?: string }>('/api/health'),
  /**
   * 探 `POST /api/pick-directory` 在不在。旧服务进程 404，调用方据此藏掉文件夹按钮。
   * GET 不弹窗。
   */
  pickDirectoryAvailable: () => request<{ available?: boolean }>('/api/pick-directory'),
  /**
   * 在服务所在的机器上弹出系统原生目录选择框。
   * picked: false = 用户取消，不是错误。409 = 已经开着一个；403 = 非环回。
   */
  pickDirectory: () =>
    request<{ picked: boolean; path?: string }>('/api/pick-directory', { method: 'POST' }),
  projects: () => request<{ projects: Project[]; activeProjectId: string }>('/api/projects'),
  addProject: (root: string, name?: string) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ root, name }) }),
  createWorkspace: (name: string, path: string, template?: string) =>
    request<Project>('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name, path, ...(template ? { template } : {}) }),
    }),
  template: () => request<{ root: string; ok: boolean }>('/api/template'),
  /**
   * 列出内置 + 用户自建模板，并给出「创建模板」提示词。
   * 老服务没有这个接口（404），调用方要自己兜住，退回不选模板直接建。
   */
  templates: () => request<TemplateList>('/api/templates'),
  /**
   * 看板帮助文档（templates/help.md 的正文）。
   * 老服务没有这个接口（404），面板自己显示「这个版本还没有帮助文档」。
   */
  help: () => request<HelpDoc>('/api/help'),
  updateProject: (id: string, patch: { root?: string; name?: string }) =>
    request<Project>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  candidates: (id: string) =>
    request<{ candidates: RelinkCandidate[] }>(`/api/projects/${id}/candidates`),
  removeProject: (id: string) => request<{ removed: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  scan: (id: string) => request<Scan>(`/api/projects/${id}/scan`),
  prototypes: (id: string) => request<Prototypes>(`/api/projects/${id}/prototypes`),
  /**
   * 参考清单。scan 里已经带了同一份数据，这个接口是给独立刷新用的（与 prototypes 对称）。
   * 老服务没有这个接口（404），调用方要自己兜住。
   */
  references: (id: string) => request<References>(`/api/projects/${id}/references`),
  file: (id: string, path: string) =>
    request<{ path: string; size: number; mtime: string; content: string }>(
      `/api/projects/${id}/file?path=${encodeURIComponent(path)}`,
    ),
  /** 大 CSV/TSV / xlsx 分页预览（点表主表等），默认每页 50 行。不传 sheet 时请求形状与改动前完全一致。 */
  table: (id: string, path: string, opts?: { offset?: number; limit?: number; sheet?: string }) => {
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    const q = new URLSearchParams({
      path,
      offset: String(offset),
      limit: String(limit),
    });
    if (opts?.sheet) q.set('sheet', opts.sheet);
    return request<TablePage>(`/api/projects/${id}/table?${q}`);
  },
  /**
   * 整表检索：服务端流式扫一遍这张表，挑出「一行里出现全部关键词」的行，按行号先后给回。
   * 只读、不落索引；命中够了或超时就停，`truncated` / `partial` 说明它停在哪。
   *
   * **老服务没有这个接口（404），调用方要自己兜住** —— 退回只搜当前已经画出来的这一页，
   * 并把「只搜了这一页」说给用户听。其它错误不要降级，如实报。
   * `signal` 用来在用户改词 / 关检索条 / 换文件时掐掉上一次扫描。
   */
  tableSearch: (
    id: string,
    path: string,
    q: string,
    opts?: { limit?: number; signal?: AbortSignal; sheet?: string },
  ) => {
    const params = new URLSearchParams({ path, q });
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.sheet) params.set('sheet', opts.sheet);
    return request<TableSearchResult>(
      `/api/projects/${id}/table-search?${params}`,
      opts?.signal ? { signal: opts.signal } : undefined,
    );
  },
  /**
   * 重算原件 sha256 跟产物记的比对；大文件要算几秒，只在用户点「校验原件」时调。
   * path 可以是 scan 的产物路径（含新布局正文目录）或摘要文件 manifestPath。
   */
  verifySource: (id: string, path: string) =>
    request<SourceVerification>(
      `/api/projects/${id}/verify-source?path=${encodeURIComponent(path)}`,
    ),
  fileUrl: (id: string, path: string) => `/api/projects/${id}/file?path=${encodeURIComponent(path)}`,
  reveal: (id: string, path: string, mode: 'reveal' | 'open' = 'reveal') =>
    request<{ ok: boolean }>(`/api/projects/${id}/reveal`, {
      method: 'POST',
      body: JSON.stringify({ path, mode }),
    }),
  /**
   * 触发工作空间 scripts/ingest.py；立刻返回，进度用 ingestStatus 轮询。
   * targetPath 有值时只转它（input/raw/ 下的文件或目录）；缺省转整个 input/raw/。
   * 注意目录是后加的：旧服务进程对目录会返回 400「请指定一个文件，不要指定目录」，
   * 前端把这句原样显示出来即可（不是白屏，也不需要前端自己判断能不能转目录）。
   */
  startIngest: (id: string, targetPath?: string) =>
    request<IngestJob>(`/api/projects/${id}/ingest`, {
      method: 'POST',
      ...(targetPath ? { body: JSON.stringify({ path: targetPath }) } : {}),
    }),
  ingestStatus: (id: string) => request<IngestJob>(`/api/projects/${id}/ingest`),
  /**
   * 触发工作空间 scripts/db_ingest.py 采一次 schema 快照；立刻返回，进度用
   * sourceIngestStatus 轮询。落盘由 input/ 的 SSE 捕获，清单自己刷新。
   *
   * **看板自己不连数据库** —— 连库整个发生在子进程里，写盘的也是那个脚本。
   * 界面上没有写 SQL 的地方：L2 查询由 AI 在终端里跑 `db_ingest.py query` 发起。
   * 老工作空间没有 db_ingest.py 时返回 400，把那句中文原样显示即可；
   * 旧服务进程没有这个接口（404），request 会带上「重启 serve」的提示。
   */
  startSourceIngest: (id: string, source: string) =>
    request<SourceIngestJob>(`/api/projects/${id}/db-source`, {
      method: 'POST',
      body: JSON.stringify({ source }),
    }),
  sourceIngestStatus: (id: string) => request<SourceIngestJob>(`/api/projects/${id}/db-source`),
  /**
   * 把 input/raw/ 下的文件或目录写进 input/.ingestignore，不再算待转换。
   * 文件还在磁盘上，只是看板和 ingest.py 一起跳过它。
   * already = 清单里已有这条（或更宽的目录）时没再追加。
   * 旧服务进程没有这个接口，request 会带上「重启 serve」的提示。
   */
  /**
   * 贴 URL 采集（plane: 'reference'）或导入云端原型（plane: 'prototype'）。
   * 立刻返回 running，进度用 captureStatus 轮询；落盘由 visualization/ 的 SSE 捕获，清单自己刷新。
   *
   * **写路径完全由服务端决定** —— 这里只传 plane 和 url，别指望能指定目录。
   * 已有采集在进行中时返回 409，把它的 error 原样显示即可（那句话说清了在采哪个地址）。
   * 旧服务进程没有这个接口（404），调用方要兜住并提示重启看板服务。
   */
  startCapture: (id: string, plane: CapturePlane, url: string) =>
    request<CaptureJob>(`/api/projects/${id}/capture`, {
      method: 'POST',
      body: JSON.stringify({ plane, url }),
    }),
  captureStatus: (id: string) => request<CaptureJob>(`/api/projects/${id}/capture`),
  addIgnore: (id: string, targetPath: string) =>
    request<{ ok: boolean; pattern: string; already?: boolean }>(`/api/projects/${id}/ignore`, {
      method: 'POST',
      body: JSON.stringify({ path: targetPath }),
    }),
  /**
   * 预览批注历史。写在 ~/.pmwork/dashboard/note-history/，不碰工作空间。
   * 旧服务没有这些接口（404），调用方要兜住并当成没有历史。
   */
  noteHistory: (id: string, file: string) =>
    request<NoteHistory>(`/api/projects/${id}/note-history?file=${encodeURIComponent(file)}`),
  appendNoteHistory: (id: string, file: string, notes: NoteHistoryItem[]) =>
    request<NoteHistory>(`/api/projects/${id}/note-history`, {
      method: 'POST',
      body: JSON.stringify({ file, notes }),
    }),
  clearNoteHistory: (id: string, file: string) =>
    request<NoteHistory>(`/api/projects/${id}/note-history?file=${encodeURIComponent(file)}`, {
      method: 'DELETE',
    }),
};
