## 1. 共享匹配内核

- [x] 1.1 **已拍板**:走 design D3 的推荐 —— 新开 `src/shared/`,前端与服务端共用同一份
      归一分词内核;备选 A(服务端复制 + 校验脚本)否决。
- [x] 1.2 新建 `src/shared/textMatch.mjs`:把 `normalize()` 与 `tokenize()` 从
      `src/app/lib/fuzzySearch.ts` 原样搬过来,JSDoc 注类型,**零依赖、不碰 DOM、不碰 Node API**;
      注释里写清"这份被前端与服务端同时 import,改它要同时想两边"。
- [x] 1.3 `src/app/lib/fuzzySearch.ts` 改成从共享内核 re-export 这两个函数,
      对外签名与行为保持不变(`searchBlocks` / `toSnippetParts` 的调用方一处都不用改)。
- [x] 1.4 `tsconfig.json` 打开 `allowJs`(**不开** `checkJs`);跑 `pnpm typecheck` 确认
      报错数为 0、耗时没有明显变化。
- [x] 1.5 `scripts/build-npm-package.mjs` 的拷贝清单加上 `src/shared`;
      跑 `pnpm build:npm && pnpm pack:npm && pnpm smoke:npm` 确认装出来的包能起服务
      (漏了这一步,npm 装的用户一起手就是 `ERR_MODULE_NOT_FOUND`)。
- [x] 1.6 更新 `AGENTS.md` 第 3 节的目录树与平面说明,写明 `src/shared/` 的边界:
      只放两侧共用的纯函数,不放任何带 IO / DOM 的东西。

## 2. 服务端整表扫描(改完必须重启进程)

- [x] 2.1 `src/server/http.mjs` 加 `scanCsv(abs, { tokens, limit, deadline, signal })`:
      与 `readCsvPage` 并列,同样用 `readline` 流式逐行读;跳过表头与空行;
      对每行原始文本 `normalize()` 后判定**是否包含全部 token**;命中记
      `{ row, text }`(`row` 从 0 起、不含表头)。
- [x] 2.2 在 `scanCsv` 里落两个边界:命中数到 `limit` 就 `rl.close()` 并标 `truncated`;
      每隔若干行看一次时钟,超出时间预算就停并标 `partial` + `scannedRows`。
      返回值还要带 `totalRows`(扫完了才是准数,没扫完就给已扫行数并说明)。
- [x] 2.3 加路由 `GET /api/projects/:id/table-search`:`path` 过 `resolveInside()`;
      不存在或是目录 → 404;扩展名不是 `.csv` / `.tsv` → 400(措辞与 `/table` 一致);
      `q` 切词后为空 → 直接返回空结果,不读文件;`limit` 夹到 `[1, 500]`,默认 200。
      响应带 `path`、`rows`、`truncated`、`partial`、`scannedRows`、`totalRows`、`size`、`mtime`。
- [x] 2.4 接上中断:`req.on('close')` 里关掉读流,确认客户端断开后扫描真的停了
      (在一个大文件上加临时日志跑一次,验证完删掉日志)。
- [x] 2.5 **重启 `pnpm serve`**,用 curl 跑一遍:命中在末页的关键词、命中三千行的关键词
      (看 `truncated`)、越界 `path`(403)、`.md` 路径(400)、空 `q`。
      顺手确认工作空间目录里没有任何文件被新增或改动。

## 3. 同步 api.ts 契约

- [x] 3.1 `src/app/lib/api.ts` 新增 `TableSearchHit` / `TableSearchResult` 类型,
      形状与 2.3 的响应一一对应;**新字段一律可选 + 注释写清旧进程缺字段时的兜底**。
- [x] 3.2 新增 `api.tableSearch(id, path, q, { limit, signal })`,支持 `AbortSignal`;
      注释写明"老服务没有这个接口(404),调用方要自己兜住"(照 `references` 的写法)。

## 4. 前端接入

- [x] 4.1 `PreviewSearch.tsx` 加可选的异步结果源 prop(`source` + `onPick`),不传即维持现在的
      本地 DOM 检索;开合、防抖、上下键、Enter、Esc、输入法让位这些行为**只有一份实现**。
      远端模式的防抖放到约 350ms,并在发起新请求前 abort 上一次。
