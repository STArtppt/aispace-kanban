## ADDED Requirements

### Requirement: 资料转换只 spawn 转换脚本

资料转换（能力标识 `raw-ingest`）SHALL 只由用户在原始资料行或目录上点「转换」发起；看板 MUST 只 spawn 工作空间的 `scripts/ingest.py`，
自己 MUST NOT 往工作空间写任何字节。接口 MUST 环回（`allowMutations`）且非跨站，否则 403。
请求只带 `input/raw/` 下的一个文件或子目录的相对路径，服务端过 `resolveInside()` 并确认落在 `input/raw/` 之内。
脚本读 `input/raw/`，产物写转换产物根 `output/converted/`（旧布局工作空间是 `input/converted/`）；
产物还在旧位置时新脚本拒绝写，由人跑模板的一次性迁移脚本，看板 MUST NOT spawn 迁移、也不提供迁移按钮。
看板解析到本地 anydoc 时 SHALL 以 `ANYDOC_BIN` 注入子进程环境，解析不到就不注入（脚本走 PATH）。
工作空间没有 `scripts/ingest.py` 或找不到 Python 3 时 MUST 返回 400，不退化成看板代劳；同一工作空间已有转换在跑时 409。

#### Scenario: 非环回监听

- **WHEN** 看板以 `--host 0.0.0.0` 启动，有人从另一台机器对某份资料点「转换」
- **THEN** 接口返回 403，没有转换任务被启动

#### Scenario: 工作空间没有转换脚本

- **WHEN** 用户在一个自己 `mkdir` 的工作空间（没有 `scripts/ingest.py`）里点「转换」
- **THEN** 接口返回 400 并说明出路，工作空间里没有任何文件变化
