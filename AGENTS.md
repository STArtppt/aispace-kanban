# AGENTS.md —— 项目编码规范总则

> 本文件是 **aispace-kanban** 面向所有编码 Agent 与人类协作者的**唯一事实源**。
> `CLAUDE.md` 只是指针;改协作约定 / 项目说明**只改本文件**。
> 使用说明在 [README.md](./README.md),人类贡献者入口在 [CONTRIBUTING.md](./CONTRIBUTING.md)。

---

## 1. 项目是什么 + 最硬的不变量

**aispace-kanban** 是**与 AI 反复对话完成知识工作**时用的**只读看板**:常驻本机的服务,
指向若干工作空间目录,在浏览器里看概览 / 输入资料 / 产出文档 / 原型。
只认 `input/` + `output/` 的目录约定(判据见 `config.mjs` 的 `inspectWorkspace`),**不绑定行业或岗位**。

工作空间**模板**([`templates/`](./templates))也在本仓维护,是**另一套语境**:本文件的编码规范
**不适用于 `templates/` 内部**,改 PM 模板见 [`templates/pm-aispace/AGENTS.md`](./templates/pm-aispace/AGENTS.md)。

**不变量(违反即为 bug,不接受任何"顺手写一下"):**

1. **对工作空间只读。** 服务端不 `write` / `rename` / `unlink` 工作空间里的任何文件。
   下面列的是**全部**例外;不在清单里的写入一律不许加,要加先改这份清单。

   **所有带编号的例外都共同满足**:必须用户在看板上明确点击发起(没有后台任务、定时、自动推导);
   必须环回(`allowMutations`)且非跨站(`rejectIfForeignOrigin`),否则 403;
   各条列出范围以外的工作空间文件仍然只读。

   例外分两种形状,**不要混用**:
   - **spawn 族**:看板只 `spawn` 工作空间自己的脚本,自己一个字节都不写(资料转换、第三、五、七、九条);
   - **直写族**:看板服务端自己写。第二条只新建;第四、六、八条是没有现成脚本可承接的高频小写入,
     一律「先写临时文件再原子替换」,失败不留半截文件。
     不要因为「反正已经能写了」再开一条清单外的写入。

   **不编号的基础写入:**
   - 注册表 `~/.pmwork/dashboard/projects.json`(`config.mjs` 的 `writeProjects`)—— 不碰工作空间
   - 新建工作空间:spawn `templates/init_workspace.py --from <模板目录>`(`http.mjs` 的 `runInit`)。
     骨架与 `.aispace/template.lock.json` 都由脚本写,看板不自己造目录
   - 资料转换:spawn 工作空间的 `scripts/ingest.py`(`http.mjs` 的 `startIngest`)。
     `ANYDOC_BIN` 由看板注入本地 anydoc 路径,解析不到就不注入(脚本走 PATH)
   - 忽略待转换资料:追加 `input/.ingestignore`(`http.mjs` 的 `addIgnore`)。只追加一行模式,不改原件;
     这份文件是看板与 ingest.py 的共用约定,不经脚本

   **第二条 · 采集视觉材料**(`capture.mjs` 的 `writeCaptureDir`,直写):
   ① 只写 `visualization/references/<slug>/` 与 `visualization/prototypes/<slug>/`;
   ② 用户贴 URL 发起; ③ 环回且非跨站;
   ④ 路径过 `resolveInside()`,slug 由服务端生成并安全化,不接受客户端的任何路径片段;
   ⑤ **只新建,不覆盖、不删除**,同一 URL 再采生成新 slug;
   ⑥ 以后别的写入来源(浏览器插件投递等)复用这个收口,**不得扩大目录范围**

   **第三条 · 刷新已接入原型**(spawn 原型工作区的 `workspace-sync.mjs`,`http.mjs` 的 `startProtoSync`):
   ① 看板只 spawn; ② 用户点「刷新」发起; ③ 环回且非跨站;
   ④ 请求只带原型 `itemKey`,**不接受任何路径**;脚本与原型目录只来自通过三道校验的 `sync.json`
      (脚本名为 `workspace-sync.mjs` 且存在;原型目录存在;`.workspace-link.json` 回指当前工作空间);
   ⑤ 工作空间内脚本只写 `visualization/prototypes/<slug>/`(整份覆盖 `spec/` `docs/` `annotations/`
      `comments/` `meta.json` `SYNC.md` `sync.json`)与同级 `<slug>-html.zip`;
      工作空间外只写原型目录的 `.workspace-inbox.md`;`input/` `output/` `project.yaml` 只读其修改时间

   **第四条 · 未决问题的人工反馈**(写 `output/questions/Q<编号>.md`,`questions.mjs` 的 `writeQuestion`,直写):
   ① 只**改已存在**的问题文件,不新建、不删除、不改名,不存在 404;
   ② 只写**人写区**(`status` / `human_answer` / `human_note` / `due` 与正文「## 人工反馈」);
      载荷带 **AI 写区**字段(`evidence` / `ai_conclusion` / `ai_source` / `flows_to`)一律 400 不落盘 ——
      写区物理隔开就是并发方案(不用锁,见 `questions/README.md`);
   ③ 用户点「保存」发起; ④ 环回且非跨站;
   ⑤ 请求**只带编号**(`Q0134`),落盘路径由服务端过 `resolveInside()` 自己拼;
   ⑥ 其余 `input/` `output/`(含 agent 生成的 `output/decisions/` 草稿)与 `project.yaml` 只读

   **第五条 · 刷新参考收件箱**(spawn `scripts/web_ingest.py --inbox`,`http.mjs` 的 `startWebIngest`):
   ① 看板只 spawn; ② 用户在参考 tab 点「刷新」发起; ③ 环回且非跨站;
   ④ 请求**不带路径、文件名、URL**,脚本自己扫 `visualization/references/` 根上的散装 `.html` / `.htm`;
   ⑤ 脚本只把散装文件收成新目录 `visualization/references/<slug>/`(`index.html` + `meta.json`),
      并把抽出的 Markdown 写进 `input/converted/`(落点复用 `layout.py`);已有参考目录只读。
      URL 模式不写 `visualization/`,看板也不得 spawn 带 URL 的调用

   **第六条 · 产出物记录的状态变更**(写 `output/records/I<编号>.md`,`records.mjs` 的 `writeRecordStatus`,直写):
   ① 只**改已存在**的记录,不新建、不删除、不改名,不存在 404(建记录是 `pm-output-record` 的活);
   ② 只写人写区(`status` / `resolved_by` / `status_changed` 与「## 状态流水」,只追加 `###` 子节);
      载荷带 AI 写区(`target` / `updated`)或建立时写定的字段(`id` / `kind` / `title` / `created`)一律 400;
   ③ 用户点「保存」发起; ④ 环回且非跨站;
   ⑤ 请求**只带编号**(`I0007`),路径服务端过 `resolveInside()` 自己拼;
   ⑥ 产出物本身与其余 `output/` `input/` `project.yaml` `visualization/` 只读 —— 记录是旁挂元数据。
   状态值必须属于该 `kind` 的状态机(`src/shared/recordStatus.mjs`);终态(`absorbed` / `superseded` /
   `overturned`)必须带 `resolved_by`;补充说明为空 400。

   **第六条的第二种写入 · 批注**(写 `output/records/notes/I<编号>.md`,`notes.mjs` 的 `appendNotes`,不是第七条):
   与上面同形,但**允许新建,只此一款**:可新建 `notes/I<四位编号>.md`,前提是同编号记录已存在(否则 404,
   不顺手建记录);不推广到 `notes/` 以外。其余:
   ① 只写上述路径; ② 只追加新条目,不改已有条目及其 `- 状态：` `- 回执：`(那两行归 agent);
   ③ 用户点「复制提示词」发起; ④ 环回且非跨站;
   ⑤ 请求只带编号与批注内容,不接受路径; ⑥ 原子写;单条 ≤1000 字、单批 ≤50 条,超限整批 400;看板写入状态只能是 `pending`。
   交付稿 `output/delivery/<组>/<子路径>/v<序号>.md` 上的批注按**镜像路径**还原成原稿 `output/<组>/<子路径>.md`,
   落到原稿那份记录的批注文件,批次多一行 `- 对象：`;映射只用路径规则,不读交付稿 front-matter。

   **第七条 · 一次归档**(spawn `scripts/archive_output.py`,`http.mjs` 的 `runArchive`,同步等退出、带超时):
   归档是 `rename`,而第六条 ① 写死「不改名」,所以看板自己绝不做。
   ① 看板只 spawn; ② 用户在产出列表点「归档」并确认,**不按状态自动归档**; ③ 环回且非跨站;
   ④ 请求**只带组名(`analysis` / `docs` / `decisions`)与文件基名,不接受任何路径**,含分隔符或 `..` 在起脚本前 400。
      代价是组内子目录的文件不可归档(界面置灰);不要改成「带路径但会校验」—— 这句话没有例外才有价值;
   ⑤ 脚本只写 `output/<组>/一次归档/`(移入文件、维护同目录 `README.md`);
   ⑥ 脚本只移动与在清单标记间追加 README,不删除;同名加日期后缀不覆盖;脚本不存在时 400,不退化成看板代劳。
   「是否已归档」判据只在 `scan.mjs` 的 `outputPlacement`;归档项照样扫描、搜索、预览、计入反链。
   二次归档走工作空间的 `pm-output-archive`,看板不参与,也**不产出任何「无需再读」清单**。

   **第八条 · 反馈单发送记录**(写 `output/feedback/F<编号>.md`,`feedback.mjs` 的 `markSent`,直写):
   ① 只**改已存在**的反馈单,不新建、不删除、不改名,不存在 404;
   ② 只写人写区:front-matter 的 `sent_at` 与「## 发送记录」(只追加 `###` 子节);
      载荷带 AI 写区(`status` / `receipt` / `title` / `kind` / `id` / `created` 等)一律 400;
   ③ 用户点「已发送」发起,唤起 mailto 本身不写盘; ④ 环回且非跨站;
   ⑤ 请求**只带编号**(`F0003`),路径服务端过 `resolveInside()` 自己拼;
   ⑥ 其余文件(含 `.kanban-feedback/`、`output/docx-template/`)只读;结构认不出(无 front-matter 或无「## 发送记录」)409

   **第九条 · 提炼 Word 模板 / 转 Word**(spawn `scripts/docx_template.py` / `scripts/md2docx.py`,
   `docxTools.mjs`,同步等退出、带超时):
   ① 看板只 spawn; ② 用户点「开始分析」「生成模板」「转换」发起,文件变化不自动重跑; ③ 环回且非跨站;
   ④ **请求不带任何路径**:来源 `.docx` 与待转 `.md`(产出三组与交付稿 `output/delivery/**/v<序号>.md`)只用扫描下发的
      不透明键 `docKey`(相对路径 SHA-256 前 16 位)指定,服务端重扫反查、查不到 400,再过 `resolveInside()`;
      不接受「带路径但会校验」,也不退回「组名 + 基名」(子目录里基名不唯一)。
      模板名只接受一层基名;提炼决定经 stdin 传 JSON,服务端限 256KB、拒路径类键名,脚本再校验;
   ⑤ `docx_template.py` 只写 `output/docx-template/<模板名>/`(`collect/` `profile.json` `reference.docx`
      `front.docx` `spec.md` `sample.docx`);`md2docx.py` 只写来源 `.md` 同目录同基名的 `.docx`
      (来源是交付稿时落在交付稿旁,原稿目录不动;中间文件放系统临时目录;`.md` 一个字节不改),
      外加「重新转换」时把同名的上一份成品**改名**为 `<基名>-<上次转换时间>.docx`(同目录,不删不覆盖);
      转换时间记在成品自己的 `docProps/custom.xml`(`aispace-docx-converted`),不写进 `.md`;
   ⑥ **不覆盖别人的文件**:同名 `.docx` 只有带生成标记(`docProps/custom.xml` 的 `aispace-docx-generator`)
      才归档改名(界面)或替换(`overwrite`,只留给旧前端与命令行),否则 409;脚本不支持归档时 400,看板不代为改名;
      模板名已存在要用户确认「重新生成」。服务端与脚本各校验一次;
      缺脚本 / Python 3 / pandoc 3 时 400 说清出路,不退化成看板代劳。

   **去 AI 味这条线不新增任何写入**(`deai.mjs` 只读):交付稿与规则库 `.claude/skills/pm-deai-writing/rules/`
   全由工作空间 AI 写;改交付稿走「批注 → AI 修改」,看板唯一的写入是第六条第二种写入的批注。

2. **一切工作空间内路径必须过 `resolveInside(root, relPath)`**(`src/server/paths.mjs`),挡 `../` 穿越。
   新增接收路径参数的接口第一件事就是过它。**只此一份**,不许复制第二份实现。
3. **"移出看板"只删登记信息**,不动本地目录和文件。文案与实现都必须保持这个承诺。
4. **非环回监听时禁写。** `--host` 不是环回地址时,所有会起子进程 / 写盘的接口一律 403
   (`createServer({ allowMutations })`,`bin/cli.mjs` 按 `LOOPBACK` 传入)。只读分享不受影响。

---

## 2. 技术栈

- **React 19** + **TypeScript**(`strict`,`noUnusedLocals` / `noUnusedParameters`,bundler 解析)
- **Vite 7**;**Tailwind CSS v4**(`@tailwindcss/vite`,**无 `tailwind.config.js`**)
- **服务端:瘦 Node**(原生 `node:http`,**无框架**),`.mjs`,**不参与类型检查**
- **UI 组件:[startist-ui](../startist-ui)** 经 shadcn registry copy-in 到 `src/app/components/ui/`
- 包管理器 **pnpm**;**无 ESLint、无测试框架**(闸门见第 4 节)

服务端用的新依赖必须进 `dependencies`(`bin/` 被当 CLI 直接跑,拿不到 devDependencies);
`scripts/build-npm-package.mjs` 按 `src/server` + `bin` 的 import 图重算依赖,漏了会直接报错。

**唯一的第三方补丁** `patches/micromark-extension-gfm-table@2.1.1.patch`(登记在 `pnpm-workspace.yaml`,
那份文件只为它存在):给 `EditMap.add` 加 `at → change` 索引,把大表格解析从平方级降下来
(833 行表格管线 146ms → 74ms),输出 HTML 逐字节不变。升级 `remark-gfm` / micromark 时补丁失效会当场报错,
那时重打(`pnpm patch <包>@<新版本>`)或确认上游已修后删掉;验证跑 `pnpm test:anchor` + 浏览器点开大表看长任务。

---

## 3. 三个平面与目录结构

```
aispace-kanban/
├── bin/cli.mjs             # 平面 1 · CLI:参数解析 + serve/add/list/relink/remove
├── src/
│   ├── server/             # 平面 2 · 常驻服务(.mjs,无类型检查)
│   │   ├── http.mjs        #   路由 + 静态伺服 + SSE + 各 spawn 入口
│   │   ├── config.mjs      #   注册表读写 + 工作空间识别 + 重连候选 + 模板根解析
│   │   ├── scan.mjs        #   工作空间扫描 → JSON(只读);归档判据 outputPlacement
│   │   ├── meta.mjs        #   project.yaml 解析 + 完整度
│   │   ├── frontmatter.mjs #   frontmatter / 标题 / 字数
│   │   ├── records.mjs     #   产出物记录索引 + 状态写入(第六条)
│   │   ├── notes.mjs       #   批注读写(第六条第二种写入)
│   │   ├── feedback.mjs    #   反馈单索引 + 发送记录写入(第八条)
│   │   ├── questions.mjs   #   未决问题索引 + 人工反馈写入(第四条)
│   │   ├── docxTemplates.mjs / docxTools.mjs / docxMarker.mjs  # Word 模板清单 / spawn(第九条) / 生成标记
│   │   ├── deai.mjs        #   去 AI 味:读规则库、列交付稿版本(只读)
│   │   ├── patchMarkdown.mjs # 问题 / 记录 / 反馈单共用的字段级替换与原子写
│   │   ├── prototypes.mjs / references.mjs  # visualization/ 两个 tab 的清单
│   │   ├── capture.mjs     #   ★ 采集写入的唯一收口(第二条)
│   │   ├── paths.mjs       #   ★ resolveInside 的唯一实现(不变量 2)
│   │   └── platform.mjs    #   ★ 三平台差异只写在这
│   ├── app/                # 平面 3 · 前端 SPA(TS,`@/` 指向这里)
│   │   ├── components/     #   业务面板(*Panel.tsx)、阅读器、通用小件;ui/ 是 startist vendored 快照
│   │   ├── hooks/          #   useProjects / useScan(含 SSE 订阅)
│   │   ├── lib/api.ts      #   ★ 前后端契约:接口封装 + 全部响应类型
│   │   └── styles/globals.css  # ★ 设计令牌唯一源头
│   └── shared/             # 平面 2 与 3 共用的**纯函数**(.mjs + JSDoc)
├── scripts/                # 仓库工具:组 npm 包、装包冒烟(CI 三平台跑它)、各回归
├── openspec/               # 规划产物;config.yaml 是写产物的约束,自动注入给 AI
├── .github/workflows/      # ci.yml(日常闸门) + release.yml(推 v* tag 发版)
├── templates/              # 工作空间模板,看板代码不 import 它们
│   ├── init_workspace.py   #   ★ 共享铺骨架入口(runInit --from)
│   └── pm-aispace/         #   内置「产品经理AI空间模板」,自带 AGENTS.md
└── dist/                   # 构建产物(gitignore),serve 非 dev 模式伺服它
```

**看板与 `templates/` 只有一个接口**:`runInit` spawn `templates/init_workspace.py --from <模板>`。
内置模板根由 `config.mjs` 的 `resolveTemplateRoot` 解析(注册表 `templateRoot` > `PMWORK_TEMPLATE_ROOT` > 仓库内 `templates/`);
用户自建模板扫 `~/.pmwork/templates/`,有 `template.yaml` 即上架。

**单页 HTML 产物**(方案页、设计页、分析页)落 `templates/pm-aispace/visualization/prototypes/<名字>/index.html`,
规则同模板 AGENTS.md「阶段四：视觉呈现」。这个目录**随模板发给每个新工作空间**,别放临时草稿。

**平面职责互斥:**

| 需求 | 落在哪 |
| --- | --- |
| 命令行参数 / 进程生命周期 / 启动输出 | `bin/cli.mjs` |
| 读磁盘、算数据、给 JSON、伺服文件 | `src/server/**` |
| 渲染、交互、状态 | `src/app/**` |
| 服务端与前端**必须给出同一个答案**的纯计算 | `src/shared/**` |

- **跨平面的唯一契约是 `src/app/lib/api.ts`**:改一侧必改另一侧,见 [`dashboard-feature-flow`](.claude/skills/dashboard-feature-flow/SKILL.md)。
- **`src/shared/` 只放两侧共用的纯函数**:不碰 DOM / Node API、零依赖,`.mjs` + JSDoc(`allowJs`、不开 `checkJs`)。
  加文件前先问「两边真的必须同源吗」。
- **`src/server/` 或 `src/shared/` 新增文件,同步 `scripts/build-npm-package.mjs` 的拷贝清单**,否则装包即 `ERR_MODULE_NOT_FOUND`。

---

## 4. 常用命令与验证闸

| 目的 | 命令 |
| --- | --- |
| 安装依赖 | `pnpm install` |
| 开发(接口 7788 + Vite 5180,浏览器开 5180) | `pnpm dev` |
| 只起常驻服务(7788,伺服 `dist/`) | `pnpm serve` |
| 构建 / 类型检查 | `pnpm build` / `pnpm typecheck` |
| 组 npm 包 / 打包冒烟 | `pnpm build:npm` / `pnpm pack:npm && pnpm smoke:npm` |
| docx 工具链回归(改 `templates/pm-aispace/scripts/docxkit/` 必跑;仅本地,没 pandoc 3 时跳过转换段) | `pnpm test:docx` |
| 模板铺设与更新回归(改 `init_workspace.py`、`template_update.py` 或模板 `sync` 段必跑) | `pnpm test:template-update` |
| 规划状态 | `openspec list` / `openspec list --specs` |

**交付闸门(缺一不可):**

1. `pnpm typecheck` 绿 —— 它**只覆盖 `src/app`**
2. `pnpm build` 绿
3. **手动冒烟**:`src/server/**` 与 `bin/cli.mjs` 没有静态检查也没有测试,改了必须重启 `pnpm serve` / `pnpm dev`,
   `curl -s localhost:7788/api/health`,再在浏览器把受影响视图点一遍。

> **常驻服务不热更。** 「`未知接口：/api/...`」几乎总是忘了重启,不是路由写错。

没有自动化测试;新增无 IO 的纯逻辑模块可以补,别为现有代码大规模补测试 —— 先问人。

---

## 5. 编码规范总则

### 5.1 通用

- **改动最小化**:只动非动不可的地方,不做没要求的抽象。详见 [`disciplined-coding`](.claude/skills/disciplined-coding/SKILL.md)。
- **注释写"为什么"**,尤其是反直觉的兜底与降级;不写重述代码的注释。
- **中文优先**:注释、界面文案、报错、提交信息一律中文,平实、说清后果,不说"操作失败请重试"。
- **提交**小步可回滚,信息说明「为什么」。

### 5.2 前端平面(`src/app/**`)

- 路径别名 **`@/` → `src/app/`**,不写 `../../`。
- 不用 `any` 兜底(唯一例外 `ProjectMeta.data`,不要再加)。
- 函数组件 + Hooks;一文件一主组件,文件名同组件名(`PascalCase`);hooks `useXxx`;工具函数 `camelCase`。
- 样式只用 Tailwind 工具类 + 语义令牌,`cn()` 合并。详见 [`react-component-authoring`](.claude/skills/react-component-authoring/SKILL.md)。
- 通用组件先查 startist registry;`components/ui/**` 是 vendored 快照,**不做与上游分叉的语义修改**。

### 5.3 服务端平面(`src/server/**`、`bin/cli.mjs`)

- 原生 ESM `.mjs`,不引 TypeScript、不引 Web 框架,类型靠 JSDoc。
- 依赖克制:`node:` 内置 + 已有轻量包(`yaml`、`@firecrawl/anydoc`);加依赖要讲清理由。
- 错误 `throw new Error(中文说明)` + 可选 `err.statusCode`,由 `createServer` 统一转 JSON。
- **读失败降级成空/默认值,不让进程崩**(参考 `config.mjs` 的 `readProjects`)。
- 扫描新目录沿用 `scan.mjs` 的 `SKIP` 集合与 `rel()`(统一 `/` 分隔)。

### 5.4 视觉与配色(硬约束)

- **令牌唯一源头 `src/app/styles/globals.css`**;组件里不硬编码色值,不用 `zinc-*` / `stone-*` 原始色阶。
- **黑白灰为主。orange(`--destructive`)只用于"需要注意"**(待转换资料、内容存疑、目录丢失)。
- 层级靠边框和灰底,不靠阴影。详见 [`design-tokens`](.claude/skills/design-tokens/SKILL.md)。

### 5.5 兼容性(常驻服务特有,最容易踩)

用户完全可能用着旧进程 + 新前端(或反过来):

- **接口新增字段一律可选**,前端缺字段时**退回改动前的行为**,宁可少显示不白屏(实例:`Scan.available?`)。
- 服务端不删已有字段(先加新的,旧的留一版)。

### 5.6 三平台与 npm 包

发成 `@startist/aispace-kanban`,macOS / Windows / Linux 都要能跑,**Node ≥ 20**(Linux 递归 `fs.watch`)。

- **平台差异只写在 `platform.mjs`**(开浏览器、定位文件、找 Python / pandoc),别处不许再写 `spawn('open', ...)`。
- 与操作系统有关的文案(「在访达中显示」)取 `/api/health` 的 `platform`(经 `hooks/useFileManager.ts`),
  **不用 `navigator`** —— 动作发生在服务所在机器上。
- **npm 打包会吃掉** `.gitignore`(组包改名 `gitignore`,`init_workspace.py` 认回)和软链接
  (`templates/<id>/skills` 不进包,建工作空间时现建相对链接,Windows 不行就复制)。
- 包里没有前端源码和 devDependencies(`serve --dev` 会明确报错);`dist/` 必须是刚 build 的。
- 发布前冒烟跑 `pnpm smoke:npm`(干净目录装 tgz、假 `HOME`,验新建、扫描、穿越拦截等),CI 三平台跑的就是它。
  发版流程见 `docs/private/发布与CI.md`(私有,不入库)。

---

## 6. 协作流水线:OpenSpec(规划 → 实施 → 归档)

**非平凡改动先规划再动手**:跨平面、动 `api.ts` 契约、引新依赖、要在几条路之间取舍的,先立 change。

```
/opsx:propose "<想做什么>"   → openspec/changes/<name>/ 下生成 proposal / specs / design / tasks
/opsx:apply <name>           → 按 tasks.md 逐条实现并勾选
/opsx:archive <name>         → 归档,delta 合并回 openspec/specs/
```

- **琐碎改动直接做**(文案、间距、笔误)。bug 走 [`systematic-debugging`](.claude/skills/systematic-debugging/SKILL.md),
  大到要改数据形状或跨平面才立 change。
- OpenSpec 定「做什么」,skills 定「怎么改不出事」,两者叠加:立完 change 照样按 `dashboard-feature-flow` 改。
- **产物写法约束只写在 [`openspec/config.yaml`](openspec/config.yaml)**(中文、平面影响面、只读红线、验收闸、脱敏),自动注入给 AI。
- `/opsx:*` 丢了跑 `openspec init --tools claude,pi` 重建(**不是** `openspec update`)。
  生成的 `.claude/commands/opsx/`、`.claude/skills/openspec-*/`、`.pi/prompts/` 入库但勿手改。

### 6.1 公开仓库脱敏红线

本仓已开源(`github.com/STArtppt/aispace-kanban`),**`openspec/` 随代码公开,进了 git 历史就删不干净**。
真实客户与业务方名称(含文件名里的)、本机绝对路径、内网地址与内部 Git 远端、凭据、真实资料正文与截图,
一律不进产物,要举证就化名或换合成件。最容易破防的是 `design.md` 的「现状」—— **拿不准就不写**。
完整清单在 `openspec/config.yaml` 的 `context`,改规则改那里。

### 6.2 处理工作空间反馈单

工作空间 agent **不许改看板源码**,发现问题写 `output/feedback/F<编号>.md`
(字段契约见模板 `output/feedback/README.md`),由用户发来或带来。
`~/.pmwork/dashboard/runtime.json` 的 `launch` 为 `source` 时,直接读 `instances` 所列实例的反馈单,
做法见 [`local-source-sync`](.claude/skills/local-source-sync/SKILL.md);否则等用户带过来。
旧目录 `.kanban-feedback/` 看板只数份数,不读、不动。

**缺陷单**(`kind: bug` 或不写):

1. 当作需求输入走本仓流程(要不要立 change → `dashboard-feature-flow` → 第 4 节闸门 → 提交);「建议改法」只作参考。
2. 进本仓前先按 6.1 脱敏,别默认复现已经是合成的。
3. 给一段可转发的**回执**:结论、提交号(不修写理由)、那边可撤掉的临时绕法。

**贡献单**(`kind: contribution`)是工作空间沉淀出的通用改进,当作对 `templates/pm-aispace/` 的需求:

1. 按 6.1 复查「合成示例」「改动内容」,带真实资料的改成合成件,拿不准不收;
2. 判据「换一个项目还成立吗」,只对个别行业 / 客户成立的不收;
3. 规则类写进模板规则库 `.claude/skills/pm-deai-writing/rules/` 下一版(取下一个空号、按「短名 + 判据」判重,
   版本、快照、CHANGELOG 按该技能「规则库怎么改」),其它类改对应模板文件;
4. 过第 4 节闸门(动 docxkit 跑 `test:docx`,动铺设 / 更新脚本跑 `test:template-update`),提交;
5. 回执写结论 + 模板位置 + 提交号,如「收为模板 R012(规则库 v2),提交 abc1234」。

**本会话不写工作空间文件**,回执由用户转给那边的 agent 回写。唯一例外:`launch` 为 `source` 且用户确认计划后,
运行该实例自己的 `scripts/template_update.py apply --plan <计划文件>`;不跑 `apply --resolved`,
冲突与 seedOnly 交回工作空间。不变量 1 不因此新增条目。

工作空间的 `.claude/settings.local.json` 由 `init_workspace.py` 写入 `deny`,禁止改本仓任何文件(含 `templates/`);
老工作空间用 `python3 templates/init_workspace.py --guard-only --path <工作空间>` 补。
**本仓新增顶层目录或文件后**,提醒用户对在用的工作空间重跑一次。它只拦 Claude Code 的写工具,主防线仍是规则本身。

---

## 7. Skills 体系:工程平面

技能约束「Agent 怎么改这个看板」,位置 **`.claude/skills/<name>/SKILL.md`**,只此一份(无 `.agents/` 镜像)。
来源与分层见 [`.claude/skills/README.md`](.claude/skills/README.md)(同一件事以本地为准)。缺失或过时就顺手补全。

| 技能 | 什么时候读 |
| --- | --- |
| [`dashboard-feature-flow`](.claude/skills/dashboard-feature-flow/SKILL.md) | **加/改任何功能时先读** —— 跨平面顺序与契约清单 |
| [`project-conventions`](.claude/skills/project-conventions/SKILL.md) | 新建文件、不确定放哪 / 叫什么、提交前 |
| [`disciplined-coding`](.claude/skills/disciplined-coding/SKILL.md) | 写第一行代码前 |
| [`react-component-authoring`](.claude/skills/react-component-authoring/SKILL.md) | 新建或重构 React 组件 |
| [`design-tokens`](.claude/skills/design-tokens/SKILL.md) | 动颜色 / 字体 / 间距 / 主题 |
| [`design-system-loop`](.claude/skills/design-system-loop/SKILL.md) | 从 startist-ui 拉 / 升级组件、缺口回流真源 |
| [`systematic-debugging`](.claude/skills/systematic-debugging/SKILL.md) | 查 bug、构建报错、行为不符预期 |
| [`verification-before-completion`](.claude/skills/verification-before-completion/SKILL.md) | 准备说「做完了」之前 |
| [`local-source-sync`](.claude/skills/local-source-sync/SKILL.md) | 源码启动时同步模板到实例、读实例反馈单 |

---

## 8. 给 Agent 的协作守则

1. **先定平面再动手**,跨平面按 `dashboard-feature-flow` 的顺序走;要改数据形状先对齐 `api.ts`。
2. **只读红线不碰**:任何往工作空间写的想法,先停下来问人。
3. **改完必验**:第 4 节三道闸都过了再说完成。
4. **沉淀而非一次性**:踩过的坑补进对应 skill(尤其 `systematic-debugging` 的分诊表)。
5. **事实源唯一**:协作约定只写本文件,规划产物约束只写 `openspec/config.yaml`,不复制到别处。
