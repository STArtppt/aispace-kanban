## 0. 前置

- [x] 0.1 确认 `workbench-module-hub` 已归档（`openspec/specs/` 下有 `docx-template-refine`、`workbench-module-hub`），否则先归档它，再开始本 change
- [x] 0.2 确认 proposal「写入工作空间」一段的三件事已被拍板：第九条边界、上传本期不做、pandoc 作为系统依赖

## 1. 规则先行

- [x] 1.1 `AGENTS.md` 不变量 1 新增第九条窄例外（照 proposal 六款写，注明属于 spawn 一族，以及不收路径、改用 `docKey` 的理由）；第 3 节目录表补 `docxTools.mjs`，并在 `templates/pm-aispace/scripts/` 一行里补上看板会 spawn 的两个脚本
- [x] 1.2 `CLAUDE.md` 不用改（它只指向 AGENTS.md），复核一遍

## 2. 工作空间工具链（templates/pm-aispace/scripts/）

- [x] 2.1 建 `scripts/docxkit/`：把 spike 的 `collect.py` 拆成 `collect.py`（采集 + 脱敏报告），`build_template.py` 拆成 `build.py`（清洗 + 重建样式 + 编号 + 萃取），公共的 OOXML 读写放 `ooxml.py`；保住 design「踩过的坑」里列的五点
- [x] 2.2 `docxkit/base-spec.json`：从 spike 迁入，补 `footnote reference`；`docxkit/sample.md` 与一张合成图片作为样张
- [x] 2.3 `docxkit/decisions.py`：校验决定 JSON 的结构（拒绝路径类字段），与采集报告合成 `profile.json`（每项 `_src`）
- [x] 2.4 `docxkit/spec_md.py`：由合并后的规范生成 `spec.md`（标题层级与 `#` 的对应、正文、列表、表格、代码块、题注、提示框写法；标出「由通用规范补齐」的角色）
- [x] 2.5 `docxkit/postprocess.py`：生成标记（`docProps/custom.xml`，同时补 `[Content_Types].xml` 与关系）、表头跨页重复、题注手写编号 → SEQ 域、`title` → `Title` 首段；不改正文文字
- [x] 2.6 `docxkit/pandoc.py`：按 `PANDOC_BIN` → `.env` → `PATH` 查找，校验版本 ≥ 3；调用时以 `.md` 所在目录为 `--resource-path`，中间文件放系统临时目录
- [x] 2.7 入口 `scripts/docx_template.py`（`collect` / `build`，`--json`，`--decisions <文件>` 或 stdin，`--regenerate`）：只写 `output/docx-template/<模板名>/`；重名且没有 `--regenerate` 时退出码非 0；build 末尾转样张并反查，结果里给 `warnings`；没有 pandoc 时跳过样张
- [x] 2.8 入口 `scripts/md2docx.py <md> --template <名|@base> [--overwrite] --json`：`@base` 时在临时目录用通用规范现生成参照模板；同名文件只有带生成标记且加了 `--overwrite` 才能覆盖，否则退出码非 0；原子替换；缺失图片写 warning
- [x] 2.9 三个入口启动时强制 stdout、stderr 使用 UTF-8；`--json` 最后一行是结果，其中包括 `toolVersion`
- [x] 2.10 `docxkit/README.md`（写给维护者）：模块划分、样式层叠规则、踩坑清单（从 spike README 迁来）
- [x] 2.11 在终端里用合成语料手动跑通三个入口，覆盖有 pandoc 和没有 pandoc 两种情况

## 3. 合成回归语料与测试

