import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, FileWarning } from 'lucide-react';
import { toast } from 'sonner';
import { Markdown } from '@/components/Markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useFeedbackDetail } from '@/hooks/useFeedback';
import { ApiError, api, type FeedbackDetail, type FeedbackIndex, type FeedbackItem } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  FEEDBACK_EMAIL,
  FEEDBACK_KINDS,
  feedbackKind,
  feedbackMailBody,
  feedbackMailSubject,
} from '../../shared/feedbackMail.mjs';

/**
 * 反馈单页。布局与记录单同构：左边按状态分组，右边详情。
 * 分组不存在文件里，由 `status` + `sent_at` 现推；`kind` 写歪的归「未识别」。
 * 两种单子（缺陷 / 贡献）的节名与邮件拼法在 `src/shared/feedbackMail.mjs`，与服务端同源。
 * 「邮件发送」只唤起 mailto；落盘要等用户点「我已发出」。
 */

type GroupKey = 'pending' | 'sent' | 'fixed' | 'wontfix' | 'unknown';

const GROUPS: { key: GroupKey; label: string }[] = [
  { key: 'pending', label: '待发送' },
  { key: 'sent', label: '已发送' },
  { key: 'fixed', label: '已修复' },
  { key: 'wontfix', label: '不修' },
  { key: 'unknown', label: '未识别' },
];

const MAILTO_LIMIT = 1800;

const MIGRATION_PROMPT = `把工作空间根目录 .kanban-feedback/ 里的旧反馈单迁到 output/feedback/。

按文件日期从早到晚编号，从当前最大的 F 编号往后排；没有就从 F0001 起。编号只增不复用。
每份改成一份 F<四位编号>.md：扁平 front-matter（id、title、status、created、receipt、sent_at）
和正文六节（现象、期望、最小复现、疑似源码位置、建议改法、临时绕法）加上「## 发送记录」。

status 映射：待处理 → pending，已修复 → fixed，不修 → wontfix。回执照搬到 receipt。
sent_at 留空。不要编造「## 发送记录」里的条目，那一节留空着即可，标题必须在。
最小复现若夹着真实资料或客户名，改成合成内容。

迁完在看板反馈单页确认能看到，再删掉 .kanban-feedback/。
回执只改 status 和 receipt，不要改 sent_at，也不要改发送记录。`;

const KNOWN_KINDS: readonly string[] = FEEDBACK_KINDS;

/** 旧服务不报 `kind`，按缺陷单算 —— 与改动前的界面一致。 */
function kindOf(item: FeedbackItem): string {
  return feedbackKind(item.kind);
}

/** 列表标签用短名；详情卡在「未识别」后面带上原文。 */
function kindLabel(item: FeedbackItem): string {
  const kind = kindOf(item);
  if (kind === 'contribution') return '贡献';
  if (kind === 'bug') return '缺陷';
  return '未识别';
}

function kindText(item: FeedbackItem): string {
  const label = kindLabel(item);
  return label === '未识别' ? `未识别：${kindOf(item)}` : label;
}

function groupOf(item: FeedbackItem): GroupKey {
  if (item.broken) return 'unknown';
  if (!KNOWN_KINDS.includes(kindOf(item))) return 'unknown';
  if (item.status === 'pending' && !item.sent_at) return 'pending';
  if (item.status === 'pending' && item.sent_at) return 'sent';
  if (item.status === 'fixed') return 'fixed';
  if (item.status === 'wontfix') return 'wontfix';
  return 'unknown';
}

function statusText(item: FeedbackItem): string {
  if (item.broken) return '无法解析';
  if (item.status === 'pending') return item.sent_at ? '已发送' : '待发送';
  if (item.status === 'fixed') return '已修复';
  if (item.status === 'wontfix') return '不修';
  return item.status || '未标状态';
}

function mailBody(detail: FeedbackDetail, version: string): string {
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  return feedbackMailBody(detail, version, date);
}

function mailtoHref(subject: string, body: string): string {
  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

async function copyText(text: string, ok: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(ok);
  } catch {
    toast.error('复制失败。浏览器没有给剪贴板权限。');
  }
}

