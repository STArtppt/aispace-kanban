export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatRelative(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return '—';
  const diff = Date.now() - d;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return formatDate(iso);
}

export function formatWords(words?: number): string {
  if (!words) return '—';
  return words >= 10000 ? `${(words / 10000).toFixed(1)} 万字` : `${words} 字`;
}

/**
 * 复制给 AI / 文档用的 Markdown 链接：[标题](相对路径)。
 * 路径带空格或括号时用尖括号包起来（CommonMark 的 <destination> 写法），
 * 否则 `原型 (10)` 这类名字会把链接截断。
 */
export function markdownLink(label: string, path: string): string {
  const text = label.replace(/([[\]])/g, '\\$1');
  const dest = /[\s()<>]/.test(path) ? `<${path}>` : path;
  return `[${text}](${dest})`;
}

/** 文件名前缀日期：2026-07-30-xxx.md → 2026-07-30 */
export function datePrefix(name: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[-_]/.exec(name);
  return m ? m[1] : '';
}
