# rename 合成语料

`workspace/` 是一个最小工作空间，全部内容合成，不含真实资料。
`pnpm test:rename`（`scripts/check-rename.mjs`）把它拷到临时目录，填好交付稿里的 `source_sha` / `body_sha` 占位符，
用模板的 `scripts/rename_output.py` 预览、执行，断言：

- 预览不改任何文件，清单里不出现排除范围的命中，交付稿只数 front-matter；
- 非法新名字、越界来源、归档说明文件、名字冲突、新镜像目录已存在、指纹不符、预览后文件被改，都拒绝且磁盘无变化；
- 执行后原稿、镜像目录、镜像里的 `<基名>.docx` 改名，其余交付件名字不变；
- 记录 `target`、批注 `- 对象：`、问题 `source` / `flows_to#锚点`、定稿 `source` / `docx`、`project.yaml`、
  相对链接（含尖括号）、三种 wikilink 都跟进；外链、同名词语、`旧.mdx` 这类相似路径不动；
- `.claude/`、根 `AGENTS.md`、`input/`、`output/converted/`、`visualization/` 与交付稿正文一个字节不变；
- 看板 `listDelivery` 用新原稿的键看得到全部版本、定稿、批注，不误报「原稿已变更」；
  其他原稿 B 的交付稿 `source_sha` 跟进，本来就对不上的不动；
- 记录状态流水追加改名留痕（缺小节时补上），历史条目不改写，没有记录的不新建；
- 改回原名后，除记录多出的留痕外整个工作空间与改名前逐字节一致；子目录、已归档、非 `.md` 各改一次。

改链接识别规则时同步改这里的断言；不要往这里放真实资料。
