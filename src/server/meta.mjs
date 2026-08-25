/**
 * 解析工作空间根目录的 project.yaml，并算出「还缺什么」。
 *
 * 约定见 templates/pm-aispace/AGENTS.md：
 *   null / [] / {} = 该有但资料里还没有 → 缺口
 *   provenance     = 字段点号路径 → 来源文件和小节
 *   confidence     = 推断 / 口述待确认
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

// 这几个键是元数据本身，不参与完整度计算
const SKIP_KEYS = new Set(['schema', 'provenance', 'confidence']);

function isEmpty(value) {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * 递归走一遍元信息，只统计**叶子**字段：容器（identity、background 这些）
 * 本身不算数，否则完整度会被撑虚。
 * 空容器算一个缺口；非空容器继续下钻，让 milestones[0].验收方式 这种缺口也能暴露出来。
 */
function walk(node, prefix, filled, missing) {
  const entries = Array.isArray(node)
    ? node.map((item, i) => [`${prefix}[${i}]`, item])
    : Object.entries(node)
        .filter(([key]) => prefix || !SKIP_KEYS.has(key))
        .map(([key, value]) => [prefix ? `${prefix}.${key}` : key, value]);

  for (const [dotted, value] of entries) {
    if (isEmpty(value)) {
      missing.push(dotted);
    } else if (value && typeof value === 'object') {
      walk(value, dotted, filled, missing);
    } else {
      filled.push(dotted);
    }
  }
}

export function readMeta(root) {
  let file = '';
  for (const name of ['project.yaml', 'project.yml']) {
    const abs = path.join(root, name);
    if (fs.existsSync(abs)) {
      file = abs;
      break;
    }
  }
  if (!file) {
    return { exists: false, path: '', raw: '', data: null, missing: [], filled: [], stats: null };
  }

  const raw = fs.readFileSync(file, 'utf8');
  const stats = fs.statSync(file);
  let data = null;
  let error = '';
  try {
    data = YAML.parse(raw);
  } catch (err) {
    error = `project.yaml 解析失败：${err.message}`;
  }

  const filled = [];
  const missing = [];
  if (data && typeof data === 'object') walk(data, '', filled, missing);

  const total = filled.length + missing.length;
  return {
    exists: true,
    path: path.relative(root, file),
    raw,
    data,
    error,
    missing,
    filled,
    provenance: (data && data.provenance) || {},
    confidence: (data && data.confidence) || {},
    mtime: stats.mtime.toISOString(),
    stats: {
      filled: filled.length,
      missing: missing.length,
      total,
      completeness: total ? Math.round((filled.length / total) * 100) : 0,
    },
  };
}
