## 1. 去掉重复解析（已完成）

- [x] 1.1 `Markdown.tsx` 按 `children` + `sourceFile` + `sourceByteOffset` memo 整棵正文元素，
      父组件重渲染不再触发重新解析
- [x] 1.2 `urlTransform` 收进 ref 并包成身份恒定的回调；没传时退回 `defaultUrlTransform`
      （保住 `javascript:` 消毒）
- [x] 1.3 验证：`pnpm typecheck`、`pnpm build`、`pnpm test:anchor` 全绿；浏览器实测点开耗时
      497ms/3 段 → 192ms/1 段，目录、锚点 span 数量不变

> **状态（2026-09-04）**：第 1 组已合入。第 2–3 组照下面的设计做出来量过了，结论是净亏
> （点开到出内容 340ms → 800ms），**已回滚,不在仓库里**；实测数据与卡点见 proposal 的
> 「实测结论」。要重启这条路，先解掉「同一条管线在 worker 里慢 4 倍」那个未解之谜。

## 2. 依赖与骨架

- [ ] 2.1 `package.json` 显式声明前端平面依赖：`unified`、`remark-parse`、`remark-rehype`、
      `hast-util-to-jsx-runtime`，版本对齐 `react-markdown` 现有传递依赖；`pnpm why` 确认各只有一份实例
- [ ] 2.2 新建 `src/app/lib/markdownPipeline.ts`：把管线配置（remark/rehype 插件顺序、
      `singleTilde: false`、`disallowedElements` 过滤、剥 `position`）收成一处纯函数，
      主线程与 worker 共用同一份配置，杜绝两边漂移
- [ ] 2.3 新建 `src/app/workers/markdown.worker.ts`：收 `{ id, source, sourceFile, byteOffset }`，
      跑管线，回 `{ id, tree }` 或 `{ id, error }`

## 3. 主线程接入

- [ ] 3.1 新建 `src/app/hooks/useMarkdownTree.ts`：模块级单例 worker + 自增请求 id，
      过期结果丢弃；`new Worker` 抛错、worker 报错、超时（8s）都返回"降级"信号
- [ ] 3.2 `Markdown.tsx` 增加 worker 路径：源码字节数 ≥ 阈值（32 KB）走 worker，
      拿到 hast 后用 `hast-util-to-jsx-runtime` + 现有 `mdComponents` 出元素；
      `urlTransform` 在这一步施加
- [ ] 3.3 阈值以下、或 worker 报错 / 超时时，走现有同步 `react-markdown` 路径（原样保留，别删）
- [ ] 3.4 解析期间显示"正在排版"过渡态：不留上一篇的残留正文，不空白；样式用既有令牌，
      黑白灰，不用 `--destructive`
- [ ] 3.5 确认 `Reader.tsx` / `HelpPanel.tsx` 这两个调用方能吃"正文晚一拍出现"：
      目录回传、批注层几何、预览内检索的块索引都是渲染后才跑，时序上不能提前

## 4. 等价性闸

- [ ] 4.1 `scripts/test-anchor.ts` 加一项：同一份源码，worker 管线（node 里直接跑，不起真 worker）
      与现有 `react-markdown` 管线产出的 HAST 必须等价 —— 节点数、A2 属性、文本 span 数逐一比对
- [ ] 4.2 该项用一份**合成**的大表语料（不用真实工作空间文件），跑通 `pnpm test:anchor`

## 5. 验收闸

- [ ] 5.1 `pnpm typecheck` 绿、`pnpm build` 绿、`pnpm test:anchor` 全部通过
- [ ] 5.2 重启 `pnpm serve`（服务端不热更；本变更虽只动前端，但 serve 伺服的是 `dist/`，
      不重新构建看不到），浏览器把受影响视图点一遍：输入资料 / 产出文档 / 帮助文档三处的
      markdown 预览
- [ ] 5.3 降级路径实测：临时把阈值设成 0 且让 worker 立即抛错，确认正文照常渲染、
      不停在过渡态、批注与检索可用
- [ ] 5.4 边界情况点一遍：没有 `project.yaml` 的工作空间、目录被改名/移走的工作空间
      （`available === false` 降级路径）、深色模式
- [ ] 5.5 浏览器实测大表文档：主线程无由解析造成的 120ms 以上长任务；记下点开耗时，
      与本变更第一步的 192ms 对照
- [ ] 5.6 `pnpm smoke:npm` 在干净目录装包实跑，确认 worker chunk 进了包且预览正常
