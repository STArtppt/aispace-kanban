import { useEffect, useState } from 'react';
import { ImageLightbox } from '@/components/ImageLightbox';
import { CopyButton } from '@/components/Primitives';
import { api, type AssetGroup } from '@/lib/api';
import { formatBytes } from '@/lib/format';

/**
 * 图库预览：缩略图铺满预览区，点一张进灯箱。
 * 复制按钮压在缩略图右上角，复制的是工作空间内相对路径 —— 那是丢给 AI 让它读图的形式。
 */
export function AssetGalleryReader({
  group,
  projectId,
}: {
  group: AssetGroup;
  projectId: string;
}) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const images = group.images;
  const openIndex = openPath ? images.findIndex((item) => item.path === openPath) : -1;

  // 换图库时关掉灯箱，避免上一摞的图串到这一摞
  useEffect(() => {
    setOpenPath(null);
  }, [group.path]);

  if (!images.length) {
    return <p className="text-sm text-muted-foreground">这个图库里没有图片。</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {images.length} 张图 · {formatBytes(group.size)} · 点图看大图，右上角复制路径
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {images.map((item) => (
          <div key={item.path} className="group relative flex flex-col">
            <button
              type="button"
              onClick={() => setOpenPath(item.path)}
              title={item.name}
              className="cursor-zoom-in overflow-hidden rounded-lg border border-border bg-muted/40 transition-colors hover:border-foreground/30"
            >
              <img
                src={api.fileUrl(projectId, item.path)}
                alt={item.name}
                loading="lazy"
                className="aspect-[4/3] w-full object-cover"
              />
            </button>
            <CopyButton
              value={item.path}
              className="absolute top-1 right-1 border border-border bg-background/85 opacity-80 hover:opacity-100"
            />
            <span className="truncate pt-1 text-[11px] text-muted-foreground" title={item.name}>
              {item.name}
            </span>
          </div>
        ))}
      </div>
      {openIndex >= 0 ? (
        <ImageLightbox
          key={openPath}
          items={images.map((item) => ({
            src: api.fileUrl(projectId, item.path),
            alt: item.name,
            copyValue: item.path,
          }))}
          initialIndex={openIndex}
          onClose={() => setOpenPath(null)}
        />
      ) : null}
    </div>
  );
}
