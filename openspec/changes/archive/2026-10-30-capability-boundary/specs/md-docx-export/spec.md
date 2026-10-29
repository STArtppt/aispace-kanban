## ADDED Requirements

### Requirement: 脚本不认转换产物新位置时拒绝

服务端 MUST 在来源 `.md` 位于 `output/converted/`、而工作空间的 `md2docx.py` 还不认这个位置（源码里没有 `converted-in-output` 标记）时
返回 400 并说明先更新工作空间模板，MUST NOT spawn 脚本；转换产物目录 MUST NOT 被写入任何字节。

#### Scenario: 旧脚本遇到新位置的转换产物

- **WHEN** 转换产物已在 `output/converted/`，工作空间的 `md2docx.py` 没有 `converted-in-output` 标记，用户对其中一份点「转成 Word」
- **THEN** 接口返回 400，工作空间没有任何文件变化
