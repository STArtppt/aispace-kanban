import type {
  DocxCluster,
  DocxClusterDecision,
  DocxCollectReport,
  DocxDecisions,
  DocxFmt,
  DocxFrontReport,
  DocxFrontRole,
  DocxTableRule,
} from '@/lib/api';
import { ROLE_LABEL, ROLE_MD, ROLES } from '@/components/templateRefine/roles';

/**
 * 第 ③ 步的冲突、第 ④ 步的文字规定预览，要随用户的决定实时变，只能在前端算一份。
 * **口径以工作空间 `scripts/docxkit/decisions.py` 为准**（role_map / prop_values / plan），
 * 这里是它的镜像：改那边的取值规则要同步改这里，否则界面上预选的值会被脚本以「不在采集到的取值里」拒绝。
 */

export type PropKey = 'eastAsia' | 'ascii' | 'size' | 'bold' | 'jc' | 'firstLineChars' | 'leftChars' | 'before' | 'after' | 'line';
export type PropValue = string | number | boolean;

const PROPS: PropKey[] = ['eastAsia', 'ascii', 'size', 'bold', 'jc', 'firstLineChars', 'leftChars', 'before', 'after', 'line'];

/** 表格内文字只取字号与行距（表头加粗、列对齐由表格样式和 md 分隔行决定） */
export const propsOf = (role: string): PropKey[] => (role === 'Table' ? ['size', 'line'] : PROPS);

export const PROP_LABEL: Record<PropKey, string> = {
  eastAsia: '中文字体',
  ascii: '西文字体',
  size: '字号',
  bold: '加粗',
  jc: '对齐',
  firstLineChars: '首行缩进',
  leftChars: '左缩进',
  before: '段前',
  after: '段后',
  line: '行距',
};

const JC_LABEL: Record<string, string> = { left: '左对齐', center: '居中', both: '两端对齐', right: '右对齐' };

export function formatValue(prop: PropKey, value: PropValue | null | undefined): string {
  if (value === null || value === undefined) return '—';
  switch (prop) {
    case 'size':
    case 'before':
    case 'after':
      return `${value}pt`;
    case 'bold':
      return value ? '加粗' : '不加粗';
    case 'jc':
      return JC_LABEL[String(value)] || String(value);
    case 'firstLineChars':
    case 'leftChars':
      return Number(value) ? `${value} 字符` : '无';
    case 'line':
      return typeof value === 'string' ? `固定 ${value}` : `${value} 倍`;
    default:
      return String(value);
  }
}

const halfUp = (x: number) => Math.floor(x * 2 + 0.5) / 2;
const round2 = (x: number) => Math.round(x * 100) / 100;
// Python 的 f"{v:g}"：去掉多余的 0
const g = (x: number) => String(Number(x.toPrecision(6)));

function chars(v: number | null, pt: number | null, size: number | null): number {
  if (v !== null && v !== undefined) return v;
  if (pt !== null && pt !== undefined && size) return halfUp(pt / size);
  return 0;
}

/** 格式簇的生效格式 → 规范口径的属性值（decisions.py 的 prop_values） */
export function propValues(fmt: DocxFmt): Record<PropKey, PropValue | null> {
  const before = fmt.beforeLines !== null && fmt.beforeLines !== undefined ? fmt.beforeLines * 12 : fmt.before ?? 0;
  const after = fmt.afterLines !== null && fmt.afterLines !== undefined ? fmt.afterLines * 12 : fmt.after ?? 0;
  let line: PropValue;
  if (fmt.lineExact !== null && fmt.lineExact !== undefined) line = `${g(fmt.lineExact)}pt`;
  else if (fmt.lineAtLeast !== null && fmt.lineAtLeast !== undefined) line = `${g(fmt.lineAtLeast)}pt`;
  else line = fmt.line || 1;
  return {
    eastAsia: fmt.eastAsia,
    ascii: fmt.ascii,
    size: fmt.size,
    bold: Boolean(fmt.bold),
    jc: fmt.jc || 'left',
    firstLineChars: fmt.hanging ? 0 : chars(fmt.firstLineChars, fmt.firstLinePt, fmt.size),
    leftChars: chars(fmt.leftChars, fmt.leftPt, fmt.size),
    before: round2(before),
    after: round2(after),
    line,
  };
}