function openMailto(href: string) {
  // 不挂进文档、也不新开的 <a>.click()，Chromium 会把 mailto 当成当前页导航，
  // 工作台被卸掉，「我已发出」的内存状态一起丢。挂上并新开，当前页留着。
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function FeedbackPane({
  projectId,
  index,
  loading,
  error,
  unsupported,
  changeToken,
  reload,
  workspaceAvailable = true,
  version,
}: {
  projectId: string;
  index: FeedbackIndex | null;
  loading: boolean;
  error: string;
  unsupported: boolean;
  changeToken: number;
  reload: (silent?: boolean) => void;
  workspaceAvailable?: boolean;
  version: string;
}) {
  if (unsupported) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <div>
          <p className="text-sm">看板服务是旧版本，重启后可用。</p>
          <p className="mt-2 text-xs text-muted-foreground">
            看板服务是常驻进程、不热更。在终端里重跑
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono">pnpm serve</code>
            （开发时是 <code className="rounded bg-muted px-1.5 py-0.5 font-mono">pnpm dev</code>）再打开这里。
          </p>
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (!projectId) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        还没有选中工作空间。
      </div>
    );
  }
  if (!workspaceAvailable) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <div>
          <p className="text-sm">这个工作空间的目录现在读不到。</p>
          <p className="mt-2 text-xs text-muted-foreground">
            目录可能被改名或移走了。先在「概览」里重新指到它，反馈单会跟着回来 ——
            看板不动你本地的任何文件。
          </p>
        </div>
      </div>
    );
  }
  if (!index && loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">正在读取反馈单…</div>
    );
  }
  if (index && index.available === false && !(index.legacyCount && index.legacyCount > 0)) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <div>
          <p className="text-sm">这个工作空间还没有反馈单。</p>
          <p className="mt-2 text-xs text-muted-foreground">
            反馈单由工作空间智能体写在
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono">{index.dir || 'output/feedback'}</code>
            ，一份一个 <code className="rounded bg-muted px-1.5 py-0.5 font-mono">F</code> 编号文件。看板不新建。
          </p>
        </div>
      </div>
    );
  }

  return (
    <FeedbackBody
      projectId={projectId}
      index={index}
      changeToken={changeToken}
      reload={reload}
      version={version}
    />
  );
}

