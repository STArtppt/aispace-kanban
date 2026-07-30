import { useEffect, useMemo, useState } from 'react';
import Papa from 'papaparse';
import { ChevronDown, ChevronRight, FolderOpen, SquareArrowOutUpRight, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Markdown } from '@/components/Markdown';
import { api, type FileItem } from '@/lib/api';
import { formatBytes, formatRelative } from '@/lib/format';

/** 只做展示用的 frontmatter 拆分，和服务端那份保持一致的宽松规则。 */
function splitFrontmatter(text: string): { meta: [string, string][]; body: string } {
  if (!text.startsWith('---')) return { meta: [], body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { meta: [], body: text };
  const raw = text.slice(text.indexOf('\n') + 1, end);
  const meta: [string, string][] = [];
  for (const line of raw.split(/\r?\n/)) {
    const kv = /^([\w.-]+):\s*(.*)$/.exec(line);
    if (kv && kv[2]) meta.push([kv[1], kv[2]]);
  }
  return { meta, body: text.slice(end + 4).replace(/^\r?\n/, '') };
}

function dirOf(path: string) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** 把 markdown 里的相对图片路径解析成后端的文件接口地址。 */
function resolveRelative(base: string, url: string) {
  if (/^(https?:|data:|#)/.test(url)) return url;
  const segments = `${base}/${url}`.split('/');
  const stack: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return stack.join('/');
}

function SourceBar({ meta }: { meta: [string, string][] }) {
  const [open, setOpen] = useState(false);
  if (!meta.length) return null;
  const warning = meta.find(([k]) => k === 'warning');
  const source = meta.find(([k]) => k === 'source');
  return (
    <div className="mb-6 rounded-lg border border-border bg-muted/40 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <span className="text-muted-foreground">溯源</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{source?.[1] || '—'}</span>
        {warning ? (
          <Badge variant="outline" className="border-destructive text-destructive">
            内容存疑
          </Badge>
        ) : null}
      </button>
      {open ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-border px-3 py-2.5">
          {meta.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{key}</dt>
              <dd className={key === 'warning' ? 'text-destructive' : 'font-mono text-[11px] break-all'}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function CsvTable({ text }: { text: string }) {
  const rows = useMemo(() => {
    const parsed = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true });
    return parsed.data;
  }, [text]);
  if (!rows.length) return <p className="text-sm text-muted-foreground">这张表是空的。</p>;
  const [head, ...body] = rows;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-muted/60">
          <tr>
            {head.map((cell, i) => (
              <th key={i} className="border-b border-border px-3 py-2 text-left text-xs font-medium whitespace-nowrap">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, i) => (
            <tr key={i} className="hover:bg-accent/50">
              {head.map((_, j) => (
                <td key={j} className="border-b border-border px-3 py-2 align-top whitespace-pre-wrap">
                  {row[j] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
        {body.length} 行 × {head.length} 列
      </div>
    </div>
  );
}

export function Reader({
  projectId,
  item,
  onClose,
}: {
  projectId: string;
  item: FileItem;
  onClose: () => void;
}) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const needsContent = item.reader === 'markdown' || item.reader === 'table' || item.reader === 'text';

  useEffect(() => {
    if (!needsContent) {
      setContent('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .file(projectId, item.path)
      .then((data) => {
        if (!cancelled) setContent(data.content);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, item.path, needsContent]);

  const { meta, body } = useMemo(
    () => (item.reader === 'markdown' ? splitFrontmatter(content) : { meta: [], body: content }),
    [content, item.reader],
  );

  const base = dirOf(item.path);

  return (
    <aside className="flex h-full min-w-0 flex-col border-l border-border bg-background">
      <header className="flex items-start gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-sm font-medium">{item.title || item.name}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{item.path}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            title="在访达中显示"
            onClick={() => void api.reveal(projectId, item.path)}
          >
            <FolderOpen className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" title="关闭" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-6 py-5">
        {loading ? <p className="text-sm text-muted-foreground">读取中…</p> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        {!loading && !error && item.reader === 'markdown' ? (
          <>
            <SourceBar meta={meta} />
            <Markdown urlTransform={(url) => api.fileUrl(projectId, resolveRelative(base, url))}>{body}</Markdown>
          </>
        ) : null}

        {!loading && !error && item.reader === 'table' ? <CsvTable text={content} /> : null}

        {!loading && !error && item.reader === 'text' ? (
          <pre className="font-mono text-xs leading-6 whitespace-pre-wrap">{content}</pre>
        ) : null}

        {item.reader === 'image' ? (
          <img
            src={api.fileUrl(projectId, item.path)}
            alt={item.name}
            className="mx-auto max-w-full rounded-lg border border-border"
          />
        ) : null}

        {item.reader === 'external' ? (
          <div className="flex flex-col items-start gap-4 rounded-lg border border-dashed border-border px-5 py-8">
            <div className="flex flex-col gap-1">
              <p className="text-sm">这是原始格式文档，网页里不渲染。</p>
              <p className="text-xs text-muted-foreground">
                {formatBytes(item.size)} · {formatRelative(item.mtime)}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => void api.reveal(projectId, item.path, 'open')}>
                <SquareArrowOutUpRight className="size-3.5" />
                用默认程序打开
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void api.reveal(projectId, item.path)}>
                <FolderOpen className="size-3.5" />
                在访达中显示
              </Button>
            </div>
          </div>
        ) : null}
      </ScrollArea>
    </aside>
  );
}
