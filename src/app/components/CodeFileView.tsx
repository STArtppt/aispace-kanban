import { Fragment, useEffect, useState, type Ref } from 'react';
import { Check, Copy } from 'lucide-react';
import { writeClipboard } from '@/components/Primitives';
import { cn } from '@/lib/utils';
import { CODE_LANG_BY_EXT } from '../../shared/codeLang.mjs';

/** 取出小写扩展名（含点）。入参可以是 `.py` 也可以是路径。 */
function fileExt(extOrPath: string): string {
  const lower = extOrPath.toLowerCase();
  if (lower.startsWith('.') && !lower.includes('/') && !lower.includes('\\') && lower.lastIndexOf('.') === 0) {
    return lower;
  }
  const base = lower.split(/[\\/]/).pop() || lower;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot) : '';
}

/**
 * 从扩展名或路径取出 Shiki 语言。对不上就返回 undefined —— 调用方走原来的纯文本 <pre>。
 */
export function codePreviewLanguage(extOrPath: string): string | undefined {
  return CODE_LANG_BY_EXT[fileExt(extOrPath)];
}

/** 语言标签用扩展名本身（sql / py / yaml …），不含点。 */
export function codePreviewLabel(extOrPath: string): string {
  const ext = fileExt(extOrPath);
  return ext.startsWith('.') ? ext.slice(1) : ext;
}

function splitShikiLines(html: string): string[] {
  const match = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
  if (!match) return [html];
  const lines = match[1].split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function PlainLines({ code }: { code: string }) {
  const lines = code.split('\n');
  return lines.map((line, index) => (
    <span key={index} className="block">
      {index < lines.length - 1 || code.endsWith('\n') ? `${line}\n` : line}
    </span>
  ));
}

/**
 * 整文件代码预览：Shiki 高亮 + 行号，每行仍是 <pre> 下的 span.block，
 * 检索继续走 collectBlocks 的纯文本分支。不改 vendored CodeBlock。
 *
 * 行号在旁边的 muted 数字里、select-none，不进复制文本。
 * 高亮失败或尚未完成时退回和纯文本预览相同的裸 <pre>。
 */
export function CodeFileView({
  code,
  language,
  label,
  preRef,
}: {
  code: string;
  language: string;
  /** 语言标签，用扩展名（sql / py / yaml …） */
  label: string;
  preRef?: Ref<HTMLPreElement>;
}) {
  const [linesHtml, setLinesHtml] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLinesHtml(null);
    void (async () => {
      try {
        const { codeToHtml } = await import('shiki');
        const html = await codeToHtml(code, {
          lang: language,
          themes: { light: 'github-light', dark: 'github-dark' },
        });
        if (cancelled) return;
        setLinesHtml(splitShikiLines(html));
      } catch {
        // 未知语言或 Shiki 抛错：保持裸 <pre>，人至少还能读到字
        if (!cancelled) setLinesHtml(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const highlighted = Boolean(linesHtml);

  return (
    <div className="relative">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <button
          type="button"
          aria-label={copied ? '已复制' : '复制全文'}
          onClick={() => {
            void writeClipboard(code).then((ok) => {
              if (ok) setCopied(true);
            });
          }}
          className="inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      <pre
        ref={preRef}
        className={cn(
          'm-0 bg-transparent font-mono text-xs leading-6',
          highlighted
            ? 'shiki grid grid-cols-[auto_minmax(0,1fr)]'
            : 'whitespace-pre-wrap',
        )}
      >
        {highlighted && linesHtml
          ? linesHtml.map((lineHtml, index) => (
              <Fragment key={index}>
                <span
                  className="select-none pr-4 text-right text-muted-foreground tabular-nums"
                  aria-hidden
                >
                  {index + 1}
                </span>
                <span
                  className="block min-w-0 whitespace-pre-wrap"
                  dangerouslySetInnerHTML={{
                    __html:
                      (lineHtml || '&nbsp;') +
                      (index < linesHtml.length - 1 || code.endsWith('\n') ? '\n' : ''),
                  }}
                />
              </Fragment>
            ))
          : <PlainLines code={code} />}
      </pre>
    </div>
  );
}
