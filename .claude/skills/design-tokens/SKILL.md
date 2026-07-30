---
name: design-tokens
description: 在 workspace-dashboard 中改动颜色 / 字体 / 圆角 / 深色模式等视觉体系时使用 —— 令牌唯一写在 globals.css,且必须遵守"黑白灰为主、orange 只给需要注意"的硬约束。
---

# 设计令牌与配色约束(Design Tokens)

## 何时使用

- 新增 / 修改颜色、字体、圆角等视觉变量。
- 想给某个元素"上个颜色"、"标个红"、"加个高亮"时 —— **先读本技能的硬约束**。
- 深色模式下表现不对时。

## 硬约束(startist 设计系统,不是建议)

1. **黑白灰为主。** 所有层级用中性色 + 边框 + 灰底表达。
2. **orange(`--destructive`)只用于"需要注意"。** 在这个看板里就是:
   待转换资料、内容存疑(frontmatter 的 `warning`)、登记目录丢失。
   **不是**"删除"的专属色,也**不是**强调色。除此之外的地方一律不上彩色。
3. 想加新颜色 = 想违反第 1 条。先停下来问人;要加也只能加进 `globals.css` 的变量层,
   并在注释里写清用途。

## 令牌结构(`src/app/styles/globals.css`,唯一源头)

三段,改的时候分清:

```css
@theme inline {         /* 1. 把 CSS 变量映射成 Tailwind 工具类 */
  --color-card: var(--card);        /* → bg-card / text-card / border-card */
  --radius-lg: var(--radius);
}
:root { --card: oklch(1 0 0); }     /* 2. 亮色取值 */
.dark { --card: oklch(0.205 0 0); } /* 3. 深色取值 */
```

- 颜色用 **oklch**,跟现有写法一致。
- 深色模式靠 `.dark` 类(`App.tsx` 的 `useTheme` 挂在 `<html>` 上),
  **不用** `prefers-color-scheme` 媒体查询写样式。
- 无 `tailwind.config.js`(Tailwind v4),别去找它。

现有语义令牌:`background` / `foreground` / `card` / `popover` / `primary` / `secondary` /
`muted` / `accent` / `destructive`(+ 各自的 `-foreground`)/ `border` / `input` / `ring`;
字体 `font-sans` / `font-mono` / `font-display`;圆角 `radius-sm…4xl` 由 `--radius` 派生。

## 加一个令牌(确实必要时)

```css
/* src/app/styles/globals.css */
@theme inline {
  --color-notice: var(--notice);   /* → bg-notice / text-notice / border-notice */
}
:root { --notice: oklch(0.646 0.222 41.116); }  /* 用途:xxx */
.dark { --notice: oklch(0.705 0.213 47.604); }  /* 深色必须一起给 */
```

**三段都要改** —— 只加 `@theme inline` 不给取值,类名会静默失效。

## 常见错误

| 写法 | 问题 |
| --- | --- |
| `text-orange-500` / `#f97316` | 硬编码,深色模式失效;要"注意"就用 `text-destructive` |
| `bg-stone-100` / `bg-zinc-800` | 原始色阶绕过了令牌层,该用 `bg-muted` / `bg-card` |
| 只加亮色变量 | 深色模式下拿不到值 |
| 用 `shadow-*` 做层级 | 本项目靠边框 + 灰底,`surface` 变体的 CTA 除外 |
| 给普通信息上彩色 | 违反黑白灰约束 |

## 参考

- 令牌文件:`src/app/styles/globals.css`
- 上游设计系统:[startist-ui](../../../../startist-ui);配色说明也记在 [README.md](../../../README.md) 末节
- 关联:[[react-component-authoring]]
- Tailwind v4 主题文档:https://tailwindcss.com/docs/theme
