/**
 * 「复制提示词」：把转 Word / 提炼模板交给工作空间 AI 执行时粘过去的那段话。
 * 只写剪贴板，不发任何写请求 —— pandoc 缺失、非环回监听、脚本缺失时这条路照样可用。
 *
 * 命令与规则的口径以工作空间 `scripts/md2docx.py` / `scripts/docx_template.py` 的文件头为准，
 * 那边改了参数这里要跟着改。
 */

export const BASE_TEMPLATE = '@base';

/** 旧工作空间没有工具链时，先让 AI 把脚本补齐。看板不替用户复制脚本（那等于看板在写工作空间）。 */
const INSTALL_SCRIPTS = [
  '这个工作空间还没有 docx 工具链。先从 aispace-kanban 仓库的工作空间模板补齐脚本：',
  '把 `templates/pm-aispace/scripts/` 下的 `docx_template.py`、`md2docx.py` 和整个 `docxkit/` 目录',
  '复制到本工作空间的 `scripts/` 下（源码在 https://github.com/STArtppt/aispace-kanban ，',
  '路径 `templates/pm-aispace/scripts/`；只复制这三样，别的文件不要动）。补齐后再执行下面的步骤。',
].join('\n');

function templateLabel(template: string): string {
  return template === BASE_TEMPLATE ? '通用规范（@base）' : `客户模板「${template}」（output/docx-template/${template}/）`;
}

export function convertPrompt({
  mdPath,
  template,
  scriptsMissing = false,
}: {
  /** 来源 .md 的工作空间相对路径 */
  mdPath: string;
  template: string;
  scriptsMissing?: boolean;
}): string {
  const target = mdPath.replace(/\.md$/i, '.docx');
  const spec = template === BASE_TEMPLATE
    ? '通用规范的样式清单在 `scripts/docxkit/base-spec.json`'
    : `这个模板的写作规定在 \`output/docx-template/${template}/spec.md\`，转换前先对照它检查 md 的写法`;
  return [
    `请把 \`${mdPath}\` 按${templateLabel(template)}转成 Word。`,
    '',
    ...(scriptsMissing ? [INSTALL_SCRIPTS, ''] : []),
    '步骤：',
    `1. ${spec}（开头唯一的 \`#\` 是文档标题、\`##\` 起是一级标题；手写编号、\`> [!note]\` 批注块、句中加粗转换时会自动处理；`,
    '   表题用 `Table: 表 N 标题` 写在表格下方一行、图题写在 `![图 N 标题](路径)` 的方括号里）。',
    '   模板带封面时，文档类型等封面信息可以写在 md 的 front-matter（`doctype:`、`client:`）；转换结果里有「【待填：…】」就补上再转。',
    `   需要改写法就改 \`${mdPath}\`，只改格式写法，不改内容。`,
    '2. 在工作空间根目录执行：',
    '',
    '```bash',
    `python3 scripts/md2docx.py "${mdPath}" --template ${template}`,
    '```',
    '',
    `3. 成品是同目录的 \`${target}\`。同名文件已存在时：`,
    '   - 它是上次转换生成的（带生成标记）→ 确认可以丢掉在 Word 里对它做过的修改后，加 `--overwrite` 重跑；',
    '   - 它不是本工具生成的（人手改过另存的、客户给的原件）→ 脚本会拒绝，**不要删它**，先问我怎么处理。',
    '4. 转换后检查：标题编号连续、没有双重编号；表格有边框、表头加粗、表题在表格上方；图片都在、图题在图下方；',
    '   脚本输出里的「注意」（warnings）为空 —— 有缺图等提示就先修 md 再转。',
    '',
    '需要 pandoc 3 以上；找不到时脚本会说明怎么装，装好后重跑即可。',
    '不要改 `input/`、`project.yaml` 和 `output/` 下别的文件。',
  ].join('\n');
}

export function refinePrompt({
  sourcePath,
  name,
  scriptsMissing = false,
}: {
  /** 来源 .docx 的工作空间相对路径（input/raw/ 下） */
  sourcePath: string;
  name: string;
  scriptsMissing?: boolean;
}): string {
  return [
    `请用 \`${sourcePath}\` 提炼一个 Word 模板，模板名「${name}」。`,
    '',
    ...(scriptsMissing ? [INSTALL_SCRIPTS, ''] : []),
    '步骤：',
    '1. 采集（报告不含正文）：',
    '',
    '```bash',
    `python3 scripts/docx_template.py collect "${sourcePath}" --name "${name}"`,
    '```',
    '',
    `2. 读 \`output/docx-template/${name}/collect/report.json\` 的 \`clusters\`（格式簇）和 \`outline\`（大纲），`,
    '   把你打算怎么映射（哪个簇当正文、各级标题、题注，哪些丢弃，同一角色格式不一致时取哪个值）列给我确认。',
    '   决定的写法见 `scripts/docxkit/decisions.py` 文件头；不写的簇采用报告里的 suggestedRole。',
    '   报告里 `front` 不为空（旧文档有封面、签署页、目录）时，也把前置区列给我确认：封面每一段标成',
    '   标题 / 客户单位 / 编制单位 / 日期 / 文档类型 / 保持原样，每张表选清空规则，写进决定的 `front` 键；不要前置区就写 `{"disabled": true}`。',
    '3. 我确认后把决定写成 JSON，生成模板：',
    '',
    '```bash',
    `python3 scripts/docx_template.py build --name "${name}" --source "${sourcePath}" --decisions 决定.json`,
    '```',
    '',
    `4. 生成物在 \`output/docx-template/${name}/\`：profile.json、reference.docx、spec.md、sample.docx，有前置区时还有 front.docx。`,
    '   脚本输出里的「注意」（warnings）为空才算样张各角色格式与规范一致；不为空就把差异告诉我。',
    '   决定 JSON 用完即删，不要留在工作空间里。',
    '',
    '模板名已存在时要加 `--regenerate` 才会覆盖，先问我。',
    '这个目录里是客户的版式材料，不要贴进反馈单或任何公开的地方。',
  ].join('\n');
}
