import { RECORD_STATUS } from '../../shared/recordStatus.mjs';

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
  /**
   * 产出项在 `output/<组>/一次归档/` 下。**判据只在服务端**（scan.mjs 的 `outputPlacement`），
   * 前端不从 `path` 里自己找「一次归档」—— 同一个判据实现两遍，目录名一改就是两处要同步。
   * 可选：旧服务进程没有这个字段，缺了归档项就照旧混在主列表里，等于功能没启用、行为与改动前一致。
   */
  archived?: boolean;
  /** 归档项所在的堆目录名（二次归档分出来的子目录）；平铺在归档根上时为空串 */
  archivePile?: string;
  /**
   * 归档区里的两种说明文件，不是被归档的产出物：`handoff` = 归档根上的 README 交接单，
   * `index` = 堆目录里的 INDEX.md 堆索引。它们排在各自那一堆最前面，不进已归档计数。
   */
  archiveRole?: ArchiveRole;
  /** 在组内子目录里（不在 一次归档/ 下）。本轮只能归档组根目录下的文件，这类要置灰说明 */
  nested?: boolean;
  /**
   * 不透明键：产出三组里的 `.md`、`input/raw/` 里的 `.docx` 才有。「转成 Word」「提炼模板」只拿它指定来源，
   * 不传路径（AGENTS.md 不变量 1 第九条）。可选：旧服务进程没有，缺了入口置灰、提示重启。
   */
  docKey?: string;
  /**
   * 产出组里的 `.docx` 才有：是不是 docx 工具链转出来的（带生成标记）。
   * `true` 才允许在「转成 Word」里勾选覆盖；`false` 一律拒绝覆盖。缺字段 = 旧服务，不据此判断。
   */
  docxGenerated?: boolean;
}

export type ArchiveRole = 'handoff' | 'index';

/** 一次归档可选的三组。`questions` / `records` 不在其中，类型上就排除掉 */
export type OutputGroup = 'analysis' | 'docs' | 'decisions';

/**
 * POST /api/projects/:id/archive 的请求体。**只带组名与文件基名** ——
 * 类型上就不留传路径的口子，服务端对带路径分隔符或 `..` 的文件名一律 400。
 */
export interface ArchiveRequest {
  group: OutputGroup;
  /** 组根目录下的文件名，如 `旧版需求说明.md`，不是路径 */
  name: string;
}

/** 归档成功：原路径与新路径（同名冲突时新路径带日期后缀），以及 `target` 待跟进的记录编号 */
export interface ArchiveResult {
  ok: true;
  from: string;
  to: string;
  records: string[];
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
  /**
   * 原型工作区同步过来的镜像目录（目录里有 SYNC.md）才有：离线包、在线版、同步状态、资料。
   * 可选：旧服务进程没有；缺了就当普通卡片展示（退回改动前的行为）。
   */
  linked?: PrototypeLinked;
  /**
   * 这条已被并入某份同步原型（值是那份原型的 itemKey）：同名 `-html.zip`，或指向同一在线链接的手工卡片。
   * 新前端不再单独成卡；服务端照旧下发它，是为了让旧前端看到的和改动前一样。
   */
  groupedInto?: string;
}

/** 同步镜像里一份可阅读的资料 md，路径相对工作空间根，用现有阅读器打开 */
export interface PrototypeDoc {
  path: string;
  group: 'spec' | 'docs' | 'annotations' | 'comments' | 'sync';
  label: string;
}

/** 一份已接入原型工作区的原型。每一块都可选：缺哪块界面就少显示哪块 */
export interface PrototypeLinked {
  /** 同级 `<目录名>-html.zip`，看板伺服的入口 */
  offline?: { url: string; sourcePath: string; mtime?: string; size?: number };
  /** 镜像目录 meta.json 里的发布链接；target 为空 = 地址不合法。缺省 = 从未发布过 */
  online?: { target: string; publishedAt?: string; publishTarget?: string };
  /**
   * 从 SYNC.md 解析出的状态。解析不出的字段一律缺省，界面显示「—」、不标 orange。
   * onlineStale：本地最近改动晚于发布时间（两个时间都合法才算）；
   * offlineStale：本次同步没导出成功，离线包是旧的或不存在。
   */
  sync?: {
    commit?: string;
    localChangedAt?: string;
    syncedAt?: string;
    onlineStale?: boolean;
    offlineStale?: boolean;
  };
  docs?: PrototypeDoc[];
  /** 已并入的手工卡片目录（工作空间相对路径）。看板只提示，不代删 */
  duplicates?: string[];
  /**
   * 这份已接入原型能不能从看板一键刷新。
   * 可选：旧服务进程没有这个字段，缺了就不显示刷新按钮（退回改动前的行为）。
   * available: false 时按钮置灰，reason 是原因（没有 sync.json、脚本名不对、登记不回指等）。
   */
  refresh?: { available: boolean; reason?: string };
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
  /**
   * 工作空间里有 scripts/web_ingest.py 时为 true，前端才显示参考 tab 的刷新按钮。
   * 可选：旧服务进程没有这个字段时不显示刷新按钮，退回改动前的参考 tab。
   */
  canInbox?: boolean;
  /**
   * visualization/references/ 根上还没入库的散装 .html / .htm 份数。
   * 它们不在 items 里。可选：旧服务进程没有这个字段时不提示待入库。
   */
  pending?: number;
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
      /**
       * 各组已归档的份数（不含交接单与堆索引）。有这个字段时，上面三组计数与 total / words
       * **只数主列表**；界面要把两个数一起显示，不然总数突然变小看起来像文件没了。
       * 可选：旧服务进程没有，那时三组计数照旧包含一切。
       */
      archived?: Record<OutputGroup, number>;
    };
    /**
     * 工作空间里有 scripts/archive_output.py 时为 true。false 时「归档」置灰并说明。
     * 可选：旧服务进程没有这个字段 —— 那时不置灰，点了会撞 404，提示重启服务。
     */
    canArchive?: boolean;
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
 * POST/GET /api/projects/:id/proto-sync 的原型刷新任务状态。
 * 与 IngestJob 同构，但**在服务端是另一把锁**：正在转资料的时候照样能刷新原型。
 * idle = 这个服务进程里还没刷过；running 时前端轮询；done/error 时展示 message。
 */
