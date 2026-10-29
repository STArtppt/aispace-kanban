## MODIFIED Requirements

### Requirement: 三组原稿的行菜单提供「重命名」

产出文档视图中 `analysis` / `docs` / `decisions` 三组的每一行(含组内子目录与已归档项、含非 `.md` 文件)的「更多」菜单 SHALL 提供「重命名」。转换产物标签的行菜单 MUST NOT 出现「重命名」(那里提供的是「复制到…」,见 `converted-copy-to-output`)。

#### Scenario: 交付文档行可以重命名

- **WHEN** 用户在「交付文档」标签某一行点「更多」
- **THEN** 菜单里有可点的「重命名」

#### Scenario: 转换产物不出现重命名

- **WHEN** 用户在「转换产物」标签某一行点「更多」
- **THEN** 菜单里没有「重命名」,有「复制到…」

#### Scenario: 工作空间没有改名脚本

- **WHEN** scan 返回 `canRename: false`
- **THEN** 「重命名」置灰,提示更新模板后可用

#### Scenario: 旧服务进程没给 canRename

- **WHEN** scan 结果里没有 `canRename` 字段
- **THEN** 「重命名」置灰,提示重启看板服务,不弹窗、不白屏
