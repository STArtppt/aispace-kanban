## MODIFIED Requirements

### Requirement: 模板 .gitignore 精简

模板 `.gitignore` SHALL 整目录忽略 `input/raw/*`、`input/assets/*`、`input/sources/*`，并只放行 `.gitkeep`、`input/sources/README.md`、
`input/sources/example.yaml.txt`；SHALL 删除原来按扩展名列举的 `input/**/*.<扩展名>` 规则；
SHALL 对 `output/converted/**` 忽略同一组大体积二进制 / 表格扩展名（csv、sqlite、db、sql、Office 文件、pdf、zip），
`_manifest*.md` 与普通 `.md` 产物仍入库。`input/INDEX.md`、`input/README.md` 仍入库。
`output/` 其余目录与 `visualization/` 的规则不变。

#### Scenario: 新工作空间提交

- **WHEN** 新建工作空间后放入原件、转换，执行 `git add -A`
- **THEN** 暂存区没有 `input/raw/`、`input/assets/`、`input/sources/*.yaml` 下的文件，也没有 `output/converted/` 下的 csv / sqlite；
  `output/converted/` 的 `.md` 与 `input/INDEX.md` 在暂存区里

#### Scenario: 数据源配置

- **WHEN** 用户在 `input/sources/` 新建 `仓库库.yaml`
- **THEN** 它被忽略；`input/sources/README.md` 仍被跟踪