/**
 * POST/GET /api/projects/:id/web-ingest 的参考收件箱任务状态。
 * 与 IngestJob 同构，但**在服务端是另一把锁**：正在转资料或采集时照样能刷新收件箱。
 * 请求不带路径；看板只 spawn `--inbox`。
 * idle = 这个服务进程里还没跑过；running 时前端轮询；done/error 时展示 message。
 */
export interface WebIngestJob {
  status: IngestStatus;
  /**
   * 三态各自的人话。done 时是脚本的「收件箱完成」摘要，
   * error 时是脚本原文（缺 defuddle 的安装命令、哪一份抽不出正文）——
   * 直接显示它，不要自己写「操作失败请重试」。
   */
  message: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  log?: string;
}

export interface ProtoSyncJob {
  status: IngestStatus;
  /**
   * 三态各自的人话。done 时是脚本输出里的 `!` 行（没有就取 `✓` 行），
   * error 时是最后一条 `✗` 行 —— 原文照搬，不要自己写「操作失败请重试」。
   */
  message: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  log?: string;
  /** 正在 / 刚刷过的原型 itemKey。idle 时为空串 */
  item?: string;
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
 * 批注状态。四个值的含义在工作空间 `output/records/README.md` 的「批注」一节。
 * `string & {}` 兜住写错的词：文件是手写的，多一个状态不该让前端崩。
 */
export type NoteStatus = 'pending' | 'adopted' | 'rejected' | 'unclear' | (string & {});

/** 这一批落在工作空间的批注文件里，还是看板缓存里。旧服务不给这个字段。 */
export type NoteSource = 'workspace' | 'cache' | (string & {});

/**
 * 已经落盘的一条批注。number 是归档当时页面上的编号（缓存批次才有）。
 * noteId 是批注文件里的 `N` 编号。新增字段都可选：旧服务不给，缺了就当普通历史条目。
 */
export interface NoteHistoryItem {
  quote: string;
  comment: string;
  structure: string;
  start?: number;
  end?: number;
  number?: number;
  /** 批注文件里的 `N0003`。缓存里的旧批次没有 */
  noteId?: string;
  status?: NoteStatus;
  /** agent 回写的那一行。pending 时为空 */
  receipt?: string;
  /** 从看板缓存迁过来的。缺了就当不是 */
  migrated?: boolean;
  /**
   * 回执末尾的沉淀标记「沉淀为 R014（规则库 v4）」解析出来的规则。
   * 可选：旧服务不给、没沉淀的也不给；回执原文仍在 `receipt` 里
   */
  deposits?: NoteDeposit[];
}

/** 一条交付稿批注沉淀成的规则 */
export interface NoteDeposit {
  /** `R014` */
  rule: string;
  /** 沉淀时规则库的版本 */
  version: number;
}

export interface NoteHistoryBatch {
  id: string;
  archivedAt: string;
  notes: NoteHistoryItem[];
  /** 缺字段 = 旧服务。不要把缺字段当成「看板缓存」去显示来源文案 */
  source?: NoteSource;
  recordId?: string;
  /**
   * 这一批针对的文件（批注文件里的「- 对象：」行）：原稿，或某一版交付稿 `output/delivery/…/v002.md`。
   * 可选：旧服务不给，缺了就当是当前打开的文件
   */
  target?: string;
}

/**
 * 未决问题的四态 + 一个脏数据态。字段契约的事实源是工作空间里的
 * `output/questions/README.md`（模板在 templates/pm-aispace/ 下）。
 *
 * `conflict` 不是流程里的一步：它是迁移时识别出的存量脏数据（正文写着「已解决」、
 * 编号却没划掉），摆在界面上等人裁定，而不是替它遮掩。
 *
 * 用 `string & {}` 兜住枚举之外的值 —— 工作空间里的文件是人和 agent 手写的，
 * 写错一个词不该让前端崩，界面上当作未知状态显示出来即可。
 */
export type QuestionStatus = 'open' | 'pending_ai' | 'answered' | 'dropped' | 'conflict' | (string & {});

/** 凭据四值。只有前三种能关闭问题，`我方推断` 不能 —— 见 README 的「推断不能关闭问题」。 */
export type QuestionEvidence = '客户确认' | '资料实证' | '我方决策' | '我方推断' | (string & {});

/** 四个标准答案。看板写它（人写区），agent 不写。 */
export type QuestionAnswer = 'verify' | 'decide' | 'drop' | 'ask' | (string & {});

/**
 * 清单索引里的一条问题：只有 front-matter，**没有正文**（正文走 `api.question`）。
 *
 * 除 `id` / `path` / `name` 外的字段都可能是空串 —— 迁移出来的条目 `blocks` 与
 * `evidence` 一律留空（迁移不推断），前端要对空值有明确呈现（凭据空 = 「未标注」），
 * 不能当成必填用。
 */
export interface QuestionItem {
  /** 问题编号，如 `Q0134`。外部引用的锚点，只增不减、不复用 */
  id: string;
  /** 文件名，`Q0134.md`。解析不出来的条目靠它显示 */
  name: string;
  /** 工作空间内相对路径。复制 prompt 时贴的就是它 —— 贴路径不贴正文 */
  path: string;
  mtime: string;
  /** 一句话问题。清单行只显示它 */
  title: string;
  status: QuestionStatus;
  /** 阻塞哪个在途交付物。`backlog` = 不阻塞任何在途交付物，清单里单独成一组；空 = 还没归类 */
  blocks: string;
  asked_of: string;
  /** 触发这条问题的文档路径 */
  source: string;
  context: string;
  created: string;
  updated: string;
  human_answer: QuestionAnswer;
  /** 最迟答复日期 `YYYY-MM-DD`。`human_answer: ask` 时才有意义 */
  due: string;
  evidence: QuestionEvidence;
  /** 结论的一句话摘要；展开的结论在正文里 */
  ai_conclusion: string;
  /** 这条结论该回流到哪份正文的哪一节。空 = 知识还没收敛回去 */
  flows_to: string[];
  /**
   * 这份文件的 front-matter 缺失或读不出来。**不是错误** ——
   * 一条坏数据不能拖垮整个接口，也不该悄悄消失，所以它照样在清单里，只是标成无法解析。
   */
  broken?: boolean;
  reason?: string;
}

/**
 * 问题索引。`available: false` = 这个工作空间还没有 `output/questions/` 目录
 * （旧工作空间不会自动获得新结构），不是错误，界面走空态说明。
 */
export interface QuestionIndex {
  dir: string;
  available: boolean;
  items: QuestionItem[];
}

/** 单条详情：索引的全部字段，外加正文与两个只在卡片上用的字段。 */
export interface QuestionDetail extends QuestionItem {
  /** 结论的依据出处，可以是多条 */
  ai_source: string[];
  human_note: string;
  /** front-matter 之后的 markdown 正文 */
  body: string;
}

/**
 * 人工反馈的载荷。**只有人写区这四个键** —— 服务端对载荷里出现任何 AI 写区字段
 * （`evidence` / `ai_conclusion` / `ai_source` / `flows_to`）一律 400 且不落盘。
 * 人和 agent 的写区物理隔开，这就是并发方案本身（不用锁，见 questions/README.md）。
 */
export interface QuestionPatch {
  status?: QuestionStatus;
  human_answer?: QuestionAnswer;
  /** 一两句补充。服务端限长，超了 400 —— 要写长文说明这条该拆 */
  human_note?: string;
  /** `YYYY-MM-DD`。`human_answer: ask` 时必填，缺了服务端 400 */
  due?: string;
}


/**
 * 产出物记录的类别与状态 —— **类型直接从 `src/shared/recordStatus.mjs` 那张表派生**，
 * 不在前端抄第二遍字面量。服务端校验、前端下拉、工作空间校验脚本认的是同一套值，
 * 抄两份就会出现「界面给得出、服务端不肯收」。
 *
 * 两者都用 `string & {}` 兜住表外的值：记录是人和 agent 手写的文件，
 * `kind` 或 `status` 写错一个词不该让前端崩，界面上当未知显示出来即可
 * （校验由工作空间的 `scripts/check_markdown.py` 报）。
 */
type RecordKindKey = keyof typeof RECORD_STATUS;
export type RecordKind = RecordKindKey | (string & {});
export type RecordStatus = (typeof RECORD_STATUS)[RecordKindKey][number] | (string & {});

/**
 * 清单索引里的一条记录：只有 front-matter，**没有正文**（状态流水走 `api.record`）。
 *
 * `id` 以**文件名**为准，不是 front-matter 里的 `id` —— 详情与写入都按编号拼路径，
 * 听 front-matter 的话，手写错一个字这条就点不开。两者不一致时 `broken` 为真。
 */
export interface OutputRecordItem {
  /** 记录编号，如 `I0007`。外部引用的锚点，只增不复用 */
  id: string;
  /** 文件名，`I0007.md` */
  name: string;
  /** 工作空间内相对路径 */
  path: string;
  mtime: string;
  /** 产出物类别，决定 `status` 的合法取值 */
  kind: RecordKind;
  /** 一句话说清这份产出物是什么。清单行只显示它 */
  title: string;
  /** 产出物的工作空间相对路径（单向反链；记录旁挂，产出物文件不带任何我方元数据） */
  target: string;
  status: RecordStatus;
  created: string;
  /** 状态最后一次变更日期。`delivered` 停滞多久由它与当天的差值表达，不额外立状态 */
  status_changed: string;
  updated: string;
  /** 被哪个编号吸收 / 取代 / 推翻。终态必有值 */
  resolved_by: string;
  /**
   * `target` 指向的产出物文件不在了（被改名或删除）。
   * **新增字段，可选**：旧服务进程不给，缺字段时当作没丢失，退回改动前的行为。
   * 界面上用 orange（`--destructive`）——「需要注意」的语义就是它。
   */
  targetMissing?: boolean;
  /**
   * `target` 指在某组的 `一次归档/` 下（由服务端从 `target` 路径派生）。
   * **它不是状态**：不写进 front-matter、不进三套状态机，`status` 不因归档而变。
   * 刚归档、agent 还没跟进 `target` 时它是 false，那时照旧是「指向丢失」。
   * 新增字段，可选：旧服务进程不给，缺了就不显示这个标记。界面上用中性灰，不用 orange。
   */
  targetArchived?: boolean;
  /**
   * 这份文件的 front-matter 缺失、读不出来，或 `id` 与文件名不符。**不是错误** ——
   * 一条坏数据不能拖垮整个接口，也不该悄悄消失，所以它照样在清单里，只是标成无法解析。
   */
  broken?: boolean;
  reason?: string;
}

/**
 * 记录索引。`available: false` = 这个工作空间还没有 `output/records/` 目录
 * （旧工作空间不会自动获得新结构），不是错误，界面走空态说明。
 */
export interface OutputRecordIndex {
  dir: string;
  available: boolean;
  items: OutputRecordItem[];
}

/** 状态流水里的一条：日期 + 变更后的状态 + 一句说明。认不出格式的条目 `date` / `status` 为空。 */
export interface RecordFlowEntry {
  date: string;
  status: RecordStatus;
  /** `### ` 后的整行原文，格式认不出来时靠它显示 */
  title: string;
  note: string;
}

/** 单条详情：索引的全部字段，外加状态流水与正文。 */
export interface OutputRecordDetail extends OutputRecordItem {
  /**
   * 这个 `kind` 能选的状态值。前端本来就有同一份表，服务端再下发一遍是为了
   * `kind` 写错时界面有据可依（拿不到就退回按本地表推，缺字段时是空数组）。
   */
  statusValues?: readonly RecordStatus[];
  /** 正文「## 状态流水」下的条目，旧到新。缺字段时前端不显示流水，不报错 */
  flow?: RecordFlowEntry[];
  /** front-matter 之后的 markdown 正文 */
  body: string;
}

/**
 * 一次状态变更的载荷。**只有人写区** —— 服务端对载荷里出现任何 AI 写区字段
 * （`target` / `updated`）或建立时写定的字段（`id` / `kind` / `title` / `created`）
 * 一律 400 且不落盘。人和 agent 的写区物理隔开，这就是并发方案本身（见 records/README.md）。
 */
export interface RecordStatusPatch {
  /** 必须属于该记录 `kind` 的状态机，否则 400 */
  status: RecordStatus;
  /** 这次变更的一句说明。**为空 400** —— 流水的每一条都要说清为什么 */
  note: string;
  /** 被哪个编号消解。`absorbed` / `superseded` / `overturned` 时必填，缺了 400 */
  resolved_by?: string;
}

/**
 * 反馈单清单里的一条：只有 front-matter，没有正文。
 * 新字段全部可选 —— 旧服务进程没有这个接口时调用方走 `unsupported`，
 * 缺字段时不要当成 0 条。
 */
export interface FeedbackItem {
  id?: string;
  name?: string;
  path?: string;
  mtime?: string;
  title?: string;
  /**
   * `bug`（缺陷单）/ `contribution`（贡献单），服务端缺省报 `bug`；写歪的值原样保留，界面归到「未识别」。
   * 可选：旧服务进程不报，那时一律按缺陷单显示
   */
  kind?: string;
  /** `pending` / `fixed` / `wontfix`，写歪的值原样保留，界面归到「未识别」 */
  status?: string;
  created?: string;
  receipt?: string;
  /** 最近一次「我已发出」的时间。空 = 还没发过 */
  sent_at?: string;
  broken?: boolean;
  reason?: string;
}

/** 反馈单索引。`available: false` = 还没有 `output/feedback/`，不是错误。 */
export interface FeedbackIndex {
  dir?: string;
  available?: boolean;
  /** `.kanban-feedback/` 根上的 `.md` 份数。看板不读那些文件的内容 */
  legacyCount?: number;
  items?: FeedbackItem[];
}

export interface FeedbackSection {
  heading?: string;
  body?: string;
}

export interface FeedbackSend {
  title?: string;
  body?: string;
}

/** 单条详情：索引字段 + 按节拆好的正文 + 发送记录。 */
export interface FeedbackDetail extends FeedbackItem {
  sections?: FeedbackSection[];
  sends?: FeedbackSend[];
}

/** docx 模板目录里约定的几样。缺的 `exists` 为 false，界面标「缺」。 */
export interface DocxTemplateFiles {
  profile?: { exists?: boolean; mtime?: string };
  reference?: { exists?: boolean; mtime?: string };
  /** 前置区骨架（封面 / 签署页 / 版本表 / 目录）。可选：旧服务不报，那时概要不显示「前置区」一行 */
  front?: { exists?: boolean; mtime?: string };
  cover?: { exists?: boolean; mtime?: string };
  spec?: { exists?: boolean; mtime?: string };
  collect?: { exists?: boolean; mtime?: string };
  /** 可选：旧服务进程不报样张 */
  sample?: { exists?: boolean; mtime?: string };
}

export interface DocxTemplateItem {
  name?: string;
  path?: string;
  mtime?: string;
  files?: DocxTemplateFiles;
  /** 有 `reference.docx` 才算已生成。可选：旧服务进程没有，前端退回看 `files.reference.exists` */
  generated?: boolean;
  /** 采集报告里记的来源（工作空间相对路径），只用来显示 */
  source?: string;
  /** 来源还在 `input/raw/` 里时给出它的 docKey，「继续」「重新提炼」据此接着做 */
  sourceDocKey?: string;
  /** `profile.json#front`：有 front.docx 时才给。可选：旧服务、不带前置区的模板都没有 */
  front?: DocxProfileFront;
}

/**
 * 字段角色：标题 / 客户单位 / 编制单位 / 日期 / 文档类型 / 清空 / 保持原样。
 * `clear` 删掉文字、保留段落与格式（标题续行这类本文没有对应信息的段落）；旧脚本不认它，选了会以「决定无效」拒绝
 */
export type DocxFrontRole = 'title' | 'client' | 'vendor' | 'date' | 'doctype' | 'clear' | 'keep';
/** 前置区表格的清空规则 */
export type DocxTableRule = 'keepHeader' | 'keepLabels' | 'keepHeaderAndLabels' | 'keepAll';

/** profile.json 的 front 段 */
export interface DocxProfileFront {
  fields?: Record<string, DocxFrontRole | (string & {})>;
  tables?: Record<string, DocxTableRule | (string & {})>;
  /** 分节 id → 名称（封面、签署页……） */
  sections?: Record<string, string>;
  /** 日期的写法（形态标记，如 `YYYY年MM月`），转换时按它写当天日期。旧模板没有 */
  dateFormat?: string;
}

/** 模板索引。目录不在时 `available: false`、`items` 为空，状态码仍是 200。 */
export interface DocxTemplateIndex {
  dir?: string;
  available?: boolean;
  items?: DocxTemplateItem[];
}

export interface DocxTemplateDetail extends DocxTemplateItem {
  /** `spec.md` 原文。文件不在或读不动时是空串 */
  spec?: string;
  /** `collect/report.json`。没采集过、读不了、旧服务进程时缺省 */
  report?: DocxCollectReport;
}

/**
 * 段落的实际生效格式（单位：pt / 字符 / 倍），由工作空间 scripts/docxkit/collect.py 算出。
 * 键名是那边 `describe()` 的输出，改名两边一起改。
 */
export interface DocxFmt {
  eastAsia: string | null;
  ascii: string | null;
  size: number | null;
  bold: boolean;
  jc: string;
  firstLineChars: number | null;
  firstLinePt: number | null;
  hanging: boolean;
  leftChars: number | null;
  leftPt: number | null;
  before: number;
  after: number;
  beforeLines: number | null;
  afterLines: number | null;
  line: number | null;
  lineExact: number | null;
  lineAtLeast: number | null;
  outline: number | null;
}

/** 格式簇：同区域、生效格式完全相同的段落。示例只有「编号前缀 + 字数」，不含正文。 */
export interface DocxCluster {
  id: string;
  zone: 'body' | 'table';
  count: number;
  fmt: DocxFmt;
  styles: Record<string, number>;
  manualNum: Record<string, number>;
  autoNum: Record<string, number>;
  numbered: number;
  avgLen: number;
  samples: string[];
  /** 主样式的定义值（正文区才有）；与 fmt 不同的项列在 mismatch 里 —— 「样式定义不可信」 */
  styleDefined: DocxFmt | null;
  mismatch: string[];
  /** 有大纲级别却没有编号：伪标题 */
  pseudoHeading: boolean;
  /** 建议角色；null = 建议丢弃（目录项等） */
  suggestedRole?: string | null;
}

export interface DocxOutlineLevel {
  level: number;
  count: number;
  numbered: number;
  styles: Record<string, number>;
  autoNum: Record<string, number>;
  autoNumFmt?: Record<string, number>;
  manualNum: Record<string, number>;
  clusters: string[];
}

/** `collect/report.json`：采集报告。只列界面用得到的字段，其余原样忽略。 */
export interface DocxCollectReport {
  schema?: number;
  source?: string;
  toolVersion?: string;
  styles?: { total: number; used: number; effective: number; unused: number; custom: number };
  numbering?: { abstract: number; used: number };
  paragraphs?: { total: number; nonEmpty: number; inTable: number; directPpr: number; directRpr: number };
  outline?: DocxOutlineLevel[];
  tables?: { total: number; borderKinds: Record<string, number> };
  clusters: DocxCluster[];
  /** 前置区结构（只有结构与角色标签，不含文字）。没有前置区时为 null；旧脚本采的报告里缺省 */
  front?: DocxFrontReport | null;
}

export interface DocxFrontSection {
  id: string;
  index: number;
  /** 脚本猜的分节类型 */
  guess: 'cover' | 'signoff' | 'revisions' | 'toc' | 'other' | (string & {});
  paragraphs: number;
  tables: string[];
  hasToc: boolean;
  hasImage: boolean;
}

/** 前置区里的一个字段（段落）。文本框和它的兼容回退副本归为一个，`occurrences` 记出现次数 */
export interface DocxFrontField {
  id: string;
  /** 所在节的 index */
  section: number;
  /** 节内序号，从 1 起 */
  order: number;
  chars: number;
  inTextbox: boolean;
  occurrences: number;
  size: number | null;
  bold: boolean;
  jc: string;
  /** 是否「XX单位：」这种带标签的段落（替换时只换冒号后面） */
  labeled?: boolean;
  guess: Exclude<DocxFrontRole, 'keep'> | null;
  /** 页眉页脚里同文出现几处（映射成字段后随它一起替换）。可选：旧脚本采的报告没有，那时不提示 */
  headerHits?: number;
  /** 像日期的段落给出写法（形态标记，如 `YYYY年M月`），不含日期本身。可选 */
  dateFormat?: string;
}

export interface DocxFrontTable {
  id: string;
  section: number;
  rows: number;
  cols: number;
  /** 顶部横跨整行的合并标题行数（任何清空规则下都保留）。可选：旧脚本采的报告没有 */
  captionRows?: number;
  /** 首行（有合并标题行时是其后第一行）像表头 */
  headerLike: boolean;
  /** 像标签表：首列像标签列，或别的列里有「编写(签字)：」这类标签段落（旧脚本只看首列） */
  labelColumn: boolean;
  defaultRule: DocxTableRule;
}

export interface DocxFrontReport {
  blocks: number;
  hasToc: boolean;
  sections: DocxFrontSection[];
  fields: DocxFrontField[];
  tables: DocxFrontTable[];
  sig?: string;
}

/** 簇的决定：三选一。没写到的簇采用报告里的 suggestedRole。 */
export type DocxClusterDecision = { role: string } | { merge: string } | { drop: true };

/**
 * 提炼第 ②③ 步的决定，经 stdin 交给 docx_template.py build。**不许出现路径**：
 * 服务端对 path / file / dir / url 这类键名、含分隔符的值一律 400。
 */
export interface DocxDecisions {
  schema?: 1;
  clusters?: Record<string, DocxClusterDecision>;
  /** 同一角色格式不一致时选定的值，键是「角色.属性」，如 `BodyText.line` */
  choices?: Record<string, string | number | boolean>;
  /** 第 ④ 步的前置区确认。没写到的字段 / 表格用报告里的猜测；`disabled` = 不要前置区 */
  front?: {
    disabled?: boolean;
    fields?: Record<string, DocxFrontRole>;
    tables?: Record<string, DocxTableRule>;
    sections?: Record<string, string>;
  };
}

export interface DocxConflict {
  key: string;
  options: { value: string | number | boolean; count: number }[];
  chosen: string | number | boolean;
}

export interface DocxCollectResult {
  ok: true;
  toolVersion?: string;
  written?: string[];
  clusters?: number;
}

export interface DocxBuildResult {
  ok: true;
  toolVersion?: string;
  written?: string[];
  /** 反查样张时不一致的项、缺 pandoc 跳过样张等；空数组 = 样张各角色格式与规范一致 */
  warnings?: string[];
  log?: string[];
  conflicts?: DocxConflict[];
  roles?: Record<string, number>;
  pandocVersion?: string | null;
}

/** POST /api/projects/:id/docx/convert 的载荷：只有 docKey、模板名与 overwrite，不收路径。 */
export interface DocxConvertRequest {
  docKey: string;
  /** 模板目录名，或 `@base`（通用规范） */
  template: string;
  overwrite?: boolean;
}

export interface DocxConvertResult {
  ok: true;
  toolVersion?: string;
  /** 写出的 .docx（工作空间相对路径） */
  target?: string;
  written?: string[];
  template?: string;
  overwritten?: boolean;
  warnings?: string[];
  log?: string[];
}

/** `/api/health` 的可选字段：docx 工具链的系统依赖。缺字段 = 旧服务，界面不据此置灰。 */
export interface DocxToolsHealth {
  python?: boolean;
  pandoc?: boolean;
  /** 找到的 pandoc 版本；pandoc 为 false 而这里有值，说明版本低于 3 */
  pandocVersion?: string | null;
  /** 只在 `healthFor(工作空间)` 时有：这个工作空间有没有 docx 工具链脚本（旧工作空间没有） */
  scripts?: boolean;
}

export interface Health {
  ok: boolean;
  platform?: string;
  version?: string;
  /** 服务允许写操作（环回监听）。false 时写按钮置灰并说明；缺字段 = 旧服务，不置灰 */
  writable?: boolean;
  docxTools?: DocxToolsHealth;
}

export interface NoteHistory {
  file: string;
  batches: NoteHistoryBatch[];
  batch?: NoteHistoryBatch;
  /**
   * 这份预览文件对应的产出物记录。`null` = 新服务确认没有记录。
   * 缺字段 = 旧服务，调用方不要据此显示「还没有记录」。
   */
  recordId?: string | null;
  /** 批注文件的工作空间相对路径。没有记录时不给 */
  noteFile?: string;
  /** 文件在，但格式读不出来。必须显示，不能当成没有批注 */
  noteFileBroken?: boolean;
  noteFileReason?: string;
}

/**
 * 复制提示词时落盘的返回。和提示词是同一次点击的两半：
 * 这里的 `noteId` 写进提示词，agent 按它回写。
 */
export interface NoteSaveResult {
  recordId: string;
  noteFile: string;
  /** 这一批写进「- 对象：」行的路径。可选：旧服务不给 */
  target?: string;
  /** 这次是不是新建了批注文件。追加到已有文件上为 false */
  created?: boolean;
  items: Array<{
    number?: number;
    noteId: string;
    /** 文件里已经有同一条（区间 + 原文 + 意见），没有再追加 */
    duplicate?: boolean;
  }>;
}

/** 规则库里的一条规则（`rules.md` 的 `### R001 短名` 及其列表项） */
export interface DeaiRule {
  id: string;
  name: string;
  /** 引用 / 强调 / 结构 / 措辞 / 格式 */
  category: string;
  /** 启用 / 停用（原文） */
  status: string;
  enabled: boolean;
  criteria?: string;
  bad?: string;
  good?: string;
  fix?: string;
  /** 来源：模板首版、某份交付稿的批注 N0002、某次体检…… */
  source?: string;
}

/** 还有待处理批注的交付稿版本（工作台「批注 → 修改 → 沉淀」卡片用） */
export interface DeaiPendingDelivery {
  path: string;
  source: string;
  version: string;
  recordId?: string;
  pending: number;
}

/** GET deai/rules。技能没装时只有 `installed: false` */
export interface DeaiRules {
  installed: boolean;
  version?: number;
  updated?: string;
  rules?: DeaiRule[];
  /** `history/` 下已有的快照，按版本倒序 */
  versions?: Array<{ version: number; mtime: string }>;
  /** `CHANGELOG.md` 原文 */
  changelog?: string;
  pendingDeliveries?: DeaiPendingDelivery[];
  /** 解析不出来的条目等 */
  warnings?: string[];
}

/** GET deai/rules/versions/:n：某一版快照 */
export interface DeaiRuleVersion {
  version: number;
  updated?: string;
  text: string;
  rules?: DeaiRule[];
}

/** 一版交付稿 */
export interface DeliveryVersion {
  /** `v002` */
  version: string;
  path: string;
  /** 转成 Word 用 */
  docKey: string;
  mtime?: string;
  created: string;
  /** `source`（去味首版）或 `v001` */
  basedOn: string;
  /** 本版处理的批注编号 */
  notes: string[];
  rulesVersion: number | null;
  /** 形如 `R001×13, R004×40` */
  hits: string;
  note: string;
  /** 原稿在这一版之后又改过 */
  sourceChanged: boolean;
  /** 有人绕过批注直接改了这一版 */
  directlyEdited: boolean;
  /** 这一版上还有几条待处理批注。可选：旧服务不给 */
  pendingNotes?: number;
}

/** GET delivery?docKey=：某份原稿的交付稿 */
export interface DeliveryList {
  source: string;
  dir?: string;
  versions: DeliveryVersion[];
  /** 原稿的记录编号；没有记录时缺省（交付稿上的批注会退回看板缓存） */
  recordId?: string;
}

/**
 * 请求失败时抛的错误。`status` 是 HTTP 状态码 —— 调用方靠它区分
 * 「老服务进程没有这个接口」(404，可以降级) 与「真的出错了」(500 / 其它，必须如实报)。
 * 只带 message 的老写法照旧能用（catch 里读 `.message`）。
 */
export class ApiError extends Error {
  status: number;
  /** 可选的错误类别（docx 工具链的接口会给，如 `no-script` / `no-pandoc` / `not-generated`） */
  kind?: string;
  constructor(message: string, status: number, kind?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
  }
}

/** 旧服务进程没有这个接口（404「未知接口」）：界面应提示重启看板，而不是当成真的出错。 */
export function isUnsupported(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && err.message.startsWith('未知接口');
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
    throw new ApiError(detail.error || `请求失败（${res.status}）`, res.status,
      typeof detail.kind === 'string' ? detail.kind : undefined);
  }
  return res.json() as Promise<T>;
}

