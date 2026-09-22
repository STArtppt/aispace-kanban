import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, FileWarning } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useRecordDetail } from '@/hooks/useRecords';
import {
  ApiError,
  api,
  type OutputRecordDetail,
  type OutputRecordIndex,
  type OutputRecordItem,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  RECORD_KINDS,
  RECORD_KIND_LABEL,
  RECORD_STATUS_LABEL,
  needsResolvedBy,
  statusValuesOf,
} from '../../shared/recordStatus.mjs';

/**
 * 产出物记录这一页（⌘K 工作台的第二页）：左边先按类别、组内按状态分组的清单，
 * 右边单条详情 + 状态变更。
 *
 * 排序轴是「需不需要人处理」，**不是自我评估的优先级** —— `questions` 那边
 * 「一半标『高』」的教训在这里同样适用：`revising` / `pending` 是明确的待办，
 * `delivered` 停滞久了也是（由日期与当天的差值表达，不额外立状态）。
 *
 * 状态与说明是**一次写入**：选一个该 `kind` 的状态、紧跟一句说明、保存。
 * 反馈不是独立的一块，它就是状态变更的注解。写请求只有一处 `api.saveRecordStatus`，
 * 即 AGENTS.md 不变量 1 的**第六条窄例外** —— 界面上没有任何编辑 `target` /
 * 正文其它小节的入口，这不是疏漏，是那条例外的边界。
 */

/** `delivered` 超过这么多天没动就算停滞，排到需要人处理那一档。 */
const STALE_DAYS = 14;

/** 三个筛选。与状态机对齐，不引入第四个自造的轴。 */
type FilterKey = 'attention' | 'running' | 'closed';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'attention', label: '待处理' },
  { key: 'running', label: '在途' },
  { key: 'closed', label: '已收尾' },
];

/** 终态：进了就不用再看了（`resolved_by` 指向接手的那一份）。 */
const CLOSED = new Set(['absorbed', 'stale', 'final', 'superseded', 'overturned']);

/** 明确的待办状态。`delivered` 要看停多久，单独判。 */
const ATTENTION = new Set(['revising', 'pending']);

function daysSince(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 0;
  const then = Date.parse(`${date}T00:00:00`);
  if (Number.isNaN(then)) return 0;
  return Math.floor((Date.now() - then) / 86400000);
}

/** 这条 `delivered` 停滞了吗（发出去很久没回音）。状态不表达时间，所以这里现算。 */
function isStalled(item: OutputRecordItem): boolean {
  return item.status === 'delivered' && daysSince(item.status_changed || item.created) >= STALE_DAYS;
}

/**
 * 一条记录落进哪个筛选。
 * 「读不出」与「指向丢失」都归到待处理 —— 它们就是「数据不对、等人看一眼」那一堆，
 * 让违约可见，而不是让它悄悄消失。
 */
function bucketOf(item: OutputRecordItem): FilterKey {
  if (item.broken || item.targetMissing) return 'attention';
  if (ATTENTION.has(item.status) || isStalled(item)) return 'attention';
  if (CLOSED.has(item.status)) return 'closed';
  return 'running';
}

/** 状态在组内的先后：待办的排前面，其余照状态机的推进方向。 */
function statusRank(kind: string, status: string): number {
  if (ATTENTION.has(status)) return -1;
  const at = statusValuesOf(kind).indexOf(status);
  return at < 0 ? 99 : at;
}

function kindLabel(kind: string): string {
  return RECORD_KIND_LABEL[kind as keyof typeof RECORD_KIND_LABEL] || kind || '未知类别';
}

function statusLabel(status: string): string {
  return RECORD_STATUS_LABEL[status as keyof typeof RECORD_STATUS_LABEL] || status || '未标状态';
}

/**
 * 清单行。**只显示短字段** —— 编号、一句话标题、状态标签。
 * 「指向丢失」与「读不出」用 orange（`--destructive`），其余状态一律不上彩色。
 */
