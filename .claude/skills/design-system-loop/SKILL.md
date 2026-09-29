---
name: design-system-loop
description: 在 aispace-kanban 中接入 / 升级 / 回流 startist-ui 设计系统组件时使用 —— shadcn registry 的 add 来源与命令、vendored 快照不可 fork 的红线、发现缺口回流真源再 re-add 的闭环。
---

# 设计系统闭环 · 消费侧(Consume → Feedback → Re-add)

本仓是 **startist-ui 设计系统的消费端**(与 pentou、acgogogo 并列的又一个产品端)。
所有通用 UI 原语从 registry **copy-in**,本仓只写调用方。

## 何时使用

- 要拉一个本仓还没有的原语(drawer / confirm-dialog / switch / field …)。
- 页面里出现手写 `<button>` / 自制弹层 / `window.confirm`,想换成 registry 原语。
- 现有 `components/ui/**` 的组件不够用:缺变体、圆角不对、颜色语义错、行为有 bug。
- 真源升级了,要把本仓的 vendored 快照更新一遍。

**不适用**:纯业务面板排版(走 [[react-component-authoring]])、只改令牌取值(走 [[design-tokens]])、
组件没坏但用法用错了(走 [[systematic-debugging]])。

## 角色与路径

| 角色 | 位置 | 职责 |
| --- | --- | --- |
| **真源** | `../startist-ui`(同级) | `registry/ui/*`、`registry.json`、demo、`DESIGN.md`(设计规范唯一真源) |
| **消费(本仓)** | `src/app/components/ui/**` | `shadcn add`、业务调用方、验证、把缺口写成回流 brief |
| **公网 registry** | `https://ui.startist.top/r/{name}.json` | 已上线,任何机器可直接 add |

真源侧有对称技能 `../startist-ui/skills/design-system-loop/`(PRODUCE / HANDOFF / FEEDBACK)。
双会话协作时,那边只产出、本仓只消费,**两边都不替对方写代码**。

## 闭环(必须按序)

```text
① 发现缺口(页面要一个本仓没有的原语 / 现有原语不对)
      ↓
② 判定:调用方问题 还是 真源问题(见下方决策树)
      ↓  调用方问题 → 直接改业务代码,结束
③ 真源改 registry/ui/<name>.tsx → registry:build(+ deploy)
      ↓
④ 本仓 shadcn add --overwrite → 只改调用方 → typecheck + build + 冒烟
      ↓
⑤ 仍不够 → 回 ③(别在本仓凑合)
```

## 红线

1. **`src/app/components/ui/**` 是 vendored 快照,不做与上游分叉的语义修改。**
   透传 `className` 微调可以;改 variant 定义、改结构、改行为一律上行到 startist-ui。
   在本仓"临时修一下 API"= 下次 re-add 时被覆盖,且真源永远不知道这个缺口。
2. **不为本仓单独在真源加一次性变体**,除非同时写进真源 `DESIGN.md`。
3. **形态不对不硬套**:侧滑抽屉不是 Dialog,全屏预览不是 Dialog + 抬 z-index。
   没有对应 item 就回流新增,或者这一轮先不做。
4. **不因为拉了组件就上彩色** —— 黑白灰为主、orange 只给"需要注意"的硬约束照旧([[design-tokens]])。

## CONSUME:怎么 add

`components.json` 的 `@startist` 当前指向 `http://localhost:5199/r/{name}.json`
(本地临时静态服务),**别名可用的前提是那个服务起着**。三种来源按方便程度选:

```bash
# A. 公网(最省事,真源已 deploy 时)
npx shadcn@latest add https://ui.startist.top/r/<item>.json --yes --overwrite

# B. 本地别名(需要先在真源起静态服务,react-component-authoring 里的老办法)
cd ../startist-ui && npm run registry:build
python3 -m http.server 5199 --directory public &
cd ../aispace-kanban && npx shadcn@latest add @startist/<item> --yes --overwrite

# C. 本地文件直链(真源有未 deploy 的改动时最可靠)
npx shadcn@latest add ../startist-ui/public/r/<item>.json --yes --overwrite
```

add 之后**先看 `git status`**,三件事要确认:

- 落点是 `src/app/components/ui/<item>.tsx`。若 CLI 没解析好别名、新建了 `src/components/ui/`,
  删掉重来,别让仓库出现第二个 ui 目录。
- `package.json` 是否被加了依赖 —— 有就 `pnpm install`。
- `src/app/styles/globals.css` 是否被动过 —— 见下条。

### theme 特别注意

`add @startist/theme` 会重写 `globals.css`,而它是本仓**令牌唯一源头**,里面有三处
registry 不知道的本地内容,被覆盖必须手工恢复:

- `@import "tailwindcss" source(none)` + `@source "../"` —— 少了它 Tailwind 会去扫
  `template/`,产物体积和类名全乱。
