import { CircleDot } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SectionTitle, Stat } from '@/components/Primitives';
import { Markdown } from '@/components/Markdown';
import type { FileItem, Scan } from '@/lib/api';
import { formatRelative, formatWords } from '@/lib/format';

type Stage = { key: string; title: string; hint: string; done: boolean; current: boolean };

/**
 * 元信息文件还没有时，只能按目录状态推断阶段。
 * 推断出来的东西一律标 [推断]，不冒充项目事实 —— 这是工作空间的硬规矩。
 */
function inferStages(scan: Scan): Stage[] {
  const { input, output, prototypes } = scan;
  const hasRaw = input.stats.raw > 0;
  const converted = input.stats.converted > 0 && input.stats.pending === 0;
  const analyzed = output.stats.analysis > 0;
  const documented = output.stats.docs > 0;
  const prototyped = prototypes.items.length > 0;

  const stages: Stage[] = [
    { key: 'ingest', title: '资料入库', hint: 'input/raw → input/converted', done: converted, current: false },
    { key: 'analysis', title: '现状与需求分析', hint: 'output/analysis', done: analyzed, current: false },
    { key: 'docs', title: '文档交付', hint: 'output/docs', done: documented, current: false },
    { key: 'prototype', title: '原型', hint: 'prototypes/', done: prototyped, current: false },
  ];
  if (!hasRaw) return stages;
  const currentIndex = stages.findIndex((s) => !s.done);
  if (currentIndex >= 0) stages[currentIndex].current = true;
  return stages;
}

export function OverviewPanel({
  scan,
  onOpen,
  onGoto,
}: {
  scan: Scan;
  onOpen: (item: FileItem) => void;
  onGoto: (view: 'input' | 'output' | 'prototypes') => void;
}) {
  const stages = inferStages(scan);
  const { meta } = scan;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-2xl">{scan.project.name}</h1>
        <p className="font-mono text-xs text-muted-foreground">{scan.project.root}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="资料" value={scan.input.stats.converted} hint={`共 ${scan.input.stats.raw} 份原始文件`} />
        <Stat label="产出" value={scan.output.stats.total} hint={formatWords(scan.output.stats.words)} />
        <Stat
          label="待办信号"
          value={scan.input.stats.pending + scan.input.stats.warnings}
          hint={
            scan.input.stats.pending || scan.input.stats.warnings
              ? `${scan.input.stats.pending} 份待转换 · ${scan.input.stats.warnings} 份存疑`
              : '资料侧没有待处理项'
          }
          tone={scan.input.stats.pending + scan.input.stats.warnings ? 'attention' : 'default'}
        />
        <Stat
          label="最近更新"
          value={scan.output.stats.lastUpdated ? formatRelative(scan.output.stats.lastUpdated) : '—'}
          hint={scan.prototypes.items.length ? `${scan.prototypes.items.length} 个原型页面` : '还没有原型'}
        />
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <SectionTitle>项目阶段</SectionTitle>
          {!meta.exists ? (
            <Badge variant="outline" className="text-muted-foreground">
              推断
            </Badge>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {stages.map((stage) => (
            <div
              key={stage.key}
              className={
                stage.current
                  ? 'flex flex-col gap-1 rounded-lg border border-foreground/40 bg-muted px-4 py-3'
                  : 'flex flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3'
              }
            >
              <div className="flex items-center gap-2">
                <CircleDot
                  className={stage.done ? 'size-3.5 text-foreground' : 'size-3.5 text-muted-foreground/50'}
                />
                <span className="text-sm">{stage.title}</span>
              </div>
              <span className="font-mono text-[11px] text-muted-foreground">{stage.hint}</span>
              <span className="text-xs text-muted-foreground">
                {stage.done ? '已有产物' : stage.current ? '进行中' : '未开始'}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>项目元信息</SectionTitle>
        {meta.exists ? (
          <div className="rounded-lg border border-border bg-card px-5 py-4">
            <div className="mb-3 flex items-center gap-2">
              <Badge variant="muted" className="font-mono">
                {meta.path}
              </Badge>
              <span className="text-xs text-muted-foreground">更新于 {formatRelative(meta.mtime)}</span>
            </div>
            <pre className="overflow-x-auto font-mono text-xs leading-6 whitespace-pre-wrap">{meta.raw}</pre>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-lg border border-dashed border-border px-5 py-6">
            <p className="text-sm">
              工作空间里还没有 <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">project.yaml</code>
              ，上面的阶段判断是看板按目录状态推断的，不是项目事实。
            </p>
            <p className="text-xs text-muted-foreground">
              等元信息的字段规格定下来，这里会换成项目目标、干系人、里程碑、范围边界这些真实信息。
            </p>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>最近的产出</SectionTitle>
        {scan.output.stats.total ? (
          <div className="overflow-hidden rounded-lg border border-border">
            {[...scan.output.analysis, ...scan.output.docs, ...scan.output.decisions]
              .sort((a, b) => b.mtime.localeCompare(a.mtime))
              .slice(0, 5)
              .map((file) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => onOpen(file)}
                  className="flex w-full items-center gap-3 border-b border-border px-4 py-2.5 text-left last:border-b-0 hover:bg-accent"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{file.title || file.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatRelative(file.mtime)}</span>
                </button>
              ))}
          </div>
        ) : (
          <div className="flex items-center justify-between rounded-lg border border-dashed border-border px-5 py-6">
            <p className="text-sm text-muted-foreground">还没有任何产出文档。</p>
            <Button variant="outline" size="sm" onClick={() => onGoto('input')}>
              先看资料
            </Button>
          </div>
        )}
      </section>

      {meta.exists && meta.raw.trim().startsWith('#') ? <Markdown>{meta.raw}</Markdown> : null}
    </div>
  );
}