/** 簇 id → 角色（null = 丢弃）。merge 沿链找到最终的簇，成环当丢弃。 */
export function roleMap(report: DocxCollectReport, decisions: Record<string, DocxClusterDecision>) {
  const byId = new Map(report.clusters.map((c) => [c.id, c]));
  const out: Record<string, string | null> = {};
  for (const c of report.clusters) {
    const seen = new Set<string>();
    let cur = c.id;
    for (;;) {
      const d = decisions[cur];
      if (!d) {
        out[c.id] = byId.get(cur)?.suggestedRole ?? null;
        break;
      }
      if ('role' in d) {
        out[c.id] = d.role;
        break;
      }
      if ('drop' in d || seen.has(cur)) {
        out[c.id] = null;
        break;
      }
      seen.add(cur);
      cur = d.merge;
    }
  }
  return out;
}

export interface RoleConflict {
  key: string;
  role: string;
  prop: PropKey;
  options: { value: PropValue; count: number }[];
  chosen: PropValue;
}

export interface RolePlan {
  role: string;
  clusters: DocxCluster[];
  count: number;
  props: Partial<Record<PropKey, PropValue>>;
  conflicts: RoleConflict[];
}

const sameValue = (a: PropValue, b: PropValue) =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 0.01 : a === b;

/** 按角色汇总（decisions.py 的 plan）：每个属性各取值的段数，选定值 = choices 里的，否则段数最多的。 */
export function planRoles(
  report: DocxCollectReport,
  decisions: Record<string, DocxClusterDecision>,
  choices: Record<string, PropValue>,
): RolePlan[] {
  const roles = roleMap(report, decisions);
  const groups = new Map<string, DocxCluster[]>();
  for (const c of report.clusters) {
    const r = roles[c.id];
    if (!r) continue;
    groups.set(r, [...(groups.get(r) ?? []), c]);
  }
  const out: RolePlan[] = [];
  for (const [role, clusters] of groups) {
    const props: RolePlan['props'] = {};
    const conflicts: RoleConflict[] = [];
    for (const prop of propsOf(role)) {
      const counts: { value: PropValue; count: number }[] = [];
      for (const c of clusters) {
        const v = propValues(c.fmt)[prop];
        if (v === null || v === undefined) continue;
        const hit = counts.find((x) => sameValue(x.value, v));
        if (hit) hit.count += c.count;
        else counts.push({ value: v, count: c.count });
      }
      if (!counts.length) continue;
      // 段数相同时保持首次出现的顺序（Python Counter.most_common 同样是稳定排序）
      counts.sort((a, b) => b.count - a.count);
      const key = `${role}.${prop}`;
      let chosen = counts[0].value;
      if (counts.length > 1) {
        const want = choices[key];
        const hit = want === undefined ? undefined : counts.find((x) => sameValue(x.value, want));
        if (hit) chosen = hit.value;
        conflicts.push({ key, role, prop, options: counts, chosen });
      }
      props[prop] = chosen;
    }
    out.push({ role, clusters, count: clusters.reduce((n, c) => n + c.count, 0), props, conflicts });
  }
  const order = ROLES.map((r) => r.key as string);
  return out.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
}

/** 格式簇一行的简述（第 ② 步表格的「格式」列） */
export function describeProps(props: Partial<Record<PropKey, PropValue | null>>, keys: PropKey[] = PROPS): string {
  const parts: string[] = [];
  for (const k of keys) {
    const v = props[k];
    if (v === null || v === undefined) continue;
    if (k === 'bold' && !v) continue;
    if ((k === 'firstLineChars' || k === 'leftChars') && !Number(v)) continue;
    if ((k === 'before' || k === 'after') && !Number(v)) continue;
    parts.push(k === 'eastAsia' || k === 'ascii' ? String(v) : formatValue(k, v));
  }
  return parts.join('，');
}

/**
 * 第 ④ 步「生成前」的文字规定预览：客户旧文档里有的角色写出决定后的格式，其余标「由通用规范补齐」。
 * 真正落盘的 spec.md 由脚本按合并后的规范生成（数值会带上通用规范补齐的部分），这里只是提前看个大概。
 */
export function previewSpec(name: string, plans: RolePlan[], front?: FrontPlan | null): string {
  const have = new Map(plans.map((p) => [p.role, p]));
  const rows = ROLES.map((r) => {
    const p = have.get(r.key);
    return `| ${ROLE_MD[r.key]} | ${r.label}（${r.style}） | ${
      p ? describeProps(p.props, propsOf(r.key)) : '—'
    } | ${p ? `客户旧文档（${p.count} 段）` : '由通用规范补齐'} |`;
  });
  return [
    `# ${name || '未命名模板'} · 写作规定（预览）`,
    '',
    '> 按你在第 ②③ 步的决定推出来的。点「生成模板」后，脚本会写出正式的 `spec.md`（带上通用规范补齐的完整格式）。',
    '',
    '| Markdown | 角色 | 格式 | 来源 |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    '- 开头唯一的 `#` 是文档标题，`##` 起是一级标题；手写编号、`> [!note]`、句中加粗转换时会自动处理。',
    '- 表题写在表格下方一行 `Table: 表 N 标题`，成品里在表格上方；图题写在图片的方括号里。',
    '',
    ...previewFront(front),
  ].join('\n');
}

