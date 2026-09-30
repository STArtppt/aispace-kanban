/**
 * 去 AI 味的「复制提示词」。只写剪贴板，**不发任何写请求** —— 交付稿、规则库全由工作空间 AI 按技能
 * `pm-deai-writing` 写（AGENTS.md 不变量 1：去 AI 味这条线看板不新增写入）。
 *
 * 口径以工作空间 `.claude/skills/pm-deai-writing/SKILL.md` 与 `output/delivery/README.md` 为准，
 * 那边改了落点、字段或标记格式，这里要跟着改。
 */

export const DEAI_SKILL_DIR = '.claude/skills/pm-deai-writing';
export const RULES_PATH = `${DEAI_SKILL_DIR}/rules/rules.md`;

/** 交付稿目录：`output/docs/a/b.md` → `output/delivery/docs/a/b`（与服务端 scan.mjs 的 deliveryDirOf 同一规则） */
export function deliveryDirOf(sourcePath: string): string {
  return `output/delivery/${sourcePath.replace(/^output\//, '').replace(/\.md$/i, '')}`;
}

/** 交付稿路径 → 原稿路径与版本；不是交付稿返回 null（与服务端 scan.mjs 的 deliveryOf 同一规则） */
export function deliveryOf(path: string): { source: string; version: string } | null {
  const m = /^output\/delivery\/(analysis|docs|decisions)\/(.+)\/(v\d{3})\.md$/.exec(path);
  return m ? { source: `output/${m[1]}/${m[2]}.md`, version: m[3] } : null;
}

/** 已有版本号 → 下一版（`v001`、`v002` → `v003`） */
export function nextVersion(versions: string[]): string {
  const max = versions.reduce((n, v) => Math.max(n, Number(v.replace(/^v/, '')) || 0), 0);
  return `v${String(max + 1).padStart(3, '0')}`;
}

/** 技能不在（旧工作空间）时，先让 AI 从模板补齐。看板不替用户复制文件（那等于看板在写工作空间）。 */
export function installSkillPrompt(): string {
  return [
    '这个工作空间还没有「去 AI 味」技能。请从 aispace-kanban 仓库的工作空间模板补齐：',
    '',
    `1. 把 \`templates/pm-aispace/${DEAI_SKILL_DIR}/\` 整个目录（SKILL.md、rules/rules.md、rules/history/、rules/CHANGELOG.md）`,
    `   复制到本工作空间的 \`${DEAI_SKILL_DIR}/\`；`,
    '2. 把 `templates/pm-aispace/output/delivery/README.md` 复制到本工作空间的 `output/delivery/README.md`；',
    '3. 把模板 `AGENTS.md` 里「交付前去 AI 味」一节，以及目录表、技能表、Markdown 约定表里 `output/delivery/` 与 `pm-deai-writing` 那几行，',
    '   同步进本工作空间的 `AGENTS.md`。',
    '',
    '源码在 https://github.com/STArtppt/aispace-kanban ，只复制上面这几样，别的文件不要动。',
  ].join('\n');
}

const SELF_CHECK = [
  '写完逐项自检，不过关就改到过关：',
  '- 原稿一个字节都没动；',
  '- 数字、日期、专有名词、表格数据和原稿逐项一致，没有新增原稿里没有的事实；',
  '- 删掉的依据引用都集中到了文末「编制依据」；',
  '- front-matter 字段齐全且扁平（source / source_sha / version / based_on / notes / rules_version / created / body_sha / hits / note），',
  '  `body_sha` 是写完之后按技能里的算法算的；',
  '- `hits` 里只有启用的规则。',
];

