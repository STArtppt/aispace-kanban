import { Images } from 'lucide-react';
import { GalleryStack } from '@/components/ui/gallery-stack';
import { api, type AssetGroup, type FileItem } from '@/lib/api';

/**
 * 图片资料区：每份文档抽出的图算一摞，点开在右侧预览里排缩略图。
 * 卡片形态来自 @startist/gallery-stack（垫卡、尺寸、选中态都在真源里），
 * 这里只负责把扫描结果映射成它的 props。
 *
 * flex-wrap 而不是固定列数：卡片自己限宽（size=md ≈ 11rem），
 * 宽屏一行多摞、预览打开后自动折行，不需要为每个断点排一遍列数。
 */
export function AssetGalleryStack({
  groups,
  projectId,
  openPath,
  onOpen,
}: {
  groups: AssetGroup[];
  projectId: string;
  openPath: string;
  onOpen: (item: FileItem) => void;
}) {
  return (
    <div className="flex flex-wrap gap-4">
      {groups.map((group) => {
        const cover = group.images[0];
        return (
          <GalleryStack
            key={group.path + group.name}
            // render 换成带 title 的 button：组件的 title prop 是卡面文字，
            // 原生 tooltip 要用来显示图库所在目录
            render={<button type="button" title={group.path} />}
            count={group.images.length}
            selected={openPath === group.path}
            onClick={() => onOpen(group)}
            title={group.title || group.name}
            caption={`${group.images.length} 张图`}
            cover={
              cover ? (
                <img src={api.fileUrl(projectId, cover.path)} alt={cover.name} loading="lazy" />
              ) : (
                <span className="grid size-full place-items-center">
                  <Images className="size-5 text-muted-foreground" />
                </span>
              )
            }
          />
        );
      })}
    </div>
  );
}
