export type ReaderKind = 'markdown' | 'table' | 'image' | 'text' | 'external';

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
}

export interface ConvertedItem extends FileItem {
  isDir: boolean;
  sheets?: FileItem[];
  source?: string;
  sourceSha256?: string;
  convertedBy?: string;
  convertedAt?: string;
  warning?: string;
  extractedImages?: number;
}

export interface PrototypeItem {
  itemKey: string;
  title: string;
  url: string;
}

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
  scannedAt: string;
  meta: ProjectMeta;
  input: {
    raw: FileItem[];
    converted: ConvertedItem[];
    assets: FileItem[];
    pending: FileItem[];
    indexPath: string;
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
    };
  };
  prototypes: Prototypes;
}

export interface Project {
  id: string;
  name: string;
  root: string;
  createdAt: string;
  updatedAt: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(detail.error || `请求失败（${res.status}）`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  projects: () => request<{ projects: Project[]; activeProjectId: string }>('/api/projects'),
  addProject: (root: string, name?: string) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ root, name }) }),
  createWorkspace: (name: string, path: string) =>
    request<Project>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name, path }) }),
  template: () => request<{ root: string; ok: boolean }>('/api/template'),
  removeProject: (id: string) => request<{ removed: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  scan: (id: string) => request<Scan>(`/api/projects/${id}/scan`),
  prototypes: (id: string) => request<Prototypes>(`/api/projects/${id}/prototypes`),
  file: (id: string, path: string) =>
    request<{ path: string; size: number; mtime: string; content: string }>(
      `/api/projects/${id}/file?path=${encodeURIComponent(path)}`,
    ),
  fileUrl: (id: string, path: string) => `/api/projects/${id}/file?path=${encodeURIComponent(path)}`,
  reveal: (id: string, path: string, mode: 'reveal' | 'open' = 'reveal') =>
    request<{ ok: boolean }>(`/api/projects/${id}/reveal`, {
      method: 'POST',
      body: JSON.stringify({ path, mode }),
    }),
};