function RecordRow({
  item,
  selected,
  onSelect,
}: {
  item: OutputRecordItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const flagged = Boolean(item.broken || item.targetMissing);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected}
      className={cn(
        'flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left transition-colors hover:bg-accent',
        selected && 'bg-muted',
      )}
    >
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{item.id}</span>
      <span className="min-w-0 flex-1 truncate text-sm">{item.title || item.name}</span>
      {flagged ? <FileWarning className="size-3.5 shrink-0 text-destructive" aria-hidden /> : null}
      {isStalled(item) ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          停 {daysSince(item.status_changed || item.created)} 天
        </span>
      ) : null}
    </button>
  );
}

function MetaLine({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-all">{value}</span>
    </div>
  );
}

/**
 * 状态变更表单：该 `kind` 的状态下拉 + 紧跟的补充说明 + 保存。
 * 下拉里**只有本类的状态值**（`kind` 写错时退回服务端下发的那份，它也空就不给改）。
 */
function StatusForm({
  projectId,
  detail,
  onSaved,
}: {
  projectId: string;
  detail: OutputRecordDetail;
  onSaved: (next: OutputRecordDetail) => void;
}) {
  const values: readonly string[] = detail.statusValues?.length
    ? detail.statusValues
    : statusValuesOf(detail.kind);
  const [status, setStatus] = useState(detail.status);
  const [note, setNote] = useState('');
  const [resolvedBy, setResolvedBy] = useState(detail.resolved_by);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // 换到另一条记录时表单跟着换 —— 说明不能跨记录留着，那会写错到另一份上
  useEffect(() => {
    setStatus(detail.status);
    setNote('');
    setResolvedBy(detail.resolved_by);
    setError('');
  }, [detail.id, detail.status, detail.resolved_by]);

  if (!values.length) {
    return (
      <p className="text-xs text-muted-foreground">
        这份记录的 <code className="rounded bg-muted px-1 py-0.5 font-mono">kind</code> 是
        「{detail.kind || '空'}」，不在 analysis / docs / decisions 之内，看板判断不出该用哪套状态机。
        先在编辑器里把它修对，或跑一次
        <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono">scripts/check_markdown.py</code>
        看还有哪些不一致。
      </p>
    );
  }

  const wantsResolvedBy = needsResolvedBy(status);

  const save = async () => {
    setError('');
    if (!note.trim()) {
      setError('补充说明不能为空 —— 状态流水的每一条都要说清为什么变成这个状态。');
      return;
    }
    if (wantsResolvedBy && !resolvedBy.trim()) {
      setError(`「${statusLabel(status)}」是终态，要写清被哪个编号消解（如 I0012），否则外部引用无处可去。`);
      return;
    }
    setSaving(true);
    try {
      const next = await api.saveRecordStatus(projectId, detail.id, {
        status,
        note: note.trim(),
        ...(wantsResolvedBy || resolvedBy.trim() ? { resolved_by: resolvedBy.trim() } : {}),
      });
      onSaved(next);
      setNote('');
      toast.success(`${detail.id} 已记为「${statusLabel(next.status)}」`);
    } catch (err) {
      // 服务端的报错本来就是中文、说得清具体哪一条不合，直接照搬，不写「操作失败请重试」。
      // 只有 403 / 404 补一句「接下来该干什么」—— 那两种光看原因不知道怎么办。
      const message = (err as Error).message;
      if (err instanceof ApiError && err.status === 403) {
        setError(`${message}（写入只在 127.0.0.1 上放行，也不接受跨站请求。）`);
      } else if (err instanceof ApiError && err.status === 404) {
        setError(`${message} 记录可能刚被改名或删除，关掉工作台再打开一次看最新的清单。`);
      } else {
        setError(message);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Select
          value={status}
          onValueChange={(value) => {
            if (typeof value === 'string' && value) setStatus(value);
          }}
        >
          <SelectTrigger aria-label="改成哪个状态" className="w-40">
            <SelectValue>{(value: string | null) => statusLabel(value || '')}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {values.map((value) => (
              <SelectItem key={value} value={value}>
                {statusLabel(value)}
                <span className="ml-1.5 font-mono text-xs text-muted-foreground">{value}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {wantsResolvedBy ? (
          <Input
            value={resolvedBy}
            onChange={(e) => setResolvedBy(e.target.value)}
            placeholder="被哪个编号消解，如 I0012"
            aria-label="消解者编号"
            className="w-52 font-mono"
          />
        ) : null}
      </div>
      <Input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="一句话说清为什么变成这个状态（会写进状态流水）"
        aria-label="补充说明"
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? '正在保存…' : '保存这次变更'}
        </Button>
        <span className="text-xs text-muted-foreground">
          只改 status / resolved_by / status_changed 与「状态流水」，产出物文件不动
        </span>
      </div>
    </div>
  );
}

/** 右边的详情卡片：短字段 + 状态流水 + 状态变更。正文其它小节是 agent 的写区，只读着看。 */
function RecordCard({
  projectId,
  item,
  changeToken,
  reload,
}: {
  projectId: string;
  item: OutputRecordItem;
  changeToken: number;
  reload: (silent?: boolean) => void;
}) {
  const { detail, loading, error, put } = useRecordDetail(projectId, item.id, changeToken);

  return (
    <div className="space-y-4 px-5 py-4">
      <div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{item.id}</span>
          <Badge variant="outline">{kindLabel(item.kind)}</Badge>
          <Badge variant="outline">{statusLabel(item.status)}</Badge>
          {item.targetMissing ? (
            <Badge variant="outline" className="border-destructive text-destructive">
              指向丢失
            </Badge>
          ) : null}
        </div>
        <h3 className="mt-2 text-base font-medium">{item.title || item.name}</h3>
      </div>

      <div className="space-y-1 rounded-md border border-border bg-muted/40 p-3">
        <MetaLine
          label="产出物"
          value={
            <span className={cn('font-mono', item.targetMissing && 'text-destructive')}>
              {item.target || '（没写 target）'}
            </span>
          }
        />
        <MetaLine label="建立" value={item.created || '—'} />
        <MetaLine label="状态变更" value={item.status_changed || '—'} />
        <MetaLine label="内容更新" value={item.updated || '—'} />
        {item.resolved_by ? <MetaLine label="被谁消解" value={<span className="font-mono">{item.resolved_by}</span>} /> : null}
      </div>

      {item.broken ? (
        <p className="text-xs text-destructive">{item.reason || '这份记录读不出来。'}</p>
      ) : null}
      {item.targetMissing && !item.broken ? (
        <p className="text-xs text-destructive">
          这条指向的产出物文件现在不在了。产出物改名或移走时要由 agent 跟进
          <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono">target</code>
          （走 `pm-output-record` 技能）—— 看板不改它，那是 AI 写区。
        </p>
      ) : null}

      <div>
        <h4 className="mb-2 text-sm font-medium">记一次状态变更</h4>
        {detail ? (
          <StatusForm
            projectId={projectId}
            detail={detail}
            onSaved={(next) => {
              put(next);
              // 清单要跟着换分组。静默重取，不闪 loading —— 人可能正连着处理下一条
              reload(true);
            }}
          />
        ) : (
          <p className="text-xs text-muted-foreground">{loading ? '正在读这份记录…' : error || '暂无数据'}</p>
        )}
      </div>

      <div>
        <h4 className="mb-2 text-sm font-medium">状态流水</h4>
        {detail?.flow?.length ? (
          <ol className="space-y-2">
            {[...detail.flow].reverse().map((entry, i) => (
              <li key={`${entry.date}-${entry.status}-${i}`} className="border-l-2 border-border pl-3">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{entry.date || entry.title}</span>
                  {entry.status ? <span>{statusLabel(entry.status)}</span> : null}
                </div>
                {entry.note ? <p className="mt-0.5 text-sm whitespace-pre-wrap">{entry.note}</p> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-xs text-muted-foreground">
            {detail ? '还没有状态流水。保存一次状态变更就会有第一条。' : '—'}
          </p>
        )}
      </div>
    </div>
  );
}

/** 左清单 + 右卡片。抽出来是为了让索引没变时不重算分组。 */
function RecordsBody({
  projectId,
  index,
  changeToken,
  reload,
}: {
  projectId: string;
  index: OutputRecordIndex;
  changeToken: number;
  reload: (silent?: boolean) => void;
}) {
  const [filter, setFilter] = useState<FilterKey>('attention');
  const [selectedId, setSelectedId] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // 三个筛选各自的计数：全量算一次，切筛选不重算
  const counts = useMemo(() => {
    const out: Record<FilterKey, number> = { attention: 0, running: 0, closed: 0 };
    for (const item of index.items) out[bucketOf(item)] += 1;
    return out;
  }, [index.items]);

  /**
   * 当前筛选下的分组：先按 `kind` 分三组，组内再按 `status` 分。
   * **计数跟着筛选重算** —— 否则切到「已收尾」还看到按待处理算的分组数，点开却是空的。
   * 三类的状态**不混在同一个分组轴上**：`kind` 决定状态机，混了就读不出含义。
   */
  const groups = useMemo(() => {
    const hit = index.items.filter((item) => bucketOf(item) === filter);
    const byKind = new Map<string, OutputRecordItem[]>();
    for (const item of hit) {
      const key = RECORD_KINDS.includes(item.kind as (typeof RECORD_KINDS)[number]) ? item.kind : '';
      const bucket = byKind.get(key);
      if (bucket) bucket.push(item);
      else byKind.set(key, [item]);
    }
    const order = [...RECORD_KINDS, ''];
    return [...byKind.entries()]
      .sort((a, b) => order.indexOf(a[0] as string) - order.indexOf(b[0] as string))
      .map(([kind, items]) => {
        const byStatus = new Map<string, OutputRecordItem[]>();
        for (const item of items) {
          const key = item.status || '';
          const bucket = byStatus.get(key);
          if (bucket) bucket.push(item);
          else byStatus.set(key, [item]);
        }
        return {
          kind,
          total: items.length,
          statuses: [...byStatus.entries()]
            .map(([status, rows]) => ({
              status,
              // 停滞久的排前面：同一个 `delivered` 里也要先看最久没动的那几条
              rows: rows.sort(
                (a, b) =>
                  daysSince(b.status_changed || b.created) - daysSince(a.status_changed || a.created),
              ),
            }))
            .sort((a, b) => statusRank(kind, a.status) - statusRank(kind, b.status)),
        };
      });
  }, [index.items, filter]);

  const flat = useMemo(
    () => groups.flatMap((group) => group.statuses.flatMap((s) => s.rows)),
    [groups],
  );

  // 筛选切换后选中项可能不在列表里了：落到第一条，不要留一张对不上的卡片
  const selected = flat.find((item) => item.id === selectedId) || flat[0] || null;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[21rem] shrink-0 flex-col border-r border-border">
        <div className="flex h-11 shrink-0 items-center gap-0.5 overflow-x-auto overscroll-x-contain border-b border-border px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {FILTERS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              aria-pressed={filter === key}
              className={cn(
                'relative shrink-0 px-2.5 py-2 text-sm whitespace-nowrap transition-colors',
                filter === key
                  ? 'font-medium text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
              <span className="ml-1 text-xs">({counts[key]})</span>
            </button>
          ))}
        </div>

        <ScrollArea className="min-h-0 flex-1" viewportClassName="py-1 focus-visible:ring-0">
          {groups.length ? (
            groups.map((group) => {
              const isOpen = !collapsed.has(group.kind);
              return (
                <div key={group.kind || 'unknown'}>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (next.has(group.kind)) next.delete(group.kind);
                        else next.add(group.kind);
                        return next;
                      })
                    }
                    className="flex w-full items-center gap-2 border-b border-border py-2 pl-3 text-left text-sm hover:bg-accent"
                  >
                    <ChevronRight
                      className={cn('size-3.5 shrink-0 transition-transform', isOpen && 'rotate-90')}
                    />
                    <span className="min-w-0 flex-1 truncate">{kindLabel(group.kind)}</span>
                    <span className="mr-3 shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {group.total}
                    </span>
                  </button>
                  {isOpen
                    ? group.statuses.map(({ status, rows }) => (
                        <div key={status || 'unknown'}>
                          <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
                            <span className="min-w-0 flex-1 truncate">{statusLabel(status)}</span>
                            <span className="shrink-0">{rows.length}</span>
                          </div>
                          {rows.map((item) => (
                            <RecordRow
                              key={item.id}
                              item={item}
                              selected={selected?.id === item.id}
                              onSelect={() => setSelectedId(item.id)}
                            />
                          ))}
                        </div>
                      ))
                    : null}
                </div>
              );
            })
          ) : (
            <p className="px-3 py-10 text-center text-sm text-muted-foreground">这个筛选下没有记录</p>
          )}
        </ScrollArea>
      </div>

      <ScrollArea className="min-h-0 flex-1" viewportClassName="focus-visible:ring-0">
        {selected ? (
          <RecordCard
            projectId={projectId}
            item={selected}
            changeToken={changeToken}
            reload={reload}
          />
        ) : (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">这个筛选下没有记录</p>
        )}
      </ScrollArea>
    </div>
  );
}

/**
 * 产出物这一页。空态分三种，各写清怎么开始 ——
 * 「没这个目录」「服务是旧进程」「有目录但还没有记录」要人做的事完全不同。
 */
export function RecordsPane({
  projectId,
  index,
  loading,
  error,
  unsupported,
  changeToken,
  reload,
  workspaceAvailable = true,
}: {
  projectId: string;
  index: OutputRecordIndex | null;
  loading: boolean;
  error: string;
  unsupported: boolean;
  changeToken: number;
  reload: (silent?: boolean) => void;
  /** 工作空间目录还在不在（`scan.available`）。读不到目录时不要说成「还没有记录」 */
  workspaceAvailable?: boolean;
}) {
  if (unsupported) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <div>
          <p className="text-sm">服务端未提供产出物记录接口，请重启服务。</p>
          <p className="mt-2 text-xs text-muted-foreground">
            看板服务是常驻进程、不热更。在终端里重跑
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono">pnpm serve</code>
            （开发时是 <code className="rounded bg-muted px-1.5 py-0.5 font-mono">pnpm dev</code>）再打开这里。
            未决问题那一页不受影响。
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
            目录可能被改名或移走了。先在「概览」里重新指到它，记录会跟着回来 ——
            看板不动你本地的任何文件。
          </p>
        </div>
      </div>
    );
  }
  if (index && !index.available) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <div>
          <p className="text-sm">这个工作空间还没有产出物记录。</p>
          <p className="mt-2 text-xs text-muted-foreground">
            记录放在
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono">{index.dir}</code>
            下，一份产出物一个文件。它由工作空间的
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono">pm-output-record</code>
            技能建立 —— 看板只改已存在的记录，不新建。存量决策可以先跑一次
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono">
              scripts/migrate_decisions.py
            </code>
            （默认预演，不落盘）。
          </p>
        </div>
      </div>
    );
  }
  if (index && !index.items.length) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <div>
          <p className="text-sm">目录建好了，还没有一份记录。</p>
          <p className="mt-2 text-xs text-muted-foreground">
            下次让 AI 产出分析 / 文档 / 决策时，请它同时建一份记录（
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono">pm-output-record</code>
            技能）。字段契约在
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono">{index.dir}/README.md</code>
            。
          </p>
        </div>
      </div>
    );
  }
  if (index) {
    return (
      <RecordsBody
        projectId={projectId}
        index={index}
        changeToken={changeToken}
        reload={reload}
      />
    );
  }
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      {loading ? '正在读产出物记录…' : '暂无数据'}
    </div>
  );
}
