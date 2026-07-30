# 工作空间看板 workspace-dashboard

PM 接手项目工作空间（[pmwork-template](../pmwork-template)）的**只读看板**。
常驻服务模式：服务起在本机，指向任意几个工作空间目录，浏览器里切换查看。

看板对工作空间**只读**，不会往里写任何文件。

## 用法

```bash
pnpm install
pnpm build                                  # 构建前端（首次必须）

node bin/cli.mjs add ../pmwork-template     # 登记一个工作空间
node bin/cli.mjs list                       # 看已登记的
node bin/cli.mjs serve                      # 起服务 → http://localhost:5180
```

开发时用 `pnpm dev`：同时起接口服务（5180）和 Vite（5181），改前端代码即时热更，
浏览器开 <http://localhost:5181>。

登记信息存在 `~/.pmwork/dashboard/projects.json`（和 Axhub Make 的 `~/.axhub/make/projects.json` 一个套路）。

## 四个视图

| 视图 | 内容 |
| --- | --- |
| 概览 | 项目元信息 + 阶段判断。`project.yaml` 还没有时，阶段是按目录状态**推断**的，界面上会明确标「推断」 |
| 输入资料 | 原始资料 / 转换产物清单，读 frontmatter 里的溯源信息；**待转换**和**内容存疑**单独highlight |
| 产出文档 | `output/` 的 analysis / docs / decisions 三栏，带篇幅和更新时间 |
| 原型 | 自动读 `prototypes/.axhub/`，列出 Axhub Make 里的原型并跳转 |

内置阅读器支持 Markdown（frontmatter 折叠成溯源条、相对图片路径自动解析）、CSV 表格、图片；
docx/PDF/xlsx 这类原始格式不在网页里渲染，点「用默认程序打开」或「在访达中显示」交给系统。

## 它怎么拿到数据

服务端扫描工作空间目录，前端只渲染扫描结果：

- `input/converted/**` 的 frontmatter → 来源路径、sha256、转换工具、`warning` 标记
- 原始资料与转换产物按 `source` 字段对账 → 算出**还没转换**的资料
- `output/{analysis,docs,decisions}` → 文件清单、标题、篇幅、更新时间
- `prototypes/.axhub/make/sidebar-tree.json` + `.dev-server-info.json` → 原型清单和可点击链接

`input/` `output/` 有变化时通过 SSE 推给前端自动刷新，不用手动刷页面。

## 设计系统

UI 组件来自 [startist-ui](../startist-ui)，通过 shadcn registry 拉取（copy-in）。
registry 还没部署到公网，本地更新组件的方法：

```bash
cd ../startist-ui && npm run registry:build
python3 -m http.server 5199 --directory public &     # 临时喂给 shadcn
cd ../workspace-dashboard && npx shadcn@latest add @startist/<组件名> --yes
```

配色遵守 startist 的硬约束：黑白灰为主，**orange（`--destructive`）只用于"需要注意"**——
在这个看板里就是待转换资料和内容存疑的资料，别的地方一律不上彩色。
