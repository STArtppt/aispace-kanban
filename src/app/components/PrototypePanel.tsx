import { EmptyState, SectionTitle } from '@/components/Primitives';
import { ShowcaseCard, ShowcaseGrid } from '@/components/ShowcaseCard';
import type { PrototypeItem, Prototypes } from '@/lib/api';
import { formatRelative } from '@/lib/format';

/** 用户跑完这条就搬完家了。看板只给命令，不代劳（对工作空间只读）。 */
const MIGRATE_CMD = 'mkdir -p visualization && mv prototypes visualization/prototypes';

function kindLabel(kind?: PrototypeItem['kind']) {
  if (kind === 'zip') return 'zip';
  if (kind === 'folder') return '文件夹';
  if (kind === 'url') return '云端链接';
  return '';
}

/**
 * 「视觉呈现 · 原型」：工具产出的可点击 HTML 包，或云端发布链接。
 *
 * 两种形态点击行为不同：bundle 开看板伺服的 url，url 形态直接开外部 target。
 * kind 缺失（旧服务进程）时当 bundle 处理，退回改动前的行为。
 */
export function PrototypePanel({ prototypes }: { prototypes: Prototypes }) {
  const { items, note, updatedAt, legacyDir } = prototypes;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle count={items.length}>原型</SectionTitle>
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
          {items.map((item) => {
            const isUrl = item.kind === 'url';
            // url 形态的 target 已由服务端校过协议：空串 = 地址不合法
            const href = isUrl ? item.target || '' : item.url;
            return (
              <ShowcaseCard
                key={item.itemKey}
                title={item.title}
                subtitle={isUrl ? item.target || item.sourcePath || item.itemKey : item.sourcePath || item.itemKey}
                cover={item.cover}
                href={href}
                badge={kindLabel(item.kind) || undefined}
                disabledHint={isUrl && !href ? '这条云端原型的地址不合法（只支持 http / https），看板不打开它' : undefined}
              />
            );
          })}
        </ShowcaseGrid>
      ) : (
        <div className="flex flex-col gap-3">
          <EmptyState
            title="还没有原型"
            hint="把工具产出的、已构建好的 HTML 包（zip 或解压后的文件夹，根目录含 index.html）放进 visualization/prototypes/；云端发布的原型写一份 meta.json 记下链接即可。未构建的源码包不在支持范围内，请先用工具的「导出 HTML」。"
          />
          {legacyDir ? (
            <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
              <p>
                检测到旧位置还有原型（工作空间根上的 <code className="font-mono">{legacyDir}/</code>）。
                原型已经搬到 <code className="font-mono">visualization/prototypes/</code>，
                看板对工作空间只读、不代替你搬家 —— 在工作空间根目录跑一次：
              </p>
              <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] text-foreground">
                {MIGRATE_CMD}
              </pre>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
