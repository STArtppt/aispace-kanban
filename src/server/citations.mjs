/**
 * 从产出文档正文里反查两件事，都是纯文本分析，不读盘也不写盘：
 *
 *   1. 引用关系 —— 哪些输入资料被产出提到过。反过来就能看出「转换好了、
 *      但没有任何产出用到」的资料，这是和 AI 反复对话时最隐蔽的一种缺口：
 *      资料明明在目录里，AI 却从没读进去，而你以为它读了。
 *   2. 标注计数 —— 正文里 `[推断]` / `[口述待确认]` / `[空白]` 各有多少条。
 *
 * 两套标记的约定都来自 templates/pm-aispace 的 pm-project-handover 技能（「逐条标注来源等级」），
 * 不是本仓自己发明的写法。
 */

/**
 * 去掉围栏代码块和行内代码再统计。
 * 模板和技能里演示标注格式时，写的是带反引号的 `[推断]`；PRD 模板被抄进 output/ 之后，
 * 那行图例会被算成一条真标注 —— 统计前先把代码剥掉，免得凭空多出几处。
 */
function stripCode(body) {
  return body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

const MARKS = [
  ['inferred', /\[推断\]/g],
  ['verbal', /\[口述待确认\]/g],
  ['blank', /\[空白\]/g],
];

/**
 * 正文里的标注计数。total 为 0 时调用方不必把它写进 JSON —— 界面上「没有标注」
 * 和「旧服务进程没这个字段」的渲染结果一样，都是什么都不显示。
 */
export function countAnnotations(body) {
  const text = stripCode(body);
  const out = { inferred: 0, verbal: 0, blank: 0, total: 0 };
  for (const [key, re] of MARKS) {
    out[key] = (text.match(re) || []).length;
    out.total += out[key];
  }
  return out;
}

/**
 * 一份转换产物在产出正文里可能被写成的几种样子。
 * 溯源约定要求写完整路径（`（来源：input/converted/需求规格.md，"3.2 计费规则"）`），
 * 但实际产出里常简写成文件名、甚至去掉扩展名（`（来源：需求规格 §4.2）`）—— 都得认。
 */
function aliasesOf(item) {
  const stem = item.name.replace(/\.[^.]+$/, '');
  const all = [item.path, item.name, stem];
  // 一两个字符的别名（如 `1`）会命中正文里任何地方，宁可不认这一个别名
  return [...new Set(all.filter((s) => s && s.length >= 2))];
}

/**
 * 反查引用，返回 Map，键是转换产物路径，值是引用了它的产出文档路径。
 *
 * 判定**故意放宽**：完整路径、文件名、去掉扩展名的名字，任一命中就算引用。
 * 因为两种误判的代价不对称 —— 漏判成「引用了」只是少提示一句，
 * 错判成「没被引用」却是在拿一个假缺口让人去查。放宽的方向是少报，不是错报。
 *
 * 这里不剥代码块 —— 产出里用 SQL 或命令行提到某份产物（如查 `测点.sqlite`），
 * 同样说明它被用上了。
 */
export function linkReferences(convertedItems, docs) {
  const targets = convertedItems.map((item) => ({ path: item.path, aliases: aliasesOf(item) }));
  const map = new Map(targets.map((t) => [t.path, []]));
  for (const doc of docs) {
    for (const target of targets) {
      if (target.aliases.some((alias) => doc.text.includes(alias))) {
        map.get(target.path).push(doc.path);
      }
    }
  }
  return map;
}