function FeedbackBody({
  projectId,
  index,
  changeToken,
  reload,
  version,
}: {
  projectId: string;
  index: FeedbackIndex | null;
  changeToken: number;
  reload: (silent?: boolean) => void;
  version: string;
}) {
  const items = index?.items ?? [];
  const groups = useMemo(() => {
    const buckets = new Map<GroupKey, FeedbackItem[]>();
    for (const item of items) {
      const key = groupOf(item);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(item);
      else buckets.set(key, [item]);
    }
    return GROUPS.map(({ key, label }) => ({ key, label, rows: buckets.get(key) ?? [] })).filter(
      (group) => group.rows.length > 0,
    );
  }, [items]);

  const [toggled, setToggled] = useState<Map<GroupKey, boolean>>(new Map());
  const [selectedId, setSelectedId] = useState('');
  const flat = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const selected = flat.find((item) => item.id === selectedId) || flat[0] || null;
  const legacyCount = index?.legacyCount ?? 0;

  const isOpen = (key: GroupKey) => toggled.get(key) ?? key === 'pending';

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[21rem] shrink-0 flex-col border-r border-border">
        {legacyCount > 0 ? (
          <div className="shrink-0 border-b border-border px-3 py-2">
            <p className="text-xs text-muted-foreground">
              <code className="font-mono">.kanban-feedback/</code> 里还有 {legacyCount} 份旧反馈单。
              看板不读、不移动这些文件。
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void copyText(MIGRATION_PROMPT, '迁移提示词已复制')}
            >
              复制迁移提示词
            </Button>
          </div>
        ) : null}
        <ScrollArea className="min-h-0 flex-1" viewportClassName="py-1 focus-visible:ring-0">
          {groups.length ? (
            groups.map(({ key, label, rows }) => {
              const open = isOpen(key);
              return (
                <div key={key}>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setToggled((prev) => new Map(prev).set(key, !open))}
                    className="flex w-full items-center gap-2 border-b border-border py-2 pl-3 text-left text-sm hover:bg-accent"
                  >
                    <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    <span className="mr-3 shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {rows.length}
                    </span>
                  </button>
                  {open
                    ? rows.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => item.id && setSelectedId(item.id)}
                          aria-current={selected?.id === item.id}
                          className={cn(
                            'flex w-full items-center gap-2 border-l-2 border-transparent py-2 pr-3 pl-4 text-left transition-colors hover:bg-accent',
                            selected?.id === item.id && 'border-l-foreground bg-selected font-medium hover:bg-selected',
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate text-xs">
                            <span className="mr-1.5 font-mono text-[11px] text-muted-foreground">{item.id}</span>
                            {item.title || item.name}
                          </span>
                          {item.broken ? null : (
                            <Badge variant="outline" className="shrink-0 px-1.5 text-[11px] font-normal text-muted-foreground">
                              {kindLabel(item)}
                            </Badge>
                          )}
                          {item.broken || key === 'unknown' ? (
                            <FileWarning className="size-3.5 shrink-0 text-destructive" aria-hidden />
                          ) : null}
                        </button>
                      ))
                    : null}
                </div>
              );
            })
          ) : (
            <p className="px-3 py-10 text-center text-sm text-muted-foreground">
              反馈单由工作空间智能体写。这里还没有 <code className="font-mono">F</code> 编号的文件。
            </p>
          )}
        </ScrollArea>
      </div>
      <ScrollArea className="min-h-0 flex-1" viewportClassName="focus-visible:ring-0">
        {selected?.id ? (
          <FeedbackCard
            projectId={projectId}
            feedbackId={selected.id}
            listItem={selected}
            changeToken={changeToken}
            reload={reload}
            version={version}
          />
        ) : (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">还没有可打开的反馈单。</p>
        )}
      </ScrollArea>
    </div>
  );
}

