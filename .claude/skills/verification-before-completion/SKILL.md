---
name: verification-before-completion
description: 在 aispace-kanban 中准备说「做完了 / 修好了 / 能跑了」之前使用 —— 没有刚跑出来的证据不许下完成结论;本仓服务端无类型检查无测试,typecheck 绿不等于做完。
---

# 交付前验证(Verification Before Completion)

> 上游来源:[obra/superpowers · verification-before-completion](https://github.com/obra/superpowers/tree/main/skills/verification-before-completion)。
> 本文件是 aispace-kanban 的本地化改写版,与本仓三道闸对齐。

## 何时使用

- 准备说「完成 / 修好了 / 应该没问题 / 能跑」之前。
- 准备提交、回复用户「已就绪」之前。
- 采信子 agent 或工具的「成功」报告之前。

## 铁律

**没有「刚刚跑出来」的证据,就不许下任何完成 / 正确性结论。** 无论多累、多自信、多赶。

**本仓特别注意:`pnpm typecheck` 只覆盖 `src/app`。** 服务端 `.mjs` 与 `bin/cli.mjs`
没有任何静态检查、也没有测试 —— 它们全绿**不构成**任何证据。碰过服务端就必须重启 + 冒烟。

## 三道闸(按顺序,全部要有当次输出)

```bash
pnpm typecheck     # 1. 前端类型
pnpm build         # 2. 构建(非 dev 模式的 serve 伺服 dist/)
pnpm dev           # 3. 重启进程 —— 服务端不热更
curl -s localhost:7788/api/health
```

第 3 步的冒烟内容,按改动挑:

- 动过接口 / 扫描:`curl -s "localhost:7788/api/projects/<id>/scan" | head -c 600`,
  **肉眼确认新字段在返回里**(别靠 type 推断)。
- 动过界面:浏览器开 <http://localhost:5180>,点一遍受影响视图。
- 动过 CLI:`node bin/cli.mjs list` 之类真的跑一次。
- 边界场景至少覆盖:**没有 `project.yaml` 的工作空间**、**登记目录已丢失的工作空间**
  (`available === false` 的降级路径)、**深色模式**。

## 五步流程(下任何结论前)

1. **确定** 能证明该结论的那条命令。
2. **完整、重新** 执行它(不复用旧输出)。
3. **检查** 完整输出与退出码。
4. **确认** 结果确实支持你的结论。
5. **然后才** 给结论,并附证据。

跳步不是效率,是不诚实。

## 高风险信号(出现就回去补验证)

- 用模糊措辞:「应该能跑」「大概没问题」。
- 验证还没跑就表达满意。
- 拿局部检查冒充整体:**typecheck 过 ≠ build 过 ≠ 服务端对 ≠ 界面上真的显示出来了**。
- 改了服务端却没重启进程就下结论。
- 直接相信工具 / 子 agent 的报告,未独立复核。

## 诚实报告

跑过但有失败的,**照实说**并附输出;跳过的冒烟项,说明跳了哪项、为什么。
半绿说成全绿是本仓最贵的错误 —— 用户下一步就是拿它给别人看。

## 关联

- 提交前清单:[[project-conventions]]、[[dashboard-feature-flow]]
- 调试收尾接这里:[[systematic-debugging]]