/* ---------- 前置区（第 ④ 步）：口径镜像 docxkit/decisions.py 的 _validate_front / front.py ---------- */

export const FRONT_ROLE_LABEL: Record<DocxFrontRole, string> = {
  title: '标题',
  client: '客户单位',
  vendor: '编制单位',
  date: '日期',
  doctype: '文档类型',
  keep: '保持原样',
};
export const FRONT_ROLES = Object.keys(FRONT_ROLE_LABEL) as DocxFrontRole[];

export const TABLE_RULE_LABEL: Record<DocxTableRule, string> = {
  keepHeader: '保留表头行，清空其余单元格',
  keepLabels: '保留首列标签，清空其余单元格',
  keepHeaderAndLabels: '保留首行和首列',
  keepAll: '原样保留',
};
export const TABLE_RULES = Object.keys(TABLE_RULE_LABEL) as DocxTableRule[];

/** 分节的默认名（decisions.py 的 SECTION_NAME） */
export const SECTION_NAME: Record<string, string> = {
  cover: '封面', signoff: '签署页', revisions: '版本跟踪表', toc: '目录', other: '其它',
};

/** 字段取值顺序（与 spec_md.py 的 FIELD_SOURCE 同一口径） */
const FIELD_SOURCE: Record<Exclude<DocxFrontRole, 'keep'>, string> = {
  title: 'front-matter 的 `title` → 开头唯一的 `#` 标题',
  client: 'front-matter 的 `client` → `project.yaml` 的 `identity.甲方`',
  vendor: 'front-matter 的 `vendor` → `project.yaml` 的 `identity.承建方`',
  date: 'front-matter 的 `date` → 转换当天（YYYY年M月）',
  doctype: 'front-matter 的 `doctype`（没有兜底，随文档而变）',
};

export interface FrontPlan {
  disabled: boolean;
  fields: Record<string, DocxFrontRole>;
  tables: Record<string, DocxTableRule>;
  sections: Record<string, string>;
}

/** 报告的猜测 → 第 ④ 步的初始决定（没写到的字段用 guess，没有 guess 就保持原样） */
export function initialFront(front: DocxFrontReport): FrontPlan {
  return {
    disabled: false,
    fields: Object.fromEntries(front.fields.map((f) => [f.id, f.guess ?? 'keep'])),
    tables: Object.fromEntries(front.tables.map((t) => [t.id, t.defaultRule])),
    sections: Object.fromEntries(front.sections.map((s) => [s.id, SECTION_NAME[s.guess] || '其它'])),
  };
}

/** 并进决定 JSON 的 `front` 键；报告里没有前置区时不带 */
export function frontDecision(plan: FrontPlan | null): DocxDecisions['front'] | undefined {
  if (!plan) return undefined;
  if (plan.disabled) return { disabled: true };
  // 名称留空的节不带：脚本按猜测补默认名（空串会被脚本当成不合法的名称拒绝）
  const sections = Object.fromEntries(
    Object.entries(plan.sections).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v),
  );
  return { fields: plan.fields, tables: plan.tables, sections };
}

function previewFront(plan?: FrontPlan | null): string[] {
  if (!plan || plan.disabled) return [];
  const roles = (Object.keys(FIELD_SOURCE) as Array<keyof typeof FIELD_SOURCE>)
    .filter((r) => Object.values(plan.fields).includes(r));
  const keeps = Object.values(plan.fields).filter((r) => r === 'keep').length;
  return [
    '## 封面字段取值',
    '',
    `前置区（${Object.values(plan.sections).join('、')}）原样放在正文前面，封面字段按下表取值；都取不到时成品里显示「【待填：…】」。`,
    '',
    '| 字段 | 取值顺序 |',
    '| --- | --- |',
    ...roles.map((r) => `| ${FRONT_ROLE_LABEL[r]} | ${FIELD_SOURCE[r]} |`),
    '',
    ...(keeps ? [`- 有 ${keeps} 段设成了「保持原样」：模板里的原文会出现在每一份成品里。`, ''] : []),
  ];
}

export const roleLabel = (role: string | null | undefined) => (role ? ROLE_LABEL[role] || role : '丢弃');
