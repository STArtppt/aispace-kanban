## Why

表格「数据」页每次只从服务端拉 50 行,预览窗内的检索也就只盖住这 50 行。
数据表动辄十几万行 —— 想确认"某个编号在不在这张表里"、"哪一行写了那个阈值",
现在只能一页页翻,或者退出看板去写 SQL。这一条在 `reader-content-search` 的「不做」里
明确挂着,而用户在第一次用检索时就撞上了它:搜不到不等于表里没有,这种"假阴性"
比没有搜索更坏。

## What Changes

- **新增服务端整表扫描接口** `GET /api/projects/:id/table-search`:沿用 `/table` 那套
  `readline` 流式逐行读,边读边判定,攒够上限就提前收流。全程只读,**不落任何索引文件**。
- **表格「数据」页与单份 csv/tsv 的检索改为整表**,不再只搜画出来的那一页。
  多表转换包里,范围是**当前选中的那张表**,不跨表。
- **整表检索的匹配语义是「同一行命中全部关键词」**,结果按**行号先后**排列,不做相关度排序。
  这与预览窗内 markdown 那套"命中词数越多越靠前、允许只中一部分"的模糊排序**不同**,
  是为了让扫描能在攒够结果时提前收流,不必为了排序读完整个文件 —— 取舍与备选见 design。
  关键词切分与归一(全半角、大小写、中英分词)两侧共用一份内核,不各写一套。
- **结果条目带行号**:显示"第 N 行"加该行的命中片段(命中词加粗,仍按 `{text, matched}[]`
  渲染,不走 `innerHTML`)。选中一条 → 自动翻到该行所在页 → 滚到那一行并临时高亮两秒,
  复用现有 `SearchJumper`。
- **扫描有上限也有时间预算**:命中数到上限即停并标记"结果太多";超出时间预算仍未扫完就
  停下,如实告诉用户"只扫到第 N 行",**不谎称已搜遍全表**。请求中断(用户改词、关检索条、
  换文件)要能真正掐掉服务端那次扫描。
- **旧服务进程兼容**:接口 404 时前端**退回当前页本地检索**,并保留原来那句
  "表格只搜当前这一页"的说明 —— 用户跑着旧服务配新前端不会白屏,也不会被误导。
- **表格在扫描后被改动**(mtime 变了)时,点结果不假装跳成功:提示重搜。

不做:跨文件检索;一个转换包内跨表检索;正则、大小写敏感、整词匹配等高级选项;
把命中行导出或另开列表页;列筛选与排序;任何形式的索引落盘或常驻缓存(行数缓存除外,
那是 `/table` 已有的)。

## Capabilities

### New Capabilities
- `table-scan-search`: 表格整表流式检索 —— 接口的入参与响应形状、匹配与排序语义、
  扫描上限与时间预算、中断与并发、旧服务降级、命中定位到页与行、表格中途变化的处理。

### Modified Capabilities
- `preview-search`: 原 spec 写死"表格「数据」页与单份 csv/tsv 的检索范围 MUST 限于当前
  已经画出来的这一页"。本 change 把它改成"整表检索,由服务端扫描;接口不可用时退回当前页",
  零命中文案随之改口。**注意归档顺序**:`preview-search` 的主 spec 还在未归档的
  `reader-content-search` 里,要先归档它,本 change 的 delta 才有基线。

## Impact

- **平面:服务端 + 前端两侧都动,并且动 `src/app/lib/api.ts` 契约。**
  - `src/server/http.mjs`:新增 `table-search` 路由与 `scanCsv()` 扫描函数(与 `readCsvPage`
    并列)。路径照旧过 `resolveInside()`,扩展名仍只认 `.csv` / `.tsv`。
  - `src/app/lib/api.ts`:新增 `TableSearchResult` 类型与 `api.tableSearch()`;
    **新字段一律可选 + 前端兜底**,旧进程返回 404 时走降级分支。
  - `src/app/components/PreviewSearch.tsx`:除现有的本地 DOM 检索外,支持一个异步结果源
    (加载中 / 失败 / 部分结果三种态),键盘与开合行为不变。
  - `src/app/components/Reader.tsx` + `CsvGrid` / `PaginatedCsvTable`:行上挂绝对行号,
    分页状态要能被外部驱动("跳到第 N 行"),供命中定位使用。
  - `scripts/build-npm-package.mjs`:若采用下面那个共享内核目录,组包时要一并拷进去,
    否则 npm 装出来的服务一起手就 `ERR_MODULE_NOT_FOUND`。
- **不动**:`bin/cli.mjs`、`templates/**`、`src/server/scan.mjs` 与 SSE。
- **要重启常驻服务**:改了 `src/server/**`,`pnpm serve` / `pnpm dev` 必须重起才生效。
- **不引新依赖。** 服务端不引 CSV 解析库(扫描按原始行文本判定),前端继续用已有的 papaparse
  解析单行。

### 已定:匹配内核抽成共享 `.mjs`,新开 `src/shared/`

服务端要跟前端用**同一套**关键词归一与分词,否则会出现"服务端说这行命中、前端却一个词
都加不了粗"的不一致。现有实现 `src/app/lib/fuzzySearch.ts` 是 TS,`src/server/**` 是无类型
检查的 `.mjs`,两边不能直接互相 import。推荐把 `normalize` / `tokenize` 抽成一份不依赖 DOM、
不依赖 Node 的纯 `.mjs`,**新开 `src/shared/`** 让两个平面共用。

**已拍板采用这条。** 代价是 AGENTS.md 第 3 节的目录结构要跟着改 —— 那份文档现在只描述了
`src/server` 与 `src/app` 两个平面,并写明"跨平面的唯一契约是 `src/app/lib/api.ts`"。
共享纯函数不是 JSON 契约,但它确实是第二处跨平面耦合,所以 `src/shared/` 的边界要在
AGENTS.md 里写死:**只放两侧共用的纯函数,不放任何带 IO / DOM 的东西**。
备选(服务端自己复制一份归一分词 + 一致性校验脚本)已否决,理由见 design D3。