- `--font-display`(Playfair)等字体栈。
- `@layer base` 里 `html, body, #root { height: 100%; overflow: hidden }` —— 看板是整屏不滚布局。

所以:拉 theme 前先 `git diff` 心里有数,拉完立刻 diff 一遍再决定收哪些。

## 决策树:改调用方 还是 改真源

| 现象 | 改哪里 |
| --- | --- |
| 这个按钮该用 ghost 却用了 primary | **调用方** variant |
| 导航选中态太抢眼 | **调用方**组合(ghost + accent),不新开变体 |
| 某个面板要特殊间距 / 宽度 | **调用方** `className` |
| 全站按钮圆角 / 焦点环不对 | **真源** → re-add |
| checked / hover 用了非语义色 | **真源**换语义令牌 → re-add |
| 缺整个形态(drawer、confirm-dialog、field) | **真源**新 item → add |
| 组件在特定嵌套下行为出错(冒泡、焦点、Escape) | 调用方能兜住就兜(如 `stopPropagation`);需要组件本身收敛才回流 |

## 验证闸(本仓没有 lint:ui,也没有测试)

```bash
pnpm typecheck && pnpm build
```

再加**手动冒烟**,拉 UI 组件时这一步不能省:

- `pnpm dev` 打开受影响的视图,明暗两种主题各看一遍。
- 弹层类:Escape、点遮罩、焦点环、`ScrollArea` 里的滚动。
- 若用 `pnpm serve`(伺服 `dist/`):**必须先 `pnpm build`**,否则看到的还是旧快照。

结论口径见 [[verification-before-completion]]:没跑过就不算做完。

## FEEDBACK:回流 brief 模板

缺口要写成可执行的东西交给真源会话,不是聊天碎句:

```text
# 回流 startist-ui:@startist/<name>

## 现象(aispace-kanban 侧)
- 场景:哪个视图 / 哪个交互
- 期望:
- 现状:

## 建议改动(真源)
- 文件:registry/ui/<name>.tsx
- 具体:

## 非目标
- 不要为看板单独加只此一处用的变体(除非写进 DESIGN.md)

## 验收
- demo 覆盖新行为;registry:build + build 通过
- 告诉我:json 来源(公网 / 本地路径)+ API 摘要
```

RE-ADD 后 `git diff src/app/components/ui/<name>.tsx`:**应该只有真源的改动**。
出现本仓私货就删掉,改到调用方去。

## 形态分流(看板里的具体场景)

| 看板场景 | 归属 |
| --- | --- |
| 主操作 / 危险 / 图标按钮 | `button` 变体 + `size="icon"` |
| "移出看板"这类确认 | `confirm-dialog`(registry 有,本仓未拉),别用 `window.confirm` |
| 新建工作空间的路径表单 | `field` + `input` |
| 原型 / 图片全屏预览 | `lightbox`(z=60),不是 Dialog 抬 z-index |
| 一摞图的入口卡(图片资料) | `gallery-stack`(封面+垫卡,`count` 决定厚度、`size` 控卡片宽度);缩略图墙是调用方自己的网格 |
| 侧滑详情或筛选 | `drawer`,不是 Dialog |
| 阅读器里的代码块 | `code-block` |
| 操作结果提示 | `sonner` / `alert`,别自己写浮层 |
| 列表行尾的一堆动作(复制 / 转换 / 定位) | `dropdown-menu` 收进「更多」,别在行上摊图标 |
| 标题常驻、正文按需展开的卡(未决问题的「为什么需要」) | `feature-block`(整头部可点、默认收起),不自己拿 `<details>` 拼 |
| 工作台浏览页的四张模块入口卡 | `feature-card`(发丝线+角标,默认 button + cursor-pointer);网格用 `FeatureCardGrid` 锁 gap-8,列数调用方自己写 |
| "待转换 / 存疑"状态 | `badge` + `destructive` 令牌,不新增颜色 |

## 当前快照

- **已 copy-in**:`alert` `badge` `button` `code-block` `collapsible` `dialog` `dropdown-menu`
  `feature-block` `feature-card` `gallery-stack` `input` `lightbox` `scroll-area` `select`
  `sonner` `switch` `tabs` `textarea` `tooltip`
- **registry 上还有**:`checkbox` `confirm-dialog` `drawer` `field` `label` `theme`

拉了新的就把这两行更新掉 —— 这份清单是给下一个 Agent 省一次 `ls` 的。

## 关联

- [[react-component-authoring]] —— 拉进来之后怎么用、怎么组合
- [[design-tokens]] —— 颜色 / 圆角 / 深色模式的硬约束
- [[verification-before-completion]] —— 完成判据
- [[dashboard-feature-flow]] —— 组件只是一环,跨平面功能按它的顺序走
