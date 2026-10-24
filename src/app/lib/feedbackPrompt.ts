/**
 * 反馈单页左下角「复制更新 Prompts」：看板从源码启动时，把还没处理的反馈单一次交给源码仓库的 AI。
 * 只写剪贴板，不发任何写请求。
 *
 * 口径以根目录 AGENTS.md 第 6.2 节与 `.claude/skills/local-source-sync` 为准，那边改了这里跟着改。
 * 提示词里不写绝对路径：实例根由对面从 `~/.pmwork/dashboard/runtime.json` 的 `instances` 按 id 找，
 * 与 `/api/health` 不暴露路径的约定一致。
 */

export interface SourceUpdateItem {
  id: string;
  title: string;
  /** 「缺陷」/「贡献」 */
  kind: string;
}

export function sourceUpdatePrompt({
  projectId,
  projectName,
  items,
}: {
  projectId: string;
  projectName: string;
  items: SourceUpdateItem[];
}): string {
  const list = items.map((item) => `- ${item.id}［${item.kind}］${item.title}`).join('\n');
  return `在看板源码仓库（~/.pmwork/dashboard/runtime.json 的 repoRoot）里，批量处理工作空间「${projectName || projectId}」（实例 id：${projectId}）的反馈单。

还没处理的（status 为 pending）：
${list}

按源码仓库 AGENTS.md 第 6.2 节和 local-source-sync 技能做：
1. 在 runtime.json 的 instances 里按 id 找到实例根，直接读 output/feedback/<编号>.md。不要求发邮件，不把文件拷进源码仓库。
2. 缺陷单当需求走本仓流程；贡献单当作对 templates/pm-aispace/ 的需求。进仓前按 6.1 节脱敏，换个项目不成立的不收。
3. 每份过第 4 节闸门后单独提交。
4. 全部处理完，逐份给一段可转发的回执：结论、模板位置或改动位置、提交号；不收的写理由。

不要改工作空间里的任何文件，反馈单的 status 和 receipt 由工作空间里的智能体按回执改。
如果你是在工作空间里收到这段话：你不能改看板源码，把这段话原样转给看板源码目录里的智能体。`;
}