- [x] 3.1 `fixtures/docx-template/make_messy_docx.py`：用标准库生成合成「旧文档」（大量无效样式、手动格式、样式定义与实际不符、伪标题、手写编号、两种行距、三种表格边框、页眉页脚），加一份 README 说明用途
- [x] 3.2 `scripts/check-docx.mjs`：在临时目录里跑 生成语料 → collect → build（带一份固定的决定 JSON）→ md2docx → collect 反查；断言关键角色格式、报告里不含语料正文、生成标记存在、无标记同名文件拒绝覆盖；没有 pandoc 时跳过转换并说明
- [x] 3.3 `package.json` 加 `test:docx`；看一眼 `.github/workflows/ci.yml`，决定是否在 CI 里装 pandoc 跑它（不装就在 README 的验证一节注明「仅本地」）
- [x] 3.4 确认 `pnpm build:npm` 组包时 `templates/pm-aispace/scripts/docxkit/` 被完整带上（`npm-package/` 里检查）

## 4. 服务端

- [x] 4.1 `scan.mjs`：给产出三组里的 `.md`、`input/raw/` 里的 `.docx` 加可选字段 `docKey`（相对路径 SHA-256 前 16 位）；提供按 `docKey` 反查的函数，只在对应的那一类条目里查
- [x] 4.2 `platform.mjs`：加 `findPandoc()`（与脚本同一查找顺序，读工作空间 `.env` 只取 `PANDOC_BIN` 一个键）；`/api/health` 加可选字段 `docxTools`
- [x] 4.3 新建 `src/server/docxTools.mjs`：模板名基名校验、决定 JSON 大小与键名检查、按模板名 / 目标文件的进行中集合（冲突 409）、spawn + 超时 + 解析最后一行 JSON、把脚本退出码映射成 400 / 409 / 500 的中文信息
- [x] 4.4 `http.mjs` 路由：`POST docx-templates/:name/collect`、`POST docx-templates/:name/build`、`POST docx/convert`，全部挂 `allowMutations` + `rejectIfForeignOrigin`；脚本缺失、Python 或 pandoc 缺失时 400 并说清出路
- [x] 4.5 `docxTemplates.mjs`：列表补 `collect` / `sample.docx` 的存在与 mtime，以及 `generated`（有没有 `reference.docx`）；详情补 `collect/report.json`
- [x] 4.6 `MIME` 补 `.docx`
- [x] 4.7 **重启 `pnpm dev`**。在 scratchpad 里建合成工作空间（不入仓），用 `curl` 逐条验：`docKey` 下发与反查；非法模板名 400；带路径字段的决定 400；重名 409；无标记同名文件 409；并发同一目标 409；`--host 0.0.0.0` 时三个写接口 403；缺脚本、缺 pandoc 各自的 400；diff 确认只写了约定的路径

## 5. 契约：`src/app/lib/api.ts`

- [x] 5.1 `FileItem` 加 `docKey?`；`Health` 加 `docxTools?`；新增 `DocxCollectReport`、`DocxDecisions`、`DocxBuildResult`、`DocxConvertRequest`、`DocxConvertResult`；`DocxTemplateItem` / `DocxTemplateDetail` 补新增的可选字段
- [x] 5.2 `api` 加 `docxCollect`、`docxBuild`、`docxConvert`、`fileArrayBuffer`（二进制取文件）；404 统一识别为 `unsupported`

## 6. 前端：.docx 预览

- [x] 6.1 `pnpm add docx-preview`（进 `dependencies`），记录版本与体积
- [x] 6.2 新组件 `components/DocxView.tsx`：动态 import；渲染进 `sandbox="allow-same-origin"` 的 iframe；链接改成新窗口 + `noopener`；超过 30MB、解析失败、加载失败时退回「交给系统打开」卡片；底部常驻差异说明；纸张白色，外框用令牌
- [x] 6.3 `Reader.tsx`：`external` 且扩展名是 `.docx` 时走 `DocxView`（与 `isPdf` 同一处判断），保留「用系统应用打开」
- [x] 6.4 确认首屏包里没有 docx-preview（`pnpm build` 后看 chunk 清单）

## 7. 前端：产出「转成 Word」

