import { FileText, ScrollText, Stamp } from 'lucide-react';
import { EmptyState, Row, SectionTitle, Stat } from '@/components/Primitives';
import type { FileItem, Scan } from '@/lib/api';
import { datePrefix, formatRelative, formatWords } from '@/lib/format';

const GROUPS = [
  {
    key: 'analysis' as const,
    title: '分析中间产物',
    hint: '现状基线、需求拆解、澄清问题清单',
    icon: ScrollText,
  },
  { key: 'docs' as const, title: '对外交付文档', hint: 'PRD、需求规格、评审材料', icon: FileText },
  { key: 'decisions' as const, title: '决策记录', hint: '一个决策一个文件，只追加不改历史', icon: Stamp },
];

export function OutputPanel({
  scan,
  openPath,
  onOpen,
}: {
  scan: Scan;
  openPath: string;
  onOpen: (item: FileItem) => void;
}) {
  const { output } = scan;

  return (
    <div className="flex flex-col gap-6">
      {/* 固定 3 列 + 固定间距：预览开合时高度稳定 */}
      <div className="grid grid-cols-3 gap-2">
        <Stat label="产出文件" value={output.stats.total} hint={formatWords(output.stats.words)} />
        <Stat label="分析产物" value={output.stats.analysis} />
        <Stat
          label="交付文档"
          value={output.stats.docs}
          hint={
            output.stats.lastUpdated
              ? `更新于 ${formatRelative(output.stats.lastUpdated)}${
                  output.stats.decisions ? ` · ${output.stats.decisions} 条决策` : ''
                }`
              : output.stats.decisions
                ? `${output.stats.decisions} 条决策记录`
                : undefined
          }
        />
      </div>

      {GROUPS.map(({ key, title, hint, icon: Icon }) => {
        const files = output[key];
        return (
          <section key={key} className="flex flex-col gap-2">
            <SectionTitle count={files.length}>{title}</SectionTitle>
            <p className="text-xs text-muted-foreground">{hint}</p>
            {files.length ? (
              <div className="overflow-hidden rounded-lg border border-border">
                {files.map((item) => (
                  <Row key={item.path} onClick={() => onOpen(item)} active={openPath === item.path}>
                    <Icon className="size-4 text-muted-foreground" />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-sm">{item.title || item.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {item.name}
                        {datePrefix(item.name) ? '' : ` · ${formatRelative(item.mtime)}`}
                      </span>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatWords(item.words)}</span>
                  </Row>
                ))}
              </div>
            ) : (
              <EmptyState title={`output/${key}/ 还是空的`} />
            )}
          </section>
        );
      })}
    </div>
  );
}
