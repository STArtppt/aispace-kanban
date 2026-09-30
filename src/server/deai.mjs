/**
 * 去 AI 味：读规则库、列交付稿版本。**全部只读**。
 *
 * AGENTS.md 不变量 1：去 AI 味这条线看板不新增任何写入。交付稿、规则库、快照、CHANGELOG
 * 全由工作空间 AI 按技能 `pm-deai-writing` 写；改交付稿走「批注 → AI 修改 → 同步沉淀」，
 * 看板唯一的写入是批注落盘（notes.mjs，第六条第二种写入）。**别在这个模块里加写入。**
 *
 * 规则库在工作空间 `.claude/skills/pm-deai-writing/rules/`，不在 SSE 监听范围里（只监听 input/ output/ visualization/），
 * 前端在打开模块页时自己重新拉。
 *
 * 摘要算法与技能说明写成同一种（改一边要改另一边）：换行规范成 `\n`，SHA-256 十六进制前 16 位；
 * `source_sha` 算原稿全文，`body_sha` 算交付稿 front-matter 之后的正文。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.mjs';
import { findRecordByTarget, readNoteFile } from './notes.mjs';
import { resolveInside } from './paths.mjs';
import { scanRecords } from './records.mjs';
import { DELIVERY_FILE_RE, deliveryDirOf, deliveryOf, docKeyOf, findDocByKey } from './scan.mjs';

export const DEAI_SKILL_DIR = '.claude/skills/pm-deai-writing';
const RULES_DIR = `${DEAI_SKILL_DIR}/rules`;
const RULE_HEAD_RE = /^###[ \t]+(R\d{3})[ \t]+(.+?)[ \t]*$/;
const RULE_FIELD_RE = /^-[ \t]*(类别|状态|判据|反例|正例|改法|来源)[ \t]*[:：][ \t]*(.*)$/;
const FIELD_KEY = { 类别: 'category', 状态: 'status', 判据: 'criteria', 反例: 'bad', 正例: 'good', 改法: 'fix', 来源: 'source' };
const CATEGORIES = new Set(['引用', '强调', '结构', '措辞', '格式']);

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

function readText(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function normalize(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

function sha16(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** 交付稿正文：front-matter（`---` 到下一个 `---` 行）之后的全部内容。与技能里的 Python 片段同一口径 */
function bodyOf(text) {
  const m = /^---\n[\s\S]*?\n---\n/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/**
 * 解析规则库正文。认不出的条目跳过并记进 warnings，不让整个接口失败。
 * @param {string} text rules.md 或某份快照
 */
export function parseRules(text) {
  const rules = [];
  const warnings = [];
  let cur = null;
  const finish = () => {
    if (!cur) return;
    const missing = ['category', 'status'].filter((k) => !cur[k]);
    if (missing.length) {
      warnings.push(`${cur.id} 缺「${missing.map((k) => (k === 'category' ? '类别' : '状态')).join('、')}」，没有列出`);
    } else {
      if (!CATEGORIES.has(cur.category)) warnings.push(`${cur.id} 的类别「${cur.category}」不在五类里（引用 / 强调 / 结构 / 措辞 / 格式）`);
      cur.enabled = cur.status !== '停用';
      rules.push(cur);
    }
    cur = null;
  };
  for (const line of normalize(text).split('\n')) {
    const head = RULE_HEAD_RE.exec(line);
    if (head) {
      finish();
      cur = { id: head[1], name: head[2] };
      continue;
    }
    if (/^#{1,3}[ \t]/.test(line)) {
      finish();
      continue;
    }
    if (!cur) continue;
    const field = RULE_FIELD_RE.exec(line);
    if (field) cur[FIELD_KEY[field[1]]] = field[2].trim();
  }
  finish();
  const seen = new Set();
  for (const r of rules) {
    if (seen.has(r.id)) warnings.push(`编号 ${r.id} 出现了不止一次`);
    seen.add(r.id);
  }
  return { rules, warnings };
}

/**
 * 待处理批注落在交付稿上的那些版本：`[{ path, source, version, pending }]`。
 * 工作台「批注 → 修改 → 沉淀」卡片用它列出还没处理完的交付稿。
 */
function pendingDeliveries(root) {
  let items = [];
  try {
    items = scanRecords(root).items || [];
  } catch {
    return [];
  }
  const out = new Map();
  for (const item of items) {
    if (!item?.id) continue;
    const read = readNoteFile(root, item.id);
    for (const batch of read.batches || []) {
      const d = batch.target ? deliveryOf(batch.target) : null;
      if (!d?.original) continue;
      const n = batch.notes.filter((note) => !note.status || note.status === 'pending').length;
      if (!n) continue;
      const prev = out.get(batch.target);
      out.set(batch.target, {
        path: batch.target,
        source: d.original,
        version: d.version,
        recordId: item.id,
        pending: (prev?.pending || 0) + n,
      });
    }
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** GET deai/rules：当前规则库、历史版本清单、CHANGELOG 原文。技能没装时 `installed: false`、其余缺省。 */
export function readDeaiRules(root) {
  const skillAbs = resolveInside(root, DEAI_SKILL_DIR);
  if (!fs.existsSync(skillAbs)) return { installed: false };
  const warnings = [];
  const text = readText(resolveInside(root, `${RULES_DIR}/rules.md`));
  if (text === null) {
    return { installed: true, rules: [], versions: [], changelog: '', warnings: ['规则库 rules/rules.md 读不到'] };
  }
  const { meta, body } = parseFrontmatter(normalize(text));
  const version = /^\d+$/.test(String(meta.version || '')) ? Number(meta.version) : undefined;
  if (version === undefined) warnings.push('rules.md 的 front-matter 缺 version（正整数）');
  const parsed = parseRules(body);
  warnings.push(...parsed.warnings);

  const versions = [];
  const historyAbs = resolveInside(root, `${RULES_DIR}/history`);
  let entries = [];
  try {
    entries = fs.readdirSync(historyAbs, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const m = /^v(\d+)\.md$/.exec(entry.name);
    if (!m || !entry.isFile()) continue;
    let mtime = '';
    try {
      mtime = fs.statSync(path.join(historyAbs, entry.name)).mtime.toISOString();
    } catch {
      mtime = '';
    }
    versions.push({ version: Number(m[1]), mtime });
  }
  versions.sort((a, b) => b.version - a.version);
  if (version !== undefined && versions.length && !versions.some((v) => v.version === version)) {
    warnings.push(`history/ 里没有当前版本 v${version} 的快照`);
  }

  return {
    installed: true,
    ...(version !== undefined ? { version } : {}),
    ...(meta.updated ? { updated: String(meta.updated) } : {}),
    rules: parsed.rules,
    versions,
    changelog: readText(resolveInside(root, `${RULES_DIR}/CHANGELOG.md`)) ?? '',
    pendingDeliveries: pendingDeliveries(root),
    ...(warnings.length ? { warnings } : {}),
  };
}

/** GET deai/rules/versions/:n：某一版快照原文。`n` 必须是正整数，否则 400（在拼路径之前就拦）。 */
export function readDeaiRuleVersion(root, n) {
  if (typeof n !== 'string' || !/^[1-9]\d{0,5}$/.test(n)) {
    throw httpError(400, `版本号不合法：${String(n)}。只接受正整数。`);
  }
  const text = readText(resolveInside(root, `${RULES_DIR}/history/v${Number(n)}.md`));
  if (text === null) throw httpError(404, `规则库没有 v${Number(n)} 的快照。`);
  const { meta, body } = parseFrontmatter(normalize(text));
  return { version: Number(n), ...(meta.updated ? { updated: String(meta.updated) } : {}), text, rules: parseRules(body).rules };
}

function listField(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value || '').split(/[,，、\s]+/).map((v) => v.trim()).filter(Boolean);
}

/**
 * GET delivery?docKey=：某份原稿的交付稿版本。docKey 只在产出三组的 .md 里反查（交付稿的键换不来原稿）。
 * 每一版带两个判定：`sourceChanged`（原稿在这一版之后又改过）、`directlyEdited`（有人绕过批注直接改了这一版）。
 */
export function listDelivery(root, docKey) {
  const source = findDocByKey(root, 'output-md', docKey);
  if (!source) throw httpError(400, '在产出文档里找不到这份原稿（列表可能已经变了），刷新后再试。');
  const dir = deliveryDirOf(source);
  const out = { source, dir, versions: [] };
  if (!dir) return out;
  const dirAbs = resolveInside(root, dir);
  let entries = [];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return out;
  }
  const srcText = readText(resolveInside(root, source));
  const srcSha = srcText === null ? null : sha16(normalize(srcText));

  // 原稿记录的批注：数出每一版还有几条待处理
  const pending = new Map();
  const recordId = findRecordByTarget(root, source);
  if (recordId) {
    for (const batch of readNoteFile(root, recordId).batches || []) {
      if (!batch.target) continue;
      const n = batch.notes.filter((note) => !note.status || note.status === 'pending').length;
      pending.set(batch.target, (pending.get(batch.target) || 0) + n);
    }
  }

  for (const entry of entries) {
    if (!entry.isFile() || !DELIVERY_FILE_RE.test(entry.name)) continue;
    const rel = `${dir}/${entry.name}`;
    const text = readText(resolveInside(root, rel));
    if (text === null) continue;
    const norm = normalize(text);
    const { meta } = parseFrontmatter(norm);
    const version = entry.name.replace(/\.md$/, '');
    let mtime = '';
    try {
      mtime = fs.statSync(resolveInside(root, rel)).mtime.toISOString();
    } catch {
      mtime = '';
    }
    const item = {
      version,
      path: rel,
      docKey: docKeyOf(rel),
      mtime,
      created: meta.created ? String(meta.created) : '',
      basedOn: meta.based_on ? String(meta.based_on) : '',
      notes: listField(meta.notes),
      rulesVersion: /^\d+$/.test(String(meta.rules_version || '')) ? Number(meta.rules_version) : null,
      hits: typeof meta.hits === 'string' ? meta.hits : '',
      note: typeof meta.note === 'string' ? meta.note : '',
      // 缺摘要（手写的、旧格式的）不下结论：判定只在两边都有值时才成立
      sourceChanged: Boolean(meta.source_sha && srcSha && String(meta.source_sha) !== srcSha),
      directlyEdited: Boolean(meta.body_sha && String(meta.body_sha) !== sha16(bodyOf(norm))),
      pendingNotes: pending.get(rel) || 0,
    };
    out.versions.push(item);
  }
  out.versions.sort((a, b) => a.version.localeCompare(b.version));
  if (recordId) out.recordId = recordId;
  return out;
}