- [x] 7.1 `OutputPanel.tsx`：`.md` 条目的更多菜单加「转成 Word」；缺 `docKey` 时置灰并说明原因
- [x] 7.2 新组件 `components/DocxExportDialog.tsx`：模板列表（`@base` 第一位，未生成的不可选），`localStorage` 记住上次的选择；目标文件已存在时的提示与「覆盖」勾选（按生成标记判断，文案写明会丢掉在 Word 里的修改）；「转换」/「复制提示词」；pandoc 缺失或非环回时「转换」置灰并说明
- [x] 7.3 提示词生成放在 `lib/docxPrompt.ts`：包括路径、模板、命令、同名规则、检查事项；脚本缺失时改为给出补齐脚本的说明
- [x] 7.4 成功后 toast「已生成 <文件名>」加「预览」按钮，打开阅读器；失败时原样显示服务端给的中文原因

## 8. 前端：模版洗炼接真实数据

- [x] 8.1 删除 `templateRefine/demoData.ts` 和示例模板；页顶的演示提示删掉；`WorkbenchHub.tsx` 的模版洗炼卡片改成显示已生成的模板数（中性灰）
- [x] 8.2 第 ① 步：只保留「从 `input/raw/` 选」（用 `docKey`）加模板名输入；重名提示与「重新生成」勾选；空态加「在访达中显示」
- [x] 8.3 第 ② 步：「开始分析」调用 `docxCollect`；格式簇表格接真实报告；「样式定义与实际不一致」的标注；映射、合并、丢弃
- [x] 8.4 第 ③ 步：大纲树接真实报告；伪标题的去向；冲突值二选一（默认段数多的，并显示两边的段数）
- [x] 8.5 第 ④ 步：生成前的文字规定预览（本地由决定推出）；「生成模板」调用 `docxBuild`；展示 `spec.md`、`warnings`，「预览样张」打开 `DocxView`
- [x] 8.6 列表：已生成 / 未生成两态；未生成的「继续」从第 ② 步接上；已生成的「预览样张」「重新提炼」
- [x] 8.7 降级：缺脚本时「复制提示词」；非环回时置灰；`unsupported` 时提示重启

## 9. templates 与文档

- [x] 9.1 改写 `templates/pm-aispace/output/docx-template/README.md`：六样文件的含义（更正 `reference.docx` 的含义）、谁写、不外传
- [x] 9.2 `templates/pm-aispace/AGENTS.md`：补「转 Word」「提炼模板」两节，说明工作空间 AI 拿到提示词后怎么执行、怎么检查，以及旧工作空间如何补齐脚本
- [x] 9.3 README 的产出视图和工作台说明补上：转成 Word、模版洗炼的真实流程、`.docx` 预览、pandoc 依赖
- [x] 9.4 删除 `spike-docx-template/`（先确认结论已迁到 `docxkit/README.md` 与本 design）；本地私有目录 `assets/private/docx-template/` 不动

## 10. 验收闸

- [x] 10.1 `pnpm typecheck` 绿
- [x] 10.2 `pnpm build` 绿
- [x] 10.3 `pnpm test:docx` 绿（有 pandoc 的机器上全程跑一遍）
- [x] 10.4 **重启 `pnpm dev`**，在合成工作空间里把整条链路点一遍：放一份合成旧 Word 进 `input/raw/` → 工作台四步 → 生成模板 → 预览样张 → 产出 `.md` 转成 Word（选新模板）→ 预览成品 → 再转一次并覆盖 → 复制提示词
- [ ] 10.5 用本地私有目录里的真实客户文档复验一次，结论只记在本地，不进仓库和产物
- [x] 10.6 三种情况各走一遍：没有 `project.yaml` 的工作空间、目录丢失（`available === false`）、深色模式（预览纸张仍是白色，外框跟随主题）
- [x] 10.7 旧服务配新前端：不重启服务，只换前端，确认「转成 Word」置灰、模版洗炼的写操作提示重启，页面不白屏
- [x] 10.8 在网络面板确认：预览 `.docx` 没有外部请求；「复制提示词」没有写请求
