## ADDED Requirements

### Requirement: 整理失败时的回退

`move_raw.py` 改写文本 MUST 先写临时文件；改名阶段失败 MUST 把已做的改名全部改回，并删掉本次新建的空镜像目录；
改名全部完成后个别文本替换失败 MUST NOT 回滚已完成的改名，而是在结果里如实列出失败的文件。
原件与落点不在同一设备上时 MUST 返回 400，MUST NOT 改成复制。整理后留下的空目录 MUST NOT 被删除。

#### Scenario: 跨设备移动

- **WHEN** `input/raw/` 下某个子目录是挂载在另一块盘上的目录，用户把其中的文件移到 `input/raw/` 根
- **THEN** 返回 400，文件留在原处，没有被复制出第二份

#### Scenario: 整理后的空目录

- **WHEN** 用户把 `input/raw/批次甲/` 下唯一一个文件移到根上
- **THEN** `input/raw/批次甲/` 仍在，是空目录
