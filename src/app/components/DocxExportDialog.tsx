import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ClipboardCopy, FileOutput, SquareArrowOutUpRight } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBackdrop,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/dialog';
import { writeClipboard } from '@/components/Primitives';
import { useDocxTools } from '@/hooks/useDocxTools';
import { ApiError, api, isUnsupported, type DocxTemplateItem, type FileItem } from '@/lib/api';
import { BASE_TEMPLATE, convertPrompt } from '@/lib/docxPrompt';
import { cn } from '@/lib/utils';

const storageKey = (projectId: string) => `aispace-kanban:docx-template:${projectId}`;

function readSaved(projectId: string): string {
  try {
    return localStorage.getItem(storageKey(projectId)) || '';
  } catch {
    return '';
  }
}

function saveChoice(projectId: string, template: string) {
  try {
    localStorage.setItem(storageKey(projectId), template);
  } catch {
    /* 隐私模式等存不了就算了：下次默认回到通用规范 */
  }
}

const isGenerated = (t: DocxTemplateItem) => t.generated ?? Boolean(t.files?.reference?.exists);

/**
 * sonner 悬停时用挂载时量的 `--initial-height` 锁住 toast 高度，
 * 只在 title / description / action 变了才重测。details 展开不改这些 props，
 * 内容会画出卡片；这里按当前内容把变量写回去。
 * 样式里对 `.docx-result-toast` 还有一条 `height: auto`，避免这次写回被下一次
 * 悬停重绘冲掉之前先闪一帧旧高度。
 * 不走 `toast()` 更新：只有一条通知时，更新会让 sonner 把悬停清掉并重新计时。
 * 排在后面的 toast 的 `--offset` 仍按展开前的高度算，这里改成现在的内容高度。
 */
function syncSonnerToastHeight(node: HTMLElement) {
  const toastEl = node.closest('[data-sonner-toast]');
  if (!(toastEl instanceof HTMLElement)) return;
  const locked = toastEl.style.height;
  toastEl.style.height = 'auto';
  const height = Math.ceil(toastEl.getBoundingClientRect().height);
  toastEl.style.height = locked;
  if (height <= 0) return;
  toastEl.style.setProperty('--initial-height', `${height}px`);

  const list = toastEl.parentElement;
  if (!list) return;
  const gap = Number.parseFloat(getComputedStyle(list).getPropertyValue('--gap')) || 0;
  const items = [...list.querySelectorAll<HTMLElement>(':scope > [data-sonner-toast]')];
  const index = items.indexOf(toastEl);
  if (index < 0) return;
  let before = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemHeight = item === toastEl ? height : Math.ceil(item.getBoundingClientRect().height);
    if (i > index) item.style.setProperty('--offset', `${i * gap + before}px`);
    before += itemHeight;
  }
}

