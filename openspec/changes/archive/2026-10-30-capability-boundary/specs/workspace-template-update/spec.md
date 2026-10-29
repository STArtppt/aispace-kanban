## ADDED Requirements

### Requirement: 看板新建工作空间只 spawn 铺设脚本

看板的「新建工作空间」（能力标识 `workspace-init`）SHALL 只由用户在新建对话框里点确认发起；
看板 MUST 只 spawn 内置模板根下的 `init_workspace.py --from <所选模板目录> --name <名字> --path <目录> --json`，
骨架目录与 `.aispace/template.lock.json` 都由脚本写，看板 MUST NOT 自己建目录或写文件。
接口 MUST 环回且非跨站，否则 403。模板只能从模板清单里按标识选，请求不带模板路径；名字或路径为空 400，模板不存在 400。
脚本成功后看板只把新目录登记进本机注册表 `~/.pmwork/dashboard/projects.json`。
找不到 Python 3 时 400 说清出路。

#### Scenario: 非环回监听

- **WHEN** 看板以 `--host 0.0.0.0` 启动，有人从另一台机器提交新建
- **THEN** 接口返回 403，目标目录没有被创建

#### Scenario: 模板标识不存在

- **WHEN** 请求的 `template` 不在模板清单里
- **THEN** 接口返回 400，不 spawn 脚本
