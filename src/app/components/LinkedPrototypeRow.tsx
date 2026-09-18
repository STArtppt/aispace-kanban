import { useState } from 'react';
import { ExternalLink, Loader2, MonitorPlay, RefreshCw } from 'lucide-react';
import { CopyButton } from '@/components/Primitives';
import { Button } from '@/components/ui/button';
import type { ProtoSyncControl } from '@/hooks/useIngestJob';
import type { FileItem, PrototypeDoc, PrototypeItem } from '@/lib/api';
import { formatBytes, formatDate, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

const GROUPS: Array<{ key: PrototypeDoc['group']; label: string }> = [
  { key: 'spec', label: '规格' },
  { key: 'docs', label: '文档' },
  { key: 'annotations', label: '标注' },
  { key: 'comments', label: '批注' },
  { key: 'sync', label: '同步清单' },
];

/** 资料多的原型（上百份页面规格）先收起，别把原型 tab 撑成一长条 */
const DOC_PREVIEW = 12;
const DAY = 24 * 60 * 60 * 1000;

function openInNewWindow(href: string) {
  window.open(href, '_blank', 'noopener,noreferrer');
}

/** 资料 md 拼成阅读器认识的 FileItem：走现有 /file 接口，服务端已过 resolveInside */
function toFileItem(doc: PrototypeDoc): FileItem {
  return {
    path: doc.path,
    name: doc.path.split('/').pop() || doc.label,
    ext: '.md',
    reader: 'markdown',
    size: 0,
    mtime: '',
    title: doc.label,
  };
}

function onlineLag(localChangedAt?: string, publishedAt?: string) {
  if (!localChangedAt || !publishedAt) return '';
  const days = Math.floor((Date.parse(localChangedAt) - Date.parse(publishedAt)) / DAY);
  return days >= 1 ? `落后本地改动 ${days} 天` : '落后本地改动（不到 1 天）';
}

function Fact({
  label,
  value,
  sub,
  warn,
}: {
  label: string;
  value: string;
  sub?: string;
  /** 需要人处理的状态才标 orange，其余一律灰阶 */
  warn?: boolean;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5 px-3 py-2', warn && 'bg-destructive/10')}>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          'text-[13px] tabular-nums [overflow-wrap:anywhere]',
          warn && 'font-medium text-destructive',
        )}
      >
        {warn ? <span className="mr-1.5 inline-block size-1.5 rounded-full bg-destructive align-[2px]" /> : null}
        {value}
      </span>
      {sub ? (
        <span className="font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{sub}</span>
      ) : null}
    </div>
  );
}

/**
 * 「视觉内容 · 原型」里一份已接入原型工作区的原型：一行占满宽度。
 * 数据全部来自 item.linked，每一块都可能缺省 —— 缺哪块就少显示哪块，不报错。
 */