export const api = {
  /**
   * platform 是服务**所在机器**的 process.platform，用来定「在访达中显示」这类文案。
   * version 是看板自己的版本（env / 发版注入的 package.json / git v* tag）。
   * 两者都可选：老服务进程没有，缺了 platform 按 macOS 的说法走、version 不显示。
   */
  health: () => request<Health>('/api/health'),
  /**
   * 带上工作空间：docxTools 会把那个工作空间 .env 里的 PANDOC_BIN 也算上（与脚本查找顺序一致）。
   * 旧服务进程忽略这个参数，也没有 docxTools 字段。
   */
  healthFor: (projectId: string) => request<Health>(`/api/health?project=${encodeURIComponent(projectId)}`),
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
  /**
   * 未决问题索引：服务端扫 `output/questions/` 现算，只读 front-matter 不读正文。
   * 没有索引文件可依赖 —— 生成物会漂，而「索引和正文对不上」正是这套结构要消除的病根。
   *
   * **老服务进程没有这个接口（404），调用方必须兜住**：显示「服务端未提供未决问题接口，
   * 请重启服务」，不要白屏、不要弹错误、更不要当成空列表（空列表会被读成「这个工作空间
   * 没有未决问题」，那是假消息）。
   */
  questions: (id: string) => request<QuestionIndex>(`/api/projects/${id}/questions`),
  /**
   * 单条问题的全字段 + 正文。卡片展开时才取，清单不带正文。
   * 只传编号（`Q0134`），**不接受任何路径** —— 带路径片段的一律 400，落盘路径由服务端拼。
   */
  question: (id: string, questionId: string) =>
    request<QuestionDetail>(`/api/projects/${id}/questions/${encodeURIComponent(questionId)}`),
  /**
   * 保存一条人工反馈。**看板唯一一处自己写工作空间的接口**
   * （AGENTS.md 不变量 1 的第四条窄例外，六条约束写在那里）。
   *
   * 只改已存在文件的人写区四个字段与正文「## 人工反馈」小节；不新建、不删除、不改名。
   * 返回保存后的整条详情 —— 前端据此立刻更新，不等 SSE 绕一圈回来。
   * 老服务进程没有这个接口（404 「未知接口」），调用方要兜住并提示重启服务。
   */
  saveQuestion: (id: string, questionId: string, patch: QuestionPatch) =>
    request<QuestionDetail>(`/api/projects/${id}/questions/${encodeURIComponent(questionId)}`, {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
  /**
   * 产出物记录索引：服务端扫 `output/records/` 现算，只读 front-matter 不读正文。
   * 与未决问题同构，连「不依赖任何索引文件」的理由都是同一条。
   *
   * **老服务进程没有这个接口（404），调用方必须兜住**：产出物页显示「请重启服务」空态，
   * 不要白屏、不要弹错误、也不要当成「这个工作空间没有产出物记录」。
   */
  records: (id: string) => request<OutputRecordIndex>(`/api/projects/${id}/records`),
  /**
   * 单条记录的全字段 + 状态流水 + 正文。展开详情时才取，清单不带正文。
   * 只传编号（`I0007`），**不接受任何路径** —— 带路径片段的一律 400，落盘路径由服务端拼。
   */
  record: (id: string, recordId: string) =>
    request<OutputRecordDetail>(`/api/projects/${id}/records/${encodeURIComponent(recordId)}`),
  /**
   * 保存一次状态变更（状态 + 一句说明）。**看板第二处自己写工作空间的接口**
   * （AGENTS.md 不变量 1 的第六条窄例外，六条约束写在那里）。
   *
   * 只改已存在记录的人写区三个字段与正文「## 状态流水」小节；不新建、不删除、不改名。
   * 返回保存后的整条详情 —— 前端据此立刻更新，不等 SSE 绕一圈回来。
   * 老服务进程没有这个接口（404 「未知接口」），调用方要兜住并提示重启服务。
   */
  /**
   * 一次归档：服务端 spawn 工作空间的 scripts/archive_output.py，把组根目录下的一份产出物
   * 移进同组的 `一次归档/`，同步等脚本退出。看板自己不写盘（不变量 1 第七条窄例外）。
   * 失败时错误信息是脚本或服务端的原话，照原文显示。
   * 老服务进程没有这个接口（404 「未知接口」），`request` 已经把「重启 serve」写进提示。
   */
  archiveOutput: (id: string, body: ArchiveRequest) =>
    request<ArchiveResult>(`/api/projects/${id}/archive`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  saveRecordStatus: (id: string, recordId: string, patch: RecordStatusPatch) =>
    request<OutputRecordDetail>(`/api/projects/${id}/records/${encodeURIComponent(recordId)}`, {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
  /**
   * 看板反馈单索引：扫 `output/feedback/`，并附带旧目录 `.kanban-feedback/` 的份数。
   * **老服务进程没有这个接口（404），调用方必须识别为 unsupported**：
   * 提示重启，不要当成「这个工作空间没有反馈单」。
   */
  feedbackIndex: (id: string) => request<FeedbackIndex>(`/api/projects/${id}/feedback`),
  /** 单条反馈单。只传编号（`F0003`），带路径片段的一律 400。 */
  feedbackDetail: (id: string, feedbackId: string) =>
    request<FeedbackDetail>(`/api/projects/${id}/feedback/${encodeURIComponent(feedbackId)}`),
  /**
   * 用户确认「我已发出」之后写 `sent_at` 并追加一条发送记录
   * （AGENTS.md 不变量 1 的第八条窄例外）。
   * 时间以服务端为准，载荷里的 `sent_at` 会被忽略；带上其它字段则 400。
   */
  feedbackMarkSent: (id: string, feedbackId: string) =>
    request<FeedbackDetail>(`/api/projects/${id}/feedback/${encodeURIComponent(feedbackId)}/sent`, {
      method: 'POST',
      body: JSON.stringify({ sent_at: '' }),
    }),
  /**
   * `output/docx-template/` 的一层子目录。只读。
   * 老服务 404 时调用方识别为 unsupported，演示流程不依赖这份列表。
   */
  docxTemplates: (id: string) => request<DocxTemplateIndex>(`/api/projects/${id}/docx-templates`),
  docxTemplate: (id: string, name: string) =>
    request<DocxTemplateDetail>(
      `/api/projects/${id}/docx-templates/${encodeURIComponent(name)}`,
    ),
  /**
   * 提炼第 ② 步「开始分析」：服务端 spawn 工作空间的 docx_template.py collect（第九条例外）。
   * 载荷只有 docKey 与 regenerate。重名未确认 409、非环回 403、缺脚本 / Python 400（kind 说明是哪种）。
   * 旧服务进程 404，调用方用 `isUnsupported` 识别并提示重启。
   */
  docxCollect: (id: string, name: string, body: { docKey: string; regenerate?: boolean }) =>
    request<DocxCollectResult>(`/api/projects/${id}/docx-templates/${encodeURIComponent(name)}/collect`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 提炼第 ④ 步「生成模板」：决定经 stdin 交给脚本。已生成未确认重新生成 409。 */
  docxBuild: (id: string, name: string, body: { docKey: string; decisions: DocxDecisions; regenerate?: boolean }) =>
    request<DocxBuildResult>(`/api/projects/${id}/docx-templates/${encodeURIComponent(name)}/build`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * 「转成 Word」：服务端 spawn 工作空间的 md2docx.py（第九条例外），成品落在 .md 同目录同名。
   * 同名文件没有生成标记 409（kind `not-generated`）、带标记但没勾覆盖 409（`exists`）、缺 pandoc 400（`no-pandoc`）。
   */
  docxConvert: (id: string, body: DocxConvertRequest) =>
    request<DocxConvertResult>(`/api/projects/${id}/docx/convert`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
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
  /**
   * 以二进制取回文件（.docx 预览用）。新服务按 MIME 直出；旧服务进程不认 .docx，
   * 会把它当文本包进 JSON —— 这时抛 `kind: 'old-server'`，调用方提示重启后可预览，而不是喂给渲染器。
   */
  fileArrayBuffer: async (id: string, path: string): Promise<ArrayBuffer> => {
    const res = await fetch(`/api/projects/${id}/file?path=${encodeURIComponent(path)}`);
    if (!res.ok) {
      const detail = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(detail.error || `请求失败（${res.status}）`, res.status);
    }
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      throw new ApiError('看板服务是旧版本，还不能直出这类文件；重启看板后可预览', 200, 'old-server');
    }
    return res.arrayBuffer();
  },
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
   * 触发原型工作区的 workspace-sync.mjs --both；立刻返回，进度用 protoSyncStatus 轮询。
   * 看板只 spawn，写盘的是那个脚本；镜像落盘由 visualization/ 的 SSE 捕获，原型 tab 自己刷新。
   *
   * 请求只带已接入原型的 itemKey，不接受任何路径。
   * 旧服务进程没有这个接口（404），request 会带上「重启 serve」的提示。
   */
  startProtoSync: (id: string, item: string) =>
    request<ProtoSyncJob>(`/api/projects/${id}/proto-sync`, {
      method: 'POST',
      body: JSON.stringify({ item }),
    }),
  protoSyncStatus: (id: string) => request<ProtoSyncJob>(`/api/projects/${id}/proto-sync`),
  /**
   * 触发工作空间 scripts/web_ingest.py --inbox；立刻返回，进度用 webIngestStatus 轮询。
   * 看板只 spawn，写盘的是那个脚本；落盘由 visualization/ 与 input/ 的 SSE 捕获。
   *
   * **请求不带路径、文件名或 URL**，参数由服务端写死为 `--inbox`。
   * 旧服务进程没有这个接口（404），request 会带上「重启 serve」的提示。
   */
  startWebIngest: (id: string) =>
    request<WebIngestJob>(`/api/projects/${id}/web-ingest`, { method: 'POST' }),
  webIngestStatus: (id: string) => request<WebIngestJob>(`/api/projects/${id}/web-ingest`),
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
   * 预览批注历史。有产出物记录时读工作空间 `output/records/notes/I<编号>.md`，
   * 没有记录时退回看板缓存 `~/.pmwork/dashboard/note-history/`，两边合并。
   * 旧服务没有这套字段（整段 404 时接口本身也不在），调用方要兜住并当成没有历史。
   */
  noteHistory: (id: string, file: string) =>
    request<NoteHistory>(`/api/projects/${id}/note-history?file=${encodeURIComponent(file)}`),
  /**
   * 没有记录时的退路：写看板缓存，不写工作空间。
   * 有记录的批次走 saveNotes，不要再调这个。
   */
  appendNoteHistory: (id: string, file: string, notes: NoteHistoryItem[]) =>
    request<NoteHistory>(`/api/projects/${id}/note-history`, {
      method: 'POST',
      body: JSON.stringify({ file, notes }),
    }),
  /**
   * 有记录时的落盘，和「复制提示词」是同一次点击。
   * 只提交编号和批注内容，不带路径。返回每条的 `N` 编号，提示词用它。
   * 非环回 403，记录不存在 404，超限或载荷带路径 400。
   */
  saveNotes: (id: string, recordId: string, notes: NoteHistoryItem[], deliveryVersion?: string) =>
    request<NoteSaveResult>(`/api/projects/${id}/note-history`, {
      method: 'POST',
      // 交付稿上的批注只多带版本号（v002），对象路径由服务端用记录的 target 拼，请求仍不带路径
      body: JSON.stringify(deliveryVersion ? { recordId, notes, deliveryVersion } : { recordId, notes }),
    }),
  /**
   * 去 AI 味规则库（只读）。技能没装时 `installed: false`。
   * **旧服务进程 404，调用方用 `isUnsupported` 识别**：工作台卡片不显示计数，模块页提示重启。
   */
  deaiRules: (id: string) => request<DeaiRules>(`/api/projects/${id}/deai/rules`),
  /** 某一版规则库快照。版本号不是正整数 400，没有这一版 404（不是「未知接口」） */
  deaiRuleVersion: (id: string, version: number) =>
    request<DeaiRuleVersion>(`/api/projects/${id}/deai/rules/versions/${encodeURIComponent(String(version))}`),
  /**
   * 某份原稿的交付稿版本（只读）。只收原稿的 docKey。
   * **旧服务进程 404 时阅读器不显示版本条、不报错**（`isUnsupported`）。
   */
  deliveryVersions: (id: string, docKey: string) =>
    request<DeliveryList>(`/api/projects/${id}/delivery?docKey=${encodeURIComponent(docKey)}`),
  /** 只清看板缓存那一半。工作空间里的批注文件不动，响应里它们还在。 */
  clearNoteHistory: (id: string, file: string) =>
    request<NoteHistory>(`/api/projects/${id}/note-history?file=${encodeURIComponent(file)}`, {
      method: 'DELETE',
    }),
};
