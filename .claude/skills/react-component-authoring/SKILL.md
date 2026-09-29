---
name: react-component-authoring
description: 在 aispace-kanban 中新建或重构 React 组件 / 面板 / 视图时使用 —— 组件结构、props 类型、已有可复用小件、startist 组件消费方式与可访问性。
---

# React 组件编写(Component Authoring)

## 何时使用

- 新增面板、视图、对话框、列表行等任何前端组件。
- 重构 / 拆分既有组件。

## 先复用,再新建

动手写之前按顺序查一遍,能复用就别造:

1. **`components/Primitives.tsx`** —— `Stat`(统计块)、`SectionTitle`(带计数的小标题)、
   `EmptyState`(空态)、`Row`(可点击列表行)、`ListPager`(列表底部分页)、
   `TruncatedHint`(说明文字单行截断 + tooltip)、
   `CopyButton`(复制路径的小图标,能压在列表行/缩略图里)、`writeClipboard`(自己拼按钮时用)。
   看板里 80% 的排版需求都在这里。
   图片相关的组合件另有三个:`ImageLightbox`(多图灯箱,支持缩放/翻页/复制路径)、
   `AssetGalleryStack`(把 `AssetGroup` 映射到 `ui/gallery-stack`)、
   `AssetGalleryReader`(预览区缩略图墙)。
2. **`components/ui/**`** —— startist registry copy-in 的通用件:
   `Button`(`primary|secondary|outline|ghost|danger|surface` × `sm|md|lg|icon`)、
   `Badge`(`default|secondary|outline|muted` × `sm|md`)、`Input`、`Select`、`Dialog`、`Tabs`、
   `Tooltip`、`ScrollArea`、`CodeBlock`（文档围栏代码走 `MarkdownCodeBlock` 适配）、
   `Lightbox`（mermaid 全屏等媒体预览）、
   `GalleryStack`（一摞图的入口卡：`cover` / `count` / `size` / `selected`，
   卡片自己限宽，别再在调用方排列数）、
   `FeatureCard`（点进去的模块瓷砖：`icon` / `title` / `description` / `meta`，
   网格用 `FeatureCardGrid` 锁 gap-8；默认 button + cursor-pointer）、
   `Alert`（行内提示，`default|destructive`；可关闭用 `AlertAction` + 调用方 state，组件不管可见性）。
3. **registry 上有但本仓还没拉的**(`drawer` / `confirm-dialog` / `field` / `switch` …)
   —— 用 `shadcn add` 拉,别手写第二遍。add 的来源、命令与注意事项见 [[design-system-loop]]。
   **`components/ui/**` 是 vendored 快照**:不做与上游分叉的语义修改
   (透传 `className` 做局部微调可以)。需要改行为就上行改 startist-ui。

## 规范

- **函数组件 + Hooks**,不用 class。
- **props 类型**:小的本地组件直接内联标注(照 `Primitives.tsx`);
  跨文件复用或字段多的组件用 `interface XxxProps` 并与组件一起导出。
- **一个文件一个主组件**,文件名与组件同名(`PascalCase`)。同文件内的私有子组件不导出。
- **className 用 `cn()` 合并**(`@/lib/utils`),条件类写成 `cond && '...'`。
- **样式只用 Tailwind 工具类 + 语义令牌**(`bg-card` / `text-muted-foreground` / `border-border`),
  不硬编码色值、不用 `stone-*` / `zinc-*` 原始色阶 —— 详见 [[design-tokens]]。
- **状态最小化、就近放置**:能从 `scan` 派生的不入 state;副作用进 `useEffect` 并写全依赖;
  跨组件共享的请求状态放 `hooks/useWorkspace.ts`,别在组件里裸写 `fetch`(走 `@/lib/api` 的 `api`)。
- **可访问性**:可点击的东西用 `<button type="button">` 或 `<a>`(`Row` 已经是 button),
  图标按钮补 `aria-label` 或 `Tooltip`,别用 `div + onClick`。
- **图标** 用 `lucide-react`,尺寸走 `size-3.5` / `size-4` 这类工具类。
- **长列表**外面套 `ScrollArea`,别让整页滚。

## 视觉习惯(和现有界面保持一致)

- 层级靠**边框 + 灰底**,不靠阴影(`surface` 变体的 CTA 除外)。
- 常用字号:正文 `text-sm`、辅助信息 `text-xs`、大数字 `font-display text-2xl`。
- 圆角统一 `rounded-lg`;卡片 `rounded-lg border border-border bg-card`。
- 空态用虚线边框(`EmptyState` 已经是)。
- **深色模式必须能看** —— 只用语义令牌就自动成立;写完切一下右上角验证。

## 最小示例

```tsx
import { cn } from '@/lib/utils';
import { Row } from '@/components/Primitives';
import type { FileItem } from '@/lib/api';

export function DocRow({ item, active, onOpen }: {
  item: FileItem;
  active?: boolean;
  onOpen: (item: FileItem) => void;
}) {
  return (
    <Row active={active} onClick={() => onOpen(item)}>
      <span className="min-w-0 flex-1 truncate text-sm">{item.title || item.name}</span>
      {item.warning ? (
        // orange 只用于"需要注意",别拿它当强调色
        <span className={cn('text-xs', 'text-destructive')}>存疑</span>
      ) : null}
    </Row>
  );
}
```

## 新增一个视图时

`App.tsx` 里有两处要同时改:`View` 联合类型 和 `NAV` 数组。少改一处 → 侧栏点不到 /
类型不通过。完整顺序见 [[dashboard-feature-flow]]。

## 关联

- [[design-tokens]]、[[project-conventions]]、[[dashboard-feature-flow]]
