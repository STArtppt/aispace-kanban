import { EmptyState, SectionTitle } from '@/components/Primitives';
import { ShowcaseCard, ShowcaseGrid } from '@/components/ShowcaseCard';
import type { References } from '@/lib/api';
import { formatRelative } from '@/lib/format';

const SOURCE_LABEL: Record<string, string> = {
  manual: '手工放入',
  'url-capture': '按 URL 采集',
  plugin: '插件投递',
};

/**
 * 「视觉呈现 · 参考」：收下来的别人的页面。
 *
 * references 为 undefined = 服务进程比前端旧（改完代码没重启 serve）——
 * 这时只说明要重启，不白屏、不报错；原型 tab 不受影响。
 */
export function ReferencePanel({ references }: { references?: References }) {
  if (!references) {
    return (
      <div className="flex flex-col gap-4">
        <SectionTitle>参考</SectionTitle>
        <EmptyState
          title="当前看板服务还没有参考能力"
          hint="重启看板服务（pnpm serve / pnpm dev）后即可看到 visualization/references/ 里的参考"
        />
      </div>
    );
  }

  const { items, note, updatedAt } = references;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle count={items.length}>参考</SectionTitle>
        {updatedAt ? (
          <span className="text-xs text-muted-foreground">最近更新 {formatRelative(updatedAt)}</span>
        ) : null}
      </div>

      {/* note 也承载单个 zip 的解压失败等信息，清单为空时照样要显示，否则那条错误就没人看得见 */}
      {note ? (
        <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
          {note}
        </div>
      ) : null}

      {items.length ? (
        <ShowcaseGrid>
          {items.map((item) => (
            <ShowcaseCard
              key={item.itemKey}
              title={item.title}
              // 来源优先显示原始 URL，手工摆进来的就显示它在工作空间里的位置
              subtitle={item.sourceUrl || item.sourcePath || item.itemKey}
              cover={item.cover}
              href={item.url}
              badge={item.source ? SOURCE_LABEL[item.source] || item.source : undefined}
            />
          ))}
        </ShowcaseGrid>
      ) : (
        <EmptyState
          title="还没有参考页"
          hint="一份参考是一个目录，入口叫 index.html —— 把自包含的 HTML 放成 visualization/references/<名字>/index.html 即可。散装的 .html 直接扔在 references/ 根上扫不到。"
        />
      )}
    </div>
  );
}