- [x] 4.2 `PreviewSearch.tsx` 补三种异步态的展示:检索中、失败(如实报错,**不显示"没找到"**)、
      部分结果("只扫到第 N 行,后面还没扫");截断时列表底部写"只显示前 N 条"。
      结果条目前缀显示行号。
- [x] 4.3 `CsvGrid`:给每个 `<tr>` 挂 `data-row-index`(绝对行号 = `page * pageSize + i`)。
- [x] 4.4 `PaginatedCsvTable`:用 `useImperativeHandle` 暴露 `jumpToRow(row)` ——
      已在当前页就直接找 `<tr>` 交给 `SearchJumper`;不在就 `setPage()`,并用一个"待跳转行"的 ref,
      在该页数据到位后再定位。页加载失败时如实提示,不高亮任何行。
- [x] 4.5 `Reader.tsx`:表格数据页 / 单份 csv 的 `PreviewSearch` 改用远端结果源,
      结果源里带上当前选中的那张表的 `path`(多表包用 `active`);选中回调调 4.4 的句柄。
      其余形态(markdown / 摘要 / 校验说明 / 纯文本)保持本地检索不变。
- [x] 4.6 降级分支:`api.tableSearch` 返回 404 时退回当前页本地检索,并保留
      "表格只搜当前这一页,不是整张表"的说明;**只有 404 走这条**,其它错误如实报错。
- [x] 4.7 记下响应里的 `mtime`;选中结果时若表格 `mtime` 已变,提示重新检索,不跳转不高亮。
- [x] 4.8 空态与说明文案:数据页零命中要说明"整张表里没有匹配"且"一行里要出现全部关键词",
      不能让人误以为只搜了当前页,也不能让人误以为是模糊匹配。

## 5. 验收闸

- [x] 5.1 `pnpm typecheck` 绿。
- [x] 5.2 `pnpm build` 绿。
- [x] 5.3 **重启 `pnpm serve` / `pnpm dev`**,在浏览器里把受影响视图点一遍:
      多表转换包的「数据」页(命中在末页 → 自动翻页 + 高亮那一行)、单份 csv、
      「摘要」页的 markdown 检索(确认没被改坏)、纯文本预览、HTML 原型两个 tab。
- [x] 5.4 边角情形实测:关键词命中上千行(截断提示)、大表搜一个不存在的词(部分结果提示)、
      连打多个字(前次请求被取消,结果不错乱)、检索中途换文件、检索中途切表。
- [x] 5.5 降级实测:先用**旧版本服务进程**配新前端跑一次,确认数据页退回当前页检索且文案正确;
      再确认无 `project.yaml`、工作空间目录丢失两种情况下预览与检索都不白屏。
- [x] 5.6 深色模式下把 4.2 的三种异步态与命中行高亮各看一眼,确认对比度够、
      并且**没有出现 orange**(`--destructive` 只给"需要注意")。
- [x] 5.7 `pnpm build:npm && pnpm pack:npm && pnpm smoke:npm` 走一遍(1.5 若已跑过且此后
      没再动过组包清单,可只跑 `smoke:npm`)。

## 验证记录（2026-09-02）

- 服务端：合成 15 万行 / 5 MB csv，`curl` 覆盖末页命中、200 条截断、403 越界、400 非表格、
  404 不存在、空关键词不扫文件;时间预算与客户端中断各用一次临时改常量 + 临时日志坐实
  （partial 停在第 500 行、客户端断开时扫到 35,800 行即停），验完已还原。
- 前端（浏览器实点）：整表命中跨页跳转 + 高亮（第 96,000 行）、同页命中高亮、200 条截断文案、
  零命中文案、连打多字只留最后一次结果、全角关键词命中半角写法、多表包切表后检索范围跟着换
  且旧结果被清空、markdown / 纯文本的本地检索未被改坏、深色模式三态可辨且无 orange。
- 降级：临时改路由名模拟旧服务 → 退回当前页检索并给出"重启 serve 后可搜整张表"的说明；
  无 project.yaml、工作空间目录被移走两种情况下界面照旧。
- 组包：`pnpm build:npm` 拷进了 `src/shared/textMatch.mjs`，`pnpm pack:npm && pnpm smoke:npm` 29 项全过。
