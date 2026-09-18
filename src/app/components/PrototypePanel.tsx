import { CaptureBar } from '@/components/CaptureBar';
import { LinkedPrototypeRow } from '@/components/LinkedPrototypeRow';
import { EmptyState, SectionTitle } from '@/components/Primitives';
import { ShowcaseCard, ShowcaseGrid } from '@/components/ShowcaseCard';
import type { CaptureControl } from '@/hooks/useCaptureJob';
import type { ProtoSyncControl } from '@/hooks/useIngestJob';
import type { FileItem, PrototypeItem, Prototypes } from '@/lib/api';
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
 *
 * 原型工作区同步过来的原型（item.linked）单独一段、一行一份；被它并入的 zip 与重复卡片
 * （item.groupedInto）不再单独成卡。旧服务进程不给这两个字段时，只剩卡片网格，与改动前一致。
 */
export function PrototypePanel({
  prototypes,
  capture,
  protoSync,
  openPath,
  onOpen,
}: {
  prototypes: Prototypes;
  capture: CaptureControl;
  protoSync: ProtoSyncControl;
  openPath?: string;
  onOpen?: (file: FileItem) => void;
}) {
  const { items, note, updatedAt, legacyDir } = prototypes;
  const linkedItems = items.filter((item) => item.linked);
  const plainItems = items.filter((item) => !item.linked && !item.groupedInto);

  const grid = plainItems.length ? (
    <ShowcaseGrid>
      {plainItems.map((item) => {
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
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      <CaptureBar
        plane="prototype"
        control={capture}
        placeholder="贴一条云端发布链接，例如 https://…/p/abc"
        actionLabel="导入"
        status={
          updatedAt
            ? `最近更新 ${formatRelative(updatedAt)}${linkedItems.length ? ` · ${linkedItems.length} 份原型已接入原型工作区` : ''}`
            : null
        }
        scopeNote={
          // 这里收的不是文件：云端原型是 SPA，抓下来既失真又没意义，点它就该开原站
          <>
            这里收的是云端发布链接（axhub-make 发布、figma make 的 publish / share）——
            只存链接和一张封面，点卡片打开的是原站，本地不留页面副本。本地的 HTML 包请直接放进{' '}
            <code className="font-mono">visualization/prototypes/</code>。
          </>
        }
      />

      {/* note 也承载单个 zip 的解压失败等信息，清单为空时照样要显示，否则那条错误就没人看得见 */}
      {note ? (
        <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
          {note}
        </div>
      ) : null}

      {items.length ? (
        linkedItems.length ? (
          <>
            <section className="flex flex-col gap-3">
              <SectionTitle count={linkedItems.length} divider>
                已接入原型工作区
              </SectionTitle>
              {linkedItems.map((item) => (
                <LinkedPrototypeRow key={item.itemKey} item={item} openPath={openPath} onOpen={onOpen} protoSync={protoSync} />
              ))}
            </section>
            {grid ? (
              <section className="flex flex-col gap-3">
                <SectionTitle count={plainItems.length} divider>
                  其他原型
                </SectionTitle>
                {grid}
              </section>
            ) : null}
          </>
        ) : (
          grid
        )
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
