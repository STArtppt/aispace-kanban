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
 * 产出正文里的标注计数（约定见 template 的 pm-project-handover 技能）：
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
  /** 一条标注都没有时服务端不返回；旧服务进程也没有。缺了就什么都不显示。 */
  annotations?: Annotations;
}

export interface ConvertedItem extends FileItem {
  isDir: boolean;
  sheets?: FileItem[];
  /** html 原型包：目录内可预览的 .html 相对路径 */
  htmlPath?: string;
  htmlName?: string;
  /** 点表等产物的 sqlite 路径（看板只展示路径/SQL 指南，不读二进制） */
  sqlitePath?: string;
  source?: string;
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
 * input/assets/ 下按首层目录聚成的一个图库：一份文档抽出的图算一堆，
 * 没有归属的图归到「未分类」。path 指向图库所在目录，name 是目录名，
 * title 优先用来源文档的标题。
 */
export interface AssetGroup extends FileItem {
  images: FileItem[];
}

/** /api/projects/:id/table 分页预览大 CSV，不把整文件塞进 JSON */
export interface TablePage {
  path: string;
  headerLine: string;
  lines: string[];
  totalRows: number;
  offset: number;
  limit: number;
  size: number;
  mtime: string;
}

export interface PrototypeItem {
  itemKey: string;
  title: string;
  /** 看板伺服的入口地址，新窗口打开 */
  url: string;
  /** folder = 已解压目录；zip = 由看板缓存解压。可选：旧服务进程没有 */
  kind?: 'folder' | 'zip';
  sourcePath?: string;
  mtime?: string;
}

/**
 * prototypes/ 下的 HTML 导出包清单。
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
    stats: {
      raw: number;
      converted: number;
      assets: number;
      pending: number;
      warnings: number;
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
      throw new Error(`${detail.error}（接口服务的进程可能比前端旧，重启 serve 再试）`);
    }
    throw new Error(detail.error || `请求失败（${res.status}）`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  /**
   * platform 是服务**所在机器**的 process.platform，用来定「在访达中显示」这类文案。
   * 可选：老服务进程不返回它，缺了就按 macOS 的说法走（改动前的行为）。
   */
  health: () => request<{ ok: boolean; platform?: string }>('/api/health'),
  projects: () => request<{ projects: Project[]; activeProjectId: string }>('/api/projects'),
  addProject: (root: string, name?: string) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ root, name }) }),
  createWorkspace: (name: string, path: string) =>
    request<Project>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name, path }) }),
  template: () => request<{ root: string; ok: boolean }>('/api/template'),
  updateProject: (id: string, patch: { root?: string; name?: string }) =>
    request<Project>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  candidates: (id: string) =>
    request<{ candidates: RelinkCandidate[] }>(`/api/projects/${id}/candidates`),
  removeProject: (id: string) => request<{ removed: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  scan: (id: string) => request<Scan>(`/api/projects/${id}/scan`),
  prototypes: (id: string) => request<Prototypes>(`/api/projects/${id}/prototypes`),
  file: (id: string, path: string) =>
    request<{ path: string; size: number; mtime: string; content: string }>(
      `/api/projects/${id}/file?path=${encodeURIComponent(path)}`,
    ),
  /** 大 CSV/TSV 分页预览（点表主表等），默认每页 50 行 */
  table: (id: string, path: string, opts?: { offset?: number; limit?: number }) => {
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    const q = new URLSearchParams({
      path,
      offset: String(offset),
      limit: String(limit),
    });
    return request<TablePage>(`/api/projects/${id}/table?${q}`);
  },
  fileUrl: (id: string, path: string) => `/api/projects/${id}/file?path=${encodeURIComponent(path)}`,
  reveal: (id: string, path: string, mode: 'reveal' | 'open' = 'reveal') =>
    request<{ ok: boolean }>(`/api/projects/${id}/reveal`, {
      method: 'POST',
      body: JSON.stringify({ path, mode }),
    }),
  /** 触发工作空间 scripts/ingest.py；立刻返回，进度用 ingestStatus 轮询 */
  startIngest: (id: string) =>
    request<IngestJob>(`/api/projects/${id}/ingest`, { method: 'POST' }),
  ingestStatus: (id: string) => request<IngestJob>(`/api/projects/${id}/ingest`),
};