function ConvertResultNotice({
  unfilled,
  warnings,
  log,
  archived,
}: {
  unfilled: number;
  warnings: string[];
  log: string[];
  archived?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // 没有依赖：sonner 每次悬停进出都会重绘，并把 --initial-height 写回它记住的旧值。
  // 这个 effect 在绘制前跑，才能把刚写回去的旧高度改成现在的内容高度。
  useLayoutEffect(() => {
    if (ref.current) syncSonnerToastHeight(ref.current);
  });
  return (
    <div ref={ref} className="flex flex-col gap-1">
      {archived ? <span>上一份已改名为 {archived.split('/').pop()}</span> : null}
      {unfilled ? <span className="text-destructive">有 {unfilled} 处待填，发出前在 Word 里补上</span> : null}
      {warnings.length ? <span>注意：{warnings.join('；')}</span> : null}
      {log.length ? (
        <details onToggle={(event) => syncSonnerToastHeight(event.currentTarget)}>
          <summary className="cursor-pointer">处理记录（{log.length} 条）</summary>
          <ul className="mt-1 list-disc pl-4">
            {log.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function showConvertResultToast({
  name,
  archived,
  warnings,
  log,
  onPreview,
}: {
  name: string;
  /** 上一份改名后的路径 */
  archived?: string;
  warnings: string[];
  log: string[];
  onPreview: () => void;
}) {
  // 封面字段没取到值：成品里是「【待填：…】」，发出前必须补，用 orange 单独点出来
  const unfilled = warnings.filter((w) => w.includes('【待填')).length;
  const duration = warnings.length || log.length ? 15000 : 6000;
  toast.success(`已生成 ${name}`, {
    className: 'docx-result-toast',
    description: warnings.length || log.length ? (
      <ConvertResultNotice unfilled={unfilled} warnings={warnings} log={log} archived={archived} />
    ) : archived ? `上一份已改名为 ${archived.split('/').pop()}` : undefined,
    action: { label: '预览', onClick: onPreview },
    duration,
  });
}

/**
 * 产出 `.md` 的「转成 Word」：选模板，然后「转换」（服务端 spawn md2docx.py，第九条例外）或「复制提示词」。
 *
 * 同名 `.docx` 的处理按服务端下发的 `docxGenerated`：带生成标记的上一份由脚本改名为
 * `<基名>-<上次转换时间>.docx` 保留，再写新的（载荷总带 `archive: true`，没有同名文件时它不起作用）；
 * 没有标记直接说明为什么不能转。服务端与脚本还会各自再校验一次，这里只是提前告诉人。
 */
export function DocxExportDialog({
  projectId,
  item,
  outputItems,
  onClose,
  onConverted,
  onOpenTemplateRefine,
}: {
  projectId: string;
  /** 来源 .md；null = 关闭 */
  item: FileItem | null;
  /** 产出三组的全部条目，用来判断目标 .docx 在不在、是不是工具生成的 */
  outputItems: FileItem[];
  onClose: () => void;
  /** 转换成功：交出成品条目，toast 的「预览」用它打开阅读器 */
  onConverted: (target: FileItem) => void;
  onOpenTemplateRefine?: (name?: string) => void;
}) {
  const open = Boolean(item);
  const { readOnlyReason, pandocReason, scriptsMissing } = useDocxTools(projectId, open);
  const [templates, setTemplates] = useState<DocxTemplateItem[]>([]);
  const [templatesNote, setTemplatesNote] = useState('');
  const [template, setTemplate] = useState(BASE_TEMPLATE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; kind?: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    let cancelled = false;
    (async () => {
      let items: DocxTemplateItem[] = [];
      try {
        items = (await api.docxTemplates(projectId)).items ?? [];
        setTemplatesNote('');
      } catch (err) {
        setTemplatesNote(isUnsupported(err) || (err instanceof ApiError && err.status === 404)
          ? '看板服务是旧版本，读不到客户模板；重启后可用'
          : `读不到客户模板：${(err as Error).message}`);
      }
      if (cancelled) return;
      setTemplates(items);
      const saved = readSaved(projectId);
      const usable = saved === BASE_TEMPLATE || items.some((t) => t.name === saved && isGenerated(t));
      setTemplate(usable ? saved : BASE_TEMPLATE);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  const targetPath = item ? item.path.replace(/\.md$/i, '.docx') : '';
  const targetName = targetPath.split('/').pop() || '';
  const listed = useMemo(() => outputItems.find((f) => f.path === targetPath), [outputItems, targetPath]);
  // 交付稿不在扫描里：阅读器把交付稿接口查到的同名 .docx 传进来；查不到时由服务端判断
  const existing = listed;
  const blockedByHand = existing?.docxGenerated === false || error?.kind === 'not-generated';
  const willArchive = Boolean(existing) && !blockedByHand;
  const stem = targetName.replace(/\.docx$/i, '');

  const convertBlocked = !item?.docKey
    ? '看板服务是旧版本，重启后可用'
    : readOnlyReason || pandocReason
      || (scriptsMissing || error?.kind === 'no-script' ? '这个工作空间还没有 docx 工具链，用「复制提示词」让工作空间 AI 补齐' : '')
      || (blockedByHand ? '同名的 Word 不是本工具生成的，为避免覆盖人工修改，请先改名或移走' : '');

  const choose = (name: string) => {
    setTemplate(name);
    saveChoice(projectId, name);
    setError(null);
  };

  const copyPrompt = async () => {
    if (!item) return;
    const ok = await writeClipboard(convertPrompt({
      mdPath: item.path,
      template,
      scriptsMissing: scriptsMissing || error?.kind === 'no-script',
    }));
    if (ok) toast.success('已复制提示词，粘给工作空间 AI 执行');
    else toast.error('复制失败：浏览器没给剪贴板权限');
  };

  const convert = async () => {
    if (!item?.docKey || convertBlocked) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.docxConvert(projectId, {
        docKey: item.docKey,
        template,
        archive: true,
      });
      const path = result.target || targetPath;
      const name = path.split('/').pop() || targetName;
      const target: FileItem = {
        path, name, ext: '.docx', reader: 'external', size: 0, mtime: new Date().toISOString(), title: name.replace(/\.docx$/i, ''),
      };
      const warnings = result.warnings ?? [];
      const log = result.log ?? [];
      showConvertResultToast({
        name,
        archived: result.archived,
        warnings,
        log,
        onPreview: () => onConverted(target),
      });
      onClose();
    } catch (err) {
      // 新服务收到 archive 不会回 exists：回了说明服务进程是旧版，不认识 archive
      const message = isUnsupported(err)
        ? '看板服务是旧版本，还没有转换接口；重启看板后再试'
        : err instanceof ApiError && err.kind === 'exists'
          ? `${targetName} 已存在，旧版看板服务不会把它改名保留；重启看板后再转换`
          : (err as Error).message;
      setError({ message, kind: err instanceof ApiError ? err.kind : undefined });
    } finally {
      setBusy(false);
    }
  };

  const options: { name: string; label: string; hint: string; disabled: boolean }[] = [
    { name: BASE_TEMPLATE, label: '通用规范', hint: '宋体正文、黑体标题、1 / 1.1 / 1.1.1 编号', disabled: false },
    ...templates.map((t) => ({
      name: t.name || '',
      label: t.name || '',
      hint: isGenerated(t) ? '客户模板' : '还没生成模板',
      disabled: !isGenerated(t),
    })),
  ];

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>转成 Word</DialogTitle>
            <DialogDescription className="truncate" title={item?.path}>
              {item?.name} → {targetName}（同目录）
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4 text-sm">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">模板</span>
                {onOpenTemplateRefine ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-muted-foreground"
                    onClick={() => {
                      onClose();
                      onOpenTemplateRefine(template === BASE_TEMPLATE ? undefined : template);
                    }}
                  >
                    在模版洗炼里查看
                    <SquareArrowOutUpRight className="size-3" />
                  </Button>
                ) : null}
              </div>
              <div role="radiogroup" aria-label="模板" className="flex max-h-56 flex-col gap-1 overflow-y-auto">
                {options.map((o) => (
                  <button
                    key={o.name}
                    type="button"
                    role="radio"
                    aria-checked={template === o.name}
                    disabled={o.disabled || busy}
                    onClick={() => choose(o.name)}
                    className={cn(
                      'flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors',
                      template === o.name ? 'border-foreground bg-accent' : 'border-border hover:bg-accent/60',
                      o.disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
                    )}
                  >
                    <span className="truncate">{o.label}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{o.hint}</span>
                  </button>
                ))}
              </div>
              {templates.length === 0 && !templatesNote ? (
                <p className="text-xs text-muted-foreground">
                  还没有客户模板。可以去工作台「模版洗炼」用一份客户旧 Word 提炼一个。
                </p>
              ) : null}
              {templatesNote ? <p className="text-xs text-muted-foreground">{templatesNote}</p> : null}
            </div>

            {existing || blockedByHand ? (
              blockedByHand ? (
                <p className="text-xs text-destructive">
                  同目录已有 {targetName}，但它不是本工具生成的（可能是人手改过另存的，或客户给的原件）。
                  为避免覆盖人工修改，请先把它改名或移走。
                </p>
              ) : willArchive ? (
                <p className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
                  同目录已有上次转换的 {targetName}。转换时它会改名为「{stem}-上次转换时间.docx」留在原处，
                  在 Word 里对它做过的修改不会丢；新成品仍叫 {targetName}。
                </p>
              ) : null
            ) : null}

            {error ? <p className="whitespace-pre-wrap text-xs text-destructive">{error.message}</p> : null}
            {convertBlocked && !error && !blockedByHand ? (
              <p className="text-xs text-muted-foreground">「转换」不可用：{convertBlocked}。「复制提示词」照样能用。</p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => void copyPrompt()}>
              <ClipboardCopy className="size-3.5" />
              复制提示词
            </Button>
            <Button disabled={busy || Boolean(convertBlocked)} title={convertBlocked || undefined} onClick={() => void convert()}>
              <FileOutput className="size-3.5" />
              {busy ? '正在转换…' : '转换'}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
