# 工程平面技能(Engineering Skills)

> 总览与边界见根目录 [AGENTS.md](../../AGENTS.md) 第 6 节。

**本目录只放工程技能 —— 约束「编码 Agent 怎么改这个看板」的纪律与规范。**
它们由 Claude Code 按 `description` 自动路由,其它 Agent 通过 AGENTS.md 的链接进来读。
**不随产品交付**,也不是运行时能力。

本项目只有这一个技能平面(对比 acgogogo 的双平面:它还有对外可分发的「生产技能」)。
看板是纯只读工具,没有对外分发的能力,所以不设第二平面 —— 别在这里放业务数据或运行时脚本。

---

## 放什么 / 不放什么

| ✅ 放这里 | ❌ 不放这里 |
| --- | --- |
| 目录 / 命名 / 提交约定 | 用户使用说明(→ `README.md`) |
| 跨平面改动的顺序与契约清单 | 项目定位、技术栈、命令(→ `AGENTS.md`) |
| 组件、设计令牌等编码规范 | 一次性的调查笔记 |
| 调试 / 验证等流程纪律 | 任何运行时会被执行的代码 |

判据:**「指导我们怎么写这个仓库的代码」→ 这里;其它 → 别处。**

## 目录与格式

```
.claude/skills/
├── README.md
└── <skill-name>/SKILL.md      # 一个技能 = 一个目录 + 一份 SKILL.md
```

`SKILL.md` 以 YAML frontmatter 开头(`name` 与目录同名;`description` 写成
「**何时该用这个技能**」以利自动路由),正文给场景 / 规范 / 清单 / 可复制示例。
技能之间用 `[[skill-name]]` 互相引用。

## 当前技能

**本项目特化(我们自己写的):**

- `dashboard-feature-flow` —— **加/改功能的主入口**:跨 CLI / 服务端 / 前端三平面的
  改动顺序、契约同步清单、常驻服务的兼容性要求
- `project-conventions` —— 目录 / 命名 / 别名 / 平面边界 / 提交前清单
- `react-component-authoring` —— 新建或重构 React 组件
- `design-tokens` —— 令牌、主题、"orange 只给需要注意"的配色硬约束
- `design-system-loop` —— 与上游 [startist-ui](../../../startist-ui) 的消费闭环:
  `shadcn add` 的来源与命令、vendored 快照不可 fork、缺口回流真源再 re-add
  (真源侧有对称技能 `startist-ui/skills/design-system-loop/`,两端契约一致)

**上游方法论适配(精选子集,本地化改写 —— 非整包引入):**

- `disciplined-coding` —— Karpathy 四原则(先想再写 / 简洁 / 外科手术式改动 / 目标驱动),
  改写自 [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills)
- `systematic-debugging` —— 「先找根因再动手」四阶段 + 三次规则,含本仓实案分诊启发,
  改写自 [obra/superpowers](https://github.com/obra/superpowers)
- `verification-before-completion` —— 没有刚跑出来的证据不许下完成结论,对齐本仓
  typecheck + build + 重启冒烟三道闸,同上游

写法标准遵循 [anthropics/skills](https://github.com/anthropics/skills) 的 SKILL.md 约定。

## 分层与优先级

三层叠加,**越靠下越具体、优先级越高**:

1. **上游标准** —— anthropics/skills 的 SKILL.md 写法
2. **上游基线** —— superpowers / karpathy-skills 的通用纪律,只取精选子集并本地化改写
3. **本地特化** —— 本仓特有的约束(平面划分、只读红线、契约同步、配色)

上游技能写给所有人,本地技能写的是**这个仓库的具体选择**。
两者就同一主题说法不同,**以本地为准**。

## 编写原则

1. **场景驱动**:从「何时需要」出发,而非罗列知识。
2. **可执行**:给步骤 / 清单 / 可复制示例,不写抽象口号。
3. **单一职责**:一个技能聚焦一类事,过大就拆。
4. **与代码同源**:引用真实文件路径与真实函数名;代码变了就更新技能。
5. **增量生长**:踩了坑就把分诊结论补进对应技能(尤其 `systematic-debugging`)。
