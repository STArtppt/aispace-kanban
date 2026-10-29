## ADDED Requirements

### Requirement: 刷新的写入面

刷新已接入原型（能力标识 `prototype-refresh`）时看板 MUST 只 spawn 通过校验的 `workspace-sync.mjs`，自己 MUST NOT 写任何字节。
脚本在工作空间内 SHALL 只写 `visualization/prototypes/<slug>/`（整份覆盖 `spec/` `docs/` `annotations/` `comments/`
`meta.json` `SYNC.md` `sync.json`）与同级 `<slug>-html.zip`，这些都是能从原型工作区重新生成的镜像；
`input/` `output/` `project.yaml` 只读其修改时间。
在工作空间外脚本 SHALL 只写原型目录的 `.workspace-inbox.md`。这是一项登记在能力清单里的偏离（写入面越出工作空间），
补偿措施是原型目录必须经 `.workspace-link.json` 回指当前工作空间、脚本名与参数由服务端固定。

#### Scenario: 刷新不碰输入与产出

- **WHEN** 用户刷新一份已接入原型，脚本退出码 0
- **THEN** `input/`、`output/` 与 `project.yaml` 一个字节都没变，变化只在该原型的镜像目录、同级 zip 与原型目录的 `.workspace-inbox.md`