/** 「给这份文档去 AI 味」。sourcePath 为空时让 AI 先问要处理哪一份。 */
export function deaiPrompt({
  sourcePath,
  rulesVersion,
  nextPath,
  installed = true,
}: {
  sourcePath?: string;
  rulesVersion?: number;
  /** 已知下一版的路径时直接给；不知道就给目录，让 AI 取最大序号加一 */
  nextPath?: string;
  installed?: boolean;
}): string {
  const head = installed ? [] : [installSkillPrompt(), '', '补齐之后再做下面的事。', ''];
  const target = sourcePath
    ? nextPath
      ? `\`${nextPath}\``
      : `\`${deliveryDirOf(sourcePath)}/\` 下的下一版（\`v<三位序号>.md\`，取已有最大序号加一，不覆盖已有版本）`
    : '`output/delivery/<原稿在 output 下的相对路径去掉 .md>/v<下一个序号>.md`';
  return [
    ...head,
    sourcePath
      ? `请按技能 pm-deai-writing 的「去味」给 \`${sourcePath}\` 去 AI 味，写出一版交付稿。`
      : '请按技能 pm-deai-writing 的「去味」给一份文档去 AI 味。先问我要处理 output/ 下的哪一份，再动手。',
    '',
    `- 规则库：\`${RULES_PATH}\`${rulesVersion ? `（当前 v${rulesVersion}）` : ''}，只用状态为「启用」的规则；`,
    `- 交付稿写到 ${target}；`,
    '- **不改原稿**；事实、数字、专有名词、表格数据不变，只改说法；',
    '- 依据引用集中到文末「编制依据」一节，正文只陈述结论；',
    '- 逐条记下命中了哪些规则、各改了几处，写进 `hits`。',
    '',
    ...SELF_CHECK,
    '',
    '最后告诉我交付稿在哪、命中最多的几条规则、有没有拿不准没改的地方。转 Word 时选交付稿，不要选原稿。',
  ].join('\n');
}

/** 「规则库体检」：只给建议，不改规则库。 */
export function checkupPrompt({ rulesVersion, installed = true }: { rulesVersion?: number; installed?: boolean }): string {
  const head = installed ? [] : [installSkillPrompt(), '', '补齐之后再做下面的事。', ''];
  return [
    ...head,
    `请按技能 pm-deai-writing 的「体检」检查规则库 \`${RULES_PATH}\`${rulesVersion ? `（当前 v${rulesVersion}）` : ''}：`,
    '',
    '1. 找意思重复的规则、互相冲突的规则、判据太宽会误伤的规则；',
    '2. 扫 `output/delivery/` 下所有交付稿的 `hits`，汇总每条规则的命中次数，列出长期零命中的规则；',
    '3. 给一份建议清单，每条写「建议停用 / 合并 / 改判据 R0xx：理由」。',
    '',
    '**只给建议，不要改规则库。** 我确认之后再按技能「规则库怎么改」执行（版本加一、写快照和 CHANGELOG，来源写「体检」）。',
  ].join('\n');
}

/**
 * 交付稿上的批注：接在通用批注提示词后面的附加段。
 * 通用那段说的是「改这个文件」，这里改成「以它为底改出下一版，它本身不动」，并要求同一轮同步沉淀。
 */
export function deliveryNotesAddon({
  file,
  version,
  nextPath,
  rulesVersion,
}: {
  file: string;
  version: string;
  nextPath: string;
  rulesVersion?: number;
}): string {
  return [
    `## 这批批注针对的是交付稿 ${version}（\`${file}\`）`,
    '',
    '按技能 pm-deai-writing 的「批注修订与同步沉淀」处理，**同一轮里做完**：',
    '',
    `1. **不要改 \`${file}\` 本身**：以它为底，按批注改出下一版 \`${nextPath}\`。`,
    `   front-matter 的 \`based_on\` 写 \`${version}\`，\`notes\` 列出本版处理的批注 N 编号，\`rules_version\` 写改完后规则库的版本。`,
    '2. 逐条判断：只关乎这份文档内容的更正 → 只改交付稿；可推广的写法偏好（换一份文档这条意见还成立）→ 同时沉淀进规则库',
    `   \`${RULES_PATH}\`${rulesVersion ? `（当前 v${rulesVersion}）` : ''}：新增规则，或给已有规则补反例 / 正例 / 判据。拿不准的不沉淀。`,
    '3. 这一批有沉淀时，规则库**只升一个版本**：`version` 加一，全文另存 `rules/history/v<新版本>.md`，',
    '   `CHANGELOG.md` 顶部追加一节，来源写这批批注的 N 编号。一条都没沉淀，规则库不动。',
    '4. 回写批注时，沉淀过的那条在回执末尾加标记，格式严格是：`沉淀为 R<三位编号>（规则库 v<版本>）`，',
    '   例如 `- 回执：已删掉段尾总结。沉淀为 R014（规则库 v4）`。没沉淀的不要写「沉淀为」；`rejected` 仍然要写原因。',
    `5. 如果 \`${file}\` 的正文和它的 \`body_sha\` 对不上（被人直接改过），先提醒我，然后以当前文件为底继续，不从直接改动里归纳规则。`,
    '',
    ...SELF_CHECK.map((line) => line.replace('原稿一个字节都没动', `原稿和 ${version} 都没动`)),
    '- 每条批注都回写了状态；沉淀的规则编号与回执里的标记对得上。',
  ].join('\n');
}
