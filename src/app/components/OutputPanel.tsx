import { FileText, ScrollText, Stamp } from 'lucide-react';
import { CopyButton, EmptyState, Row, SectionTitle, Stat } from '@/components/Primitives';
import type { FileItem, Scan } from '@/lib/api';
import { datePrefix, formatRelative, formatWords, markdownLink } from '@/lib/format';

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

/**
 * 这份产出里有多少内容还没有资料支撑。
 * 中性灰而不是 orange —— 标注是 AI 老实交代的产出，不是要人去修的缺口；
 * 标红只会让人学会把标注写少，正好跟溯源纪律反着来。
 */
function annotationLabel(item: FileItem): string {
  const marks = item.annotations;
  if (!marks?.total) return '';
  const parts: string[] = [];
  if (marks.inferred) parts.push(`${marks.inferred} 处推断`);
  if (marks.verbal) parts.push(`${marks.verbal} 处待确认`);
  if (marks.blank) parts.push(`${marks.blank} 处空白`);
  return ` · ${parts.join('、')}`;
}

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
  // 旧服务进程不返回 annotations，那时候退回只显示字数
  const marks = output.stats.annotations ?? 0;
  const wordsHint = formatWords(output.stats.words);

  return (
    <div className="flex flex-col gap-6">
      {/* 固定 3 列 + 固定间距：预览开合时高度稳定 */}
      <div className="grid grid-cols-3 gap-2">
        <Stat
          label="产出文件"
          value={output.stats.total}
          hint={marks ? `${wordsHint} · ${marks} 处标注` : wordsHint}
        />
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
                      {/* 文档自身的相对路径，方便直接喂给 AI / 命令行 */}
                      <span className="truncate text-xs text-muted-foreground" title={item.path}>
                        {item.path}
                        {datePrefix(item.name) ? '' : ` · ${formatRelative(item.mtime)}`}
                        {annotationLabel(item)}
                      </span>
                    </div>
                    <CopyButton value={markdownLink(item.title || item.name, item.path)} />
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
