import { CircleDot, FileCode } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SectionTitle, Stat } from '@/components/Primitives';
import { Completeness, MetaView } from '@/components/MetaView';
import type { Scan } from '@/lib/api';
import { formatRelative, formatWords } from '@/lib/format';
import { cn } from '@/lib/utils';

type Stage = { key: string; title: string; hint: string; done: boolean; current: boolean };

/**
 * 元信息文件还没有时，只能按目录状态推断阶段。
 * 推断出来的东西一律标 [推断]，不冒充项目事实 —— 这是工作空间的硬规矩。
 */
function inferStages(scan: Scan): Stage[] {
  const { input, output, references, prototypes } = scan;
  const hasRaw = input.stats.raw > 0;
  const converted = input.stats.converted > 0 && input.stats.pending === 0;
  // 归档过的也算走过这一步：三组计数只数主列表，全归档了不等于没分析过
  const analyzed = output.stats.analysis + (output.stats.archived?.analysis ?? 0) > 0;
  const documented = output.stats.docs + (output.stats.archived?.docs ?? 0) > 0;
  // 视觉呈现这一步：有参考或有原型都算走过。references 缺字段（旧服务进程）时退回只看原型
  const showcased = (references?.items.length || 0) > 0 || prototypes.items.length > 0;

  const stages: Stage[] = [
    { key: 'ingest', title: '资料入库', hint: 'input/raw → converted', done: converted, current: false },
    { key: 'analysis', title: '需求分析', hint: 'output/analysis', done: analyzed, current: false },
    { key: 'docs', title: '文档交付', hint: 'output/docs', done: documented, current: false },
    { key: 'showcase', title: '视觉呈现', hint: 'visualization/', done: showcased, current: false },
  ];
  if (!hasRaw) return stages;
  const currentIndex = stages.findIndex((s) => !s.done);
  if (currentIndex >= 0) stages[currentIndex].current = true;
  return stages;
}

/**
 * 资料台账预览的上半部分（原「概览」视图精简而来）：抬头、三格统计、四步进度、元信息摘要。
 * 下半部分 `input/INDEX.md` 正文由阅读器接着渲染。「最近的产出」不再保留 —— 产出视图本身按时间排序。
 * 预览窗口可能很窄：统计格按最小宽度自动换行，进度条是一行可换行的小标签，都不出横向滚动。
 */
export function LedgerOverview({
  scan,
  onOpenPath,
}: {
  scan: Scan;
  /** 「看原文」打开 project.yaml；不给就不显示这个按钮 */
  onOpenPath?: (path: string) => void;
}) {
  const stages = inferStages(scan);
  const { meta } = scan;
  const title = meta.data?.identity?.项目名称 || meta.data?.workspace?.name || scan.project.name;
  const stage = meta.data?.workspace?.stage;
  // 待转换、存疑、原件动过都是要人处理的
  const stale = scan.input.stats.stale ?? 0;
  const archived = scan.output.stats.archived;
  // 旧服务进程没有 archived：当 0，提示不出现
  const archivedTotal = archived ? archived.analysis + archived.docs + archived.decisions : 0;
  const todoCount = scan.input.stats.pending + scan.input.stats.warnings + stale;
  const todoParts: string[] = [];
  if (scan.input.stats.pending || scan.input.stats.warnings) {
    todoParts.push(`${scan.input.stats.pending} 份待转换`);
    todoParts.push(`${scan.input.stats.warnings} 份存疑`);
  }
  if (stale) todoParts.push(`${stale} 份原件动过`);
  const todoHint = todoParts.length ? todoParts.join(' · ') : '资料侧没有待处理项';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-display text-xl leading-tight">{title}</h2>
        {stage ? <Badge variant="outline">{stage}</Badge> : null}
      </div>

      {meta.error ? (
        <div className="rounded-lg border border-destructive/40 px-4 py-3 text-sm text-destructive">{meta.error}</div>
      ) : null}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-2">
        {meta.stats ? (
          <Completeness meta={meta} />
        ) : (
          <Stat
            label="资料"
            value={scan.input.stats.converted}
            hint={
              scan.input.stats.ignored
                ? `共 ${scan.input.stats.raw} 份原始文件 · ${scan.input.stats.ignored} 份已忽略`
                : `共 ${scan.input.stats.raw} 份原始文件`
            }
          />
        )}
        <Stat
          label="产出"
          value={scan.output.stats.total}
          hint={
            // total 只数主列表；已归档的一起报出来，不然归档之后总数变小像是文件没了
            (archivedTotal ? `另有 ${archivedTotal} 份已归档 · ` : '') +
            (scan.output.stats.lastUpdated
              ? `${formatWords(scan.output.stats.words)} · 更新于 ${formatRelative(scan.output.stats.lastUpdated)}`
              : formatWords(scan.output.stats.words))
          }
        />
        <Stat label="待办信号" value={todoCount} hint={todoHint} tone={todoCount ? 'attention' : 'default'} />
      </div>

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SectionTitle>进度</SectionTitle>
          <Badge variant="outline" className="text-muted-foreground">
            推断
          </Badge>
          <span className="text-xs text-muted-foreground">按目录里有没有产物判断，不是项目实际阶段</span>
        </div>
        <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 text-sm">
          {stages.map((s, index) => (
            <li key={s.key} className="flex items-center gap-1.5" title={`${s.hint} · ${s.done ? '已有产物' : s.current ? '进行中' : '未开始'}`}>
              {index ? <span className="text-muted-foreground/50">→</span> : null}
              <span
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-2 py-1',
                  s.current ? 'border-foreground/40 bg-muted' : 'border-border',
                  !s.done && !s.current && 'text-muted-foreground',
                )}
              >
                <CircleDot className={s.done ? 'size-3.5 text-foreground' : 'size-3.5 text-muted-foreground/50'} />
                {s.title}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SectionTitle>项目元信息</SectionTitle>
          {meta.exists ? (
            <>
              <span className="text-xs text-muted-foreground">更新于 {formatRelative(meta.mtime)}</span>
              {onOpenPath ? (
                <Button variant="ghost" size="sm" onClick={() => onOpenPath(meta.path)}>
                  <FileCode className="size-3.5" />
                  看原文
                </Button>
              ) : null}
            </>
          ) : null}
        </div>

        {meta.exists && meta.data ? (
          <MetaView meta={meta} />
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border px-4 py-4">
            <p className="text-sm">
              工作空间里还没有 <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">project.yaml</code>
              ，上面的进度是看板按目录状态推断的，不是项目事实。
            </p>
            <p className="text-xs text-muted-foreground">
              把合同 / 招标技术文件 / 立项文件放进 input/raw/ 转换入库，再让 AI 走 pm-project-meta
              技能提取，这里就会显示项目背景、目标、干系人、里程碑和还缺什么。
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
