# docxkit —— docx 工具链的公共代码（写给维护者）

工作空间 AI 和 PM 用的是两个入口脚本（`scripts/docx_template.py`、`scripts/md2docx.py`）和每个模板目录里的 `spec.md`，
不需要读这份。这份写给要改工具链的人。

只依赖 Python 3 标准库；md → docx 另需 pandoc 3。不引 python-docx / PyYAML：
工作空间只保证有 Python 3，python-docx 也读不到 `w:eastAsia` 字体、表格样式层叠这些关键信息，最后还是要直接操作 XML。

## 流水线

```
客户旧 docx ─collect─▶ collect/report.json ─(人的决定)─▶ build ─▶ profile.json + reference.docx + spec.md
                                                               └▶ sample.md 转 sample.docx ─collect─▶ 反查 warnings
项目 .md ───────────────────────────────── md2docx（pandoc + reference.docx + 后处理）─▶ 同目录同名 .docx
```

## 模块

| 文件 | 职责 |
| --- | --- |
| `__init__.py` | 版本号 `VERSION`（写进生成标记与结果 JSON）、退出码、UTF-8、结果输出 |
| `ooxml.py` | 命名空间、zip 读写（`Package`）、原子写、生成标记（`docProps/custom.xml` 的 `aispace-docx-generator`） |
| `collect.py` | 采集：逐段算实际生效格式、聚类、大纲、表格、分节、页眉页脚、建议角色；报告脱敏。也是反查的底子 |
| `spec.py` | 通用规范与 profile 的合并、「某角色最终长什么样」（`effective`），角色清单 `ROLES` |
| `decisions.py` | 决定 JSON 的校验（拒绝路径类字段）、按角色汇总冲突、合成 `profile.json`（每项 `_src`） |
| `build.py` | 清洗 + 按规范重建样式 + 标题多级编号 + 萃取 reference.docx |
| `spec_md.py` | 由合并后的规范生成 `spec.md` |
| `pandoc.py` | 找 pandoc（`PANDOC_BIN` → `.env` → `PATH`，≥ 3）、取默认参照模板、调用转换 |
| `postprocess.py` | pandoc 之后的确定性修补：生成标记、表头跨页重复、题注 SEQ 域 |
| `verify.py` | 用采集器反查样张 / 成品，逐角色比对规范 |
| `base-spec.json` | **通用内容规范**：样式清单的唯一真源 |
| `sample.md` + `diagram.png` | 覆盖所有元素的合成样张（内容全是虚构的） |

跨仓的口径（改一边要改另一边）：

- 报告的键名 → 看板 `src/app/lib/api.ts` 的 `DocxCollectReport`；
- `ROLES` → 看板 `src/app/components/templateRefine/roles.ts`；
- `decisions.plan` 的冲突计算 → 看板 `src/app/components/templateRefine/plan.ts`（第 ③ 步要实时显示）；
- 退出码 → 看板 `src/server/docxTools.mjs`；pandoc 查找顺序 → 看板 `src/server/platform.mjs` 的 `findPandoc`。

## 样式层叠规则

Word 的生效格式层叠（从低到高）：

1. `docDefaults`（`rPrDefault` / `pPrDefault`）
2. 表格样式（含 `firstRow` 条件格式）—— 只对表格内段落
3. 段落样式链（`basedOn` 从根到叶）
4. 字符样式链（run 的 `rStyle`）
5. 段落 / run 上的手动格式

由此得出规范的写法：**字体、字号、行距写在 docDefaults，`Normal` 保持为空，`Compact` 不设字号**。
pandoc 的表格单元格和紧凑列表共用 `Compact`，这样表格样式里的 10.5pt、单倍行距才压得过正文的 14pt、1.5 倍。
派生 profile 时，映射到「正文」的字体、字号、倍数行距进 `doc_defaults`，不写在 Body Text 上。

角色映射到样式名用 pandoc 认识的名字（`Body Text`、`First Paragraph`、`Compact`、`heading 1`–`heading 4`、
`Table Caption`、`Image Caption`、`Source Code`、`Block Text`、`footnote reference` 等）；自定义的只有「提示框」
（md 写法 `::: {custom-style="提示框"}`）。客户原文没有的角色由 `base-spec.json` 补齐，`spec.md` 里逐条标出。

## 踩过的坑（都已修，改代码时别丢）

1. **`w:beforeLines` 优先于 `w:before`**：只要写了 `beforeLines="0"`，`before` 设的段前段后就全部失效。
   规范从不写 `*Lines`；采集时上层只写了 `before` 就丢掉下层继承来的 `beforeLines`（`collect.merge_p`）。
2. **主题字体**：run 上显式写的字体会压过继承来的 `asciiTheme` / `eastAsiaTheme`。计算生效格式时下层的主题属性要丢掉，
   否则会误报成 Calibri 或宋体（`collect.merge_r`）。
3. **表格字号**：见上面的层叠规则。字体字号放错层，表格就吃正文字号。
4. **沿用原样式 id**：客户文档里已有同名样式时沿用它的 styleId（中文 Word 里 heading 1 的 id 常是 `1`，Normal 是 `a`），
   否则页眉页脚、目录对它的引用会断（`build.build_reference` 第 2 步）。
5. **`ET.tostring` 会改写命名空间前缀**：在它的输出上字符串匹配 `w:instrText`、`wp:inline` 会全部落空；
   而且它会丢掉没用到的命名空间声明，`mc:Ignorable` 引用的前缀没声明时 Word 拒绝打开。
   所以**读**用 ET 遍历元素，**改**在原始 XML 字符串上做局部替换。
6. pandoc 输出的标签是 `<w:pStyle w:val="x" />`（`/>` 前有空格），Word 的是 `"x"/>`：正则两种都要认。
7. pandoc 自带的 reference.docx 没有 `sectPr`：「通用规范」以它为底时由 `base-spec.json` 的 `page` 补上 A4 页面。
8. 在 zsh 里 `ls` 带匹配不到的通配符会中止整条命令，检查软件装没装时别这么写。

## 客户样例 A 的结论（已脱敏，原型阶段）

- 179 个样式里只有 19 个有效，编号定义 43 套里只用了 1 套。清洗后剩 32 个样式、1 套编号。
- 标题用的是 heading 1–3，大纲级别可靠、编号挂在样式上；但样式定义写 22/16/14pt，实际全部 14pt ——
  **样式定义不能信，必须采集实际生效格式**，这也是采集必须排在清洗之前的原因。
- 正文 100% 是手动格式；有两种行距（单倍 57 段、1.5 倍 33 段）、三种表格边框。
- LibreOffice 渲染样张：标题编号、表格边框、表头加粗、题注、代码块底色、提示框、脚注、客户页眉页脚都正确。

## 已知缺口

- **封面**：客户封面常用浮动文本框，要整节原样搬成 `cover.docx`，作为受保护区域；本期不做。
- **表格列宽**：pandoc 平均分配，没有按内容比例调整。
- **域不刷新**：目录、页码、SEQ 编号需要在 Word 里全选后按 F9；工具链不依赖 LibreOffice，也不替你刷新。
- **字体**：预览机缺仿宋_GB2312 这类字体时会回退；样张格式对不对以反查为准，不以预览观感为准。

## 改完怎么验

在有 pandoc 3 的机器上跑看板仓的 `pnpm test:docx`（语料在 `fixtures/docx-template/`）。
改了生成逻辑（样式、后处理）就把 `__init__.py` 的 `VERSION` 升一位。