export function LinkedPrototypeRow({
  item,
  openPath,
  onOpen,
  protoSync,
}: {
  item: PrototypeItem;
  openPath?: string;
  onOpen?: (file: FileItem) => void;
  protoSync?: ProtoSyncControl;
}) {
  const linked = item.linked || {};
  const { offline, online, sync = {}, refresh } = linked;
  const docs = linked.docs || [];
  const duplicates = linked.duplicates || [];
  const mine = protoSync?.job?.item === item.itemKey;
  const refreshing = Boolean(protoSync?.running && mine);
  const resultMessage = mine && protoSync?.job && (protoSync.job.status === 'done' || protoSync.job.status === 'error')
    ? protoSync.job.message
    : '';
  const resultFailed = Boolean(mine && protoSync?.job?.status === 'error');
  const apiError = protoSync?.error && protoSync.errorItem === item.itemKey ? protoSync.error : '';
  const resultText = apiError || resultMessage;
  const resultWarn = Boolean(apiError) || resultFailed;

  const firstGroup = GROUPS.find((g) => docs.some((d) => d.group === g.key))?.key || 'spec';
  const [group, setGroup] = useState<PrototypeDoc['group']>(firstGroup);
  const [expanded, setExpanded] = useState(false);
  const groupDocs = docs.filter((d) => d.group === group);
  const shownDocs = expanded ? groupDocs : groupDocs.slice(0, DOC_PREVIEW);

  const onlineStale = Boolean(online && sync.onlineStale);
  const offlineStale = Boolean(sync.offlineStale);

  return (
    // 断点按这一行自己的宽度算（容器查询），不按视口：右侧阅读器打开后原型面板只剩窄窄一栏，
    // 视口却还是宽屏，按视口排会把三格状态挤成一字一行
    <article className="@container min-w-0 overflow-hidden rounded-lg border border-border bg-card">
      <div className="grid min-w-0 @3xl:grid-cols-[280px_minmax(0,1fr)]">
      <div className="relative m-3 flex aspect-[16/10] max-w-full items-center justify-center overflow-hidden rounded-md border border-border bg-muted/50">
        {item.cover ? (
          <img
            src={item.cover}
            alt=""
            loading="lazy"
            className="absolute inset-0 z-10 size-full object-cover object-top"
            onError={(e) => {
              // 封面读不到就藏掉，露出下面的占位
              e.currentTarget.style.display = 'none';
            }}
          />
        ) : null}
        <div
          className="absolute inset-0 opacity-[0.06]"
          style={{
            backgroundImage:
              'linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
        />
        <MonitorPlay className="relative size-8 text-muted-foreground" />
      </div>

      <div className="flex min-w-0 flex-col gap-3 px-4 pb-4 @3xl:py-3 @3xl:pl-1 @3xl:pr-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold leading-snug">{item.title}</h3>
            <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
              {item.sourcePath || item.itemKey}/
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {refresh ? (
              <span title={!refresh.available ? refresh.reason : refreshing ? '导出离线包可能要一两分钟' : undefined}>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!refresh.available || Boolean(protoSync?.running)}
                  onClick={() => void protoSync?.start(item.itemKey)}
                >
                  {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  {refreshing ? '正在刷新…' : '刷新'}
                </Button>
              </span>
            ) : null}
            {offline?.url ? (
              <Button size="sm" onClick={() => openInNewWindow(offline.url)}>
                <MonitorPlay />
                打开离线包
              </Button>
            ) : null}
            {online?.target ? (
              <Button size="sm" variant="outline" onClick={() => openInNewWindow(online.target)}>
                <ExternalLink />
                打开在线版
              </Button>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-1 divide-y divide-border overflow-hidden rounded-md border border-border @lg:grid-cols-3 @lg:divide-x @lg:divide-y-0">
          <Fact
            label="离线包"
            warn={offlineStale}
            value={
              offlineStale
                ? offline
                  ? '本次同步没更新，仍是旧包'
                  : '本次同步没导出成功'
                : offline
                  ? [typeof offline.size === 'number' ? formatBytes(offline.size) : '', formatDate(offline.mtime)]
                      .filter(Boolean)
                      .join(' · ')
                  : '没有离线包'
            }
            sub={offlineStale ? '打开 Make 管理端后再同步一次' : offline?.sourcePath.split('/').pop()}
          />
          <Fact
            label="在线版"
            warn={onlineStale}
            value={
              !online
                ? '未发布'
                : !online.target
                  ? '地址不合法'
                  : onlineStale
                    ? onlineLag(sync.localChangedAt, online.publishedAt)
                    : '与本地一致'
            }
            sub={
              online?.publishedAt
                ? `${formatDate(online.publishedAt)} 发布${online.publishTarget ? ` · ${online.publishTarget}` : ''}`
                : undefined
            }
          />
          <Fact
            label="同步"
            value={formatRelative(sync.syncedAt)}
            sub={sync.commit ? `源提交 ${sync.commit}` : undefined}
          />
        </div>

        {docs.length ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap gap-1" role="tablist" aria-label="原型资料">
              {GROUPS.map((g) => {
                const count = docs.filter((d) => d.group === g.key).length;
                const active = g.key === group;
                return (
                  <Button
                    key={g.key}
                    role="tab"
                    aria-selected={active}
                    size="sm"
                    variant={active ? 'secondary' : 'ghost'}
                    disabled={!count}
                    className="h-7 gap-1.5 px-2.5 font-normal"
                    onClick={() => {
                      setGroup(g.key);
                      setExpanded(false);
                    }}
                  >
                    {g.label}
                    {g.key === 'sync' ? null : (
                      <span className="tabular-nums text-muted-foreground">{count}</span>
                    )}
                  </Button>
                );
              })}
            </div>
            <div className="grid grid-cols-1 gap-x-3 border-t border-border pt-1 @4xl:grid-cols-2" role="tabpanel">
              {shownDocs.map((doc) => (
                <button
                  key={doc.path}
                  type="button"
                  title={`在阅读器中打开 ${doc.path}`}
                  disabled={!onOpen}
                  onClick={() => onOpen?.(toFileItem(doc))}
                  className={cn(
                    'flex min-w-0 items-baseline gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                    openPath === doc.path && 'bg-accent',
                  )}
                >
                  <span className="truncate text-[13px]">{doc.label}</span>
                  <span className="ml-auto min-w-0 truncate font-mono text-[10.5px] text-muted-foreground">
                    {doc.path.slice((item.sourcePath || '').length + 1)}
                  </span>
                </button>
              ))}
            </div>
            {groupDocs.length > DOC_PREVIEW ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 self-start px-2 font-normal text-muted-foreground"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? '收起' : `展开全部 ${groupDocs.length} 份`}
              </Button>
            ) : null}
          </div>
        ) : null}

        {onlineStale || duplicates.length || resultText ? (
          <div className="flex flex-col gap-1.5 border-t border-dashed border-border pt-2.5 text-xs text-muted-foreground">
            {resultText ? (
              <p className={cn('whitespace-pre-wrap [overflow-wrap:anywhere]', resultWarn ? 'text-destructive' : 'text-muted-foreground')}>
                {resultText}
              </p>
            ) : null}
            {onlineStale ? (
              <p className="text-foreground">
                <span className="mr-1.5 inline-block size-1.5 rounded-full bg-destructive align-[2px]" />
                在线版比本地旧：到 Make 里重新发布，再跑一次同步，这里就会更新。
              </p>
            ) : null}
            {duplicates.map((dup) => (
              <p key={dup} className="flex flex-wrap items-center gap-x-1">
                <span className="mr-0.5 inline-block size-1.5 rounded-full bg-destructive" />
                已并入手工录入的卡片
                <code className="font-mono text-foreground">{dup.split('/').pop()}/</code>
                （指向同一在线链接）。不再需要的话在文件系统里删掉那个目录，看板不代删。
                <CopyButton value={dup} />
              </p>
            ))}
          </div>
        ) : null}
      </div>
      </div>
    </article>
  );
}