function FeedbackCard({
  projectId,
  feedbackId,
  listItem,
  changeToken,
  reload,
  version,
}: {
  projectId: string;
  feedbackId: string;
  listItem: FeedbackItem;
  changeToken: number;
  reload: (silent?: boolean) => void;
  version: string;
}) {
  const { detail, loading, error, put } = useFeedbackDetail(projectId, feedbackId, changeToken);
  const [preview, setPreview] = useState(false);
  const [armedId, setArmedId] = useState('');
  const [saving, setSaving] = useState(false);
  const [canWrite, setCanWrite] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .pickDirectoryAvailable()
      .then((data) => {
        if (!alive) return;
        setCanWrite(typeof data.available === 'boolean' ? data.available : null);
      })
      .catch((err: unknown) => {
        // 探针 404 是旧服务没有这个接口，不当成「禁止写入」。
        // 反馈单自己的 404 已经在页级走了重启提示。
        if (!alive) return;
        if (err instanceof ApiError && err.status === 404) setCanWrite(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    setPreview(false);
  }, [feedbackId]);

  const shown = detail ?? null;
  // 详情里的 kind 比列表项新（刚改过文件还没刷新索引时），有就用详情的
  const mailItem = shown ? { ...shown, kind: shown.kind ?? listItem.kind } : null;
  const subject = mailItem ? feedbackMailSubject(mailItem) : '';
  const body = mailItem ? mailBody(mailItem, version) : '';
  const fullHref = shown ? mailtoHref(subject, body) : '';
  const clipped = fullHref.length > MAILTO_LIMIT;
  const href = clipped ? mailtoHref(subject, '正文已复制到剪贴板，请粘贴') : fullHref;
  const writeBlocked = canWrite === false;
  const armed = armedId === feedbackId;

  const sendMail = () => {
    if (!shown || writeBlocked) return;
    if (clipped) void navigator.clipboard.writeText(body).catch(() => {});
    openMailto(href);
    setArmedId(feedbackId);
  };

  const confirmSent = async () => {
    if (!shown?.id || writeBlocked || saving) return;
    setSaving(true);
    try {
      const next = await api.feedbackMarkSent(projectId, shown.id);
      put(next);
      reload(true);
      setArmedId('');
      setPreview(false);
      toast.success('已记下发送时间');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative px-5 py-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-xs text-muted-foreground">{listItem.id}</p>
          <h3 className="text-base font-medium">{listItem.title || listItem.name}</h3>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={!shown || writeBlocked} onClick={() => setPreview(true)}>
            邮件发送
          </Button>
          {armed ? (
            <Button size="sm" disabled={writeBlocked || saving} onClick={() => void confirmSent()}>
              {saving ? '正在记下…' : '我已发出'}
            </Button>
          ) : null}
        </div>
      </div>
      {writeBlocked ? (
        <p className="mb-3 text-xs text-muted-foreground">
          服务不是环回地址监听的，不能从这里标记已发送。用本机的 127.0.0.1 再起一次服务。
        </p>
      ) : null}
      <dl className="mb-4 space-y-1 text-xs">
        <Meta label="类型" value={kindText(listItem)} />
        <Meta label="状态" value={statusText(listItem)} />
        <Meta label="创建" value={listItem.created || '—'} />
        <Meta label="最近发送" value={listItem.sent_at || '还没发过'} />
        <Meta label="回执" value={listItem.receipt || '—'} />
      </dl>
      {listItem.broken ? (
        <p className="text-sm text-destructive">{listItem.reason || '这份文件读不出来。'}</p>
      ) : loading && !shown ? (
        <p className="text-sm text-muted-foreground">正在读正文…</p>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : shown ? (
        <div className="space-y-4">
          {(shown.sections ?? []).map((section) => (
            <section key={section.heading}>
              <h4 className="mb-1 text-sm font-medium">{section.heading}</h4>
              {section.body ? (
                <Markdown>{section.body}</Markdown>
              ) : (
                <p className="text-xs text-muted-foreground">（这一节是空的）</p>
              )}
            </section>
          ))}
          <section>
            <h4 className="mb-1 text-sm font-medium">发送记录</h4>
            {shown.sends?.length ? (
              <ul className="space-y-2">
                {shown.sends.map((send, i) => (
                  <li key={`${send.title}-${i}`} className="text-xs">
                    <p className="font-medium">{send.title}</p>
                    {send.body ? <Markdown>{send.body}</Markdown> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">还没有发送记录。</p>
            )}
          </section>
        </div>
      ) : null}

      {preview && shown ? (
        <div
          className="absolute inset-0 z-20 flex items-start justify-center overflow-auto bg-background/95 p-4"
          role="dialog"
          aria-label="邮件预览"
        >
          <div className="w-full max-w-xl space-y-3 border border-border bg-background p-4">
            <h4 className="text-sm font-medium">邮件预览</h4>
            <p className="text-xs text-destructive">反馈单可能被带进公开仓库，发之前确认没有真实资料。</p>
            {clipped ? (
              <p className="text-xs text-muted-foreground">
                正文较长，已改为复制到剪贴板。打开邮件客户端时，正文是一句提示，全文在剪贴板里。
              </p>
            ) : null}
            <Meta label="收件人" value={FEEDBACK_EMAIL} />
            <Meta label="标题" value={subject} />
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">{body}</pre>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void copyText(FEEDBACK_EMAIL, '收件人已复制')}>
                复制收件人
              </Button>
              <Button variant="outline" size="sm" onClick={() => void copyText(subject, '标题已复制')}>
                复制标题
              </Button>
              <Button variant="outline" size="sm" onClick={() => void copyText(body, '正文已复制')}>
                复制正文
              </Button>
              <Button size="sm" disabled={writeBlocked} onClick={sendMail}>
                打开邮件客户端
              </Button>
              {armed ? (
                <Button variant="secondary" size="sm" disabled={writeBlocked || saving} onClick={() => void confirmSent()}>
                  我已发出
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={() => setPreview(false)}>
                关闭
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-all">{value}</span>
    </div>
  );
}
