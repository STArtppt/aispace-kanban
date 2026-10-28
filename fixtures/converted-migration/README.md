# converted-migration 合成语料

`workspace/` 是一个**旧布局**（转换产物在 `input/converted/`）的最小工作空间，全部内容合成，不含真实资料。
`pnpm test:converted-migration`（`scripts/check-converted-migration.mjs`）把它拷到临时目录，用模板的
`scripts/migrate_converted_to_output.py` 跑一遍，断言：

- `--dry-run` 不改任何文件；
- 迁移后 `output/converted/` 里的图片链接（markdown 与 `<img>` 两种写法、目录名带空格和括号）、摘要互链、
  指回 `input/raw/` 的链接、frontmatter `payload` 全都指得到；外链、页内锚点、代码块不动；
- `input/assets/` 没动，`output/analysis/` 一个字节没变，`input/INDEX.md` 表格改成 `../output/converted/…`、人工批注区不动；
- 看板扫描认出新布局，产出文档里旧前缀 `input/converted/…` 的引用仍算「被引用」；
- 目标非空时拒绝并非零退出；`--reverse` 能搬回去且链接仍可达。

改迁移规则时同步改这里的断言；不要往这里放真实资料。
