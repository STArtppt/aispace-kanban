import { useEffect, useRef, useState } from 'react';
import { FolderOpen, SquareArrowOutUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError, api } from '@/lib/api';
import { formatBytes, formatRelative } from '@/lib/format';
import { useFileManagerName } from '@/hooks/useFileManager';

/** 超过这个大小不在浏览器里渲染：docx-preview 要把整份解压进内存，几十 MB 的文档会把标签页拖死。 */
const MAX_BYTES = 30 * 1024 * 1024;

/**
 * 渲染器注入到 iframe 里的少量样式：包装层去掉自带的灰底、iframe 背景透明，
 * 让外框的令牌底色（bg-muted）透出来，切换深浅主题时自动跟随；纸张保持渲染器给的白色。
 */
const FRAME_CSS = `html,body{margin:0;background:transparent;}
.docx-wrapper{background:transparent!important;padding:16px 0!important;}
.docx-wrapper>section.docx{margin:0 auto 16px!important;}`;

type State =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'failed'; reason: string };

/**
 * 阅读器里的 .docx 预览：`docx-preview` 渲染成分页版式，放进**不带脚本权限**的隔离 iframe。
 *
 * - `sandbox` 只有 `allow-same-origin`（看板要把渲染结果写进去）和 `allow-popups*`（文档里的外链开新窗口），
 *   **没有 `allow-scripts`**：文档里的 `javascript:` 链接、任何脚本都不会执行；
 *   docx-preview 注入的全局 `<style>` 也关在 iframe 里，不污染看板样式和深色模式。
 * - 渲染器动态 import，只在第一次打开 .docx 时加载，不进首屏包。
 * - 与 Word 的差异（域不刷新、浮动对象、缺字体回退）底部常驻说明，不当错误。
 * 扫描契约不变：.docx 仍是 `external`，由 Reader 按扩展名分到这里（与 PDF 预览同一做法）。
 */
export function DocxView({
  projectId,
  path,
  title,
  size,
  mtime,
}: {
  projectId: string;
  path: string;
  title: string;
  size: number;
  mtime: string;
}) {
  const fileManager = useFileManagerName();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<State>(() =>
    size > MAX_BYTES ? { kind: 'failed', reason: '文件太大，不在浏览器里渲染。' } : { kind: 'loading' },
  );

  useEffect(() => {
    if (size > MAX_BYTES) {
      setState({ kind: 'failed', reason: '文件太大，不在浏览器里渲染。' });
      return;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    (async () => {
      let lib: typeof import('docx-preview');
      let data: ArrayBuffer;
      try {
        [lib, data] = await Promise.all([import('docx-preview'), api.fileArrayBuffer(projectId, path)]);
      } catch (err) {
        if (cancelled) return;
        const reason = err instanceof ApiError
          ? err.message
          : '预览组件加载失败（可能是网络中断或看板刚升级），刷新页面再试。';
        setState({ kind: 'failed', reason });
        return;
      }
      const frame = frameRef.current;
      const doc = frame?.contentDocument;
      if (cancelled || !frame || !doc) return;
      // 每次重新渲染都从一张干净的文档开始，免得上一份的样式残留
      doc.open();
      doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
      doc.close();
      try {
        await lib.renderAsync(data, doc.body, doc.head, {
          className: 'docx',
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          // altChunk 里可以塞整段 HTML，不渲染；图片走 data URL，不依赖看板源的 blob
          renderAltChunks: false,
          useBase64URL: true,
          experimental: false,
        });
      } catch {
        if (!cancelled) setState({ kind: 'failed', reason: '这份文档浏览器解析不了，可能是加密或损坏。' });
        return;
      }
      if (cancelled) return;
      // 渲染器会先清空 style 容器，所以覆盖样式要在渲染之后再追加
      const style = doc.createElement('style');
      style.textContent = FRAME_CSS;
      doc.head.appendChild(style);
      // 外链开新窗口并切断 opener；javascript: / 本地文件等一律去掉 href（锚点保留，文内跳转用）
      for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
        const href = a.getAttribute('href') || '';
        if (/^(https?:|mailto:)/i.test(href)) {
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
        } else if (!href.startsWith('#')) {
          a.removeAttribute('href');
        }
      }
      setState({ kind: 'ready' });
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, path, size, mtime]);

  const actions = (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => void api.reveal(projectId, path, 'open')}>
        <SquareArrowOutUpRight className="size-3.5" />
        用默认程序打开
      </Button>
      <Button variant="ghost" size="sm" onClick={() => void api.reveal(projectId, path)}>
        <FolderOpen className="size-3.5" />
        在{fileManager}中显示
      </Button>
    </div>
  );

  if (state.kind === 'failed') {
    return (
      <div className="flex flex-col items-start gap-4 rounded-lg border border-dashed border-border px-5 py-8">
        <div className="flex flex-col gap-1">
          <p className="text-sm">{state.reason}</p>
          <p className="text-xs text-muted-foreground">
            {formatBytes(size)} · {formatRelative(mtime)}
          </p>
        </div>
        {actions}
      </div>
    );
  }

  return (
    <div className="flex h-[min(80vh,900px)] flex-col gap-2">
      {actions}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-muted">
        <iframe
          ref={frameRef}
          title={title}
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          className="h-full w-full"
        />
        {state.kind === 'loading' ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            正在渲染…
          </div>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        浏览器预览：目录、页码、题注编号等域不会刷新，本机缺的字体用替代字体显示，分页位置和浮动图片可能与 Word 不同。
        以「用默认程序打开」看到的为准。
      </p>
    </div>
  );
}
