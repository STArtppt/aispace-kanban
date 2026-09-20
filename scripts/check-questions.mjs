#!/usr/bin/env node
/**
 * 未决问题字段契约的回归：拿 `fixtures/questions/` 的合成语料跑
 * `templates/pm-aispace/scripts/check_questions.py`，两头都要对。
 *
 * 为什么两头都要跑：只跑合法语料，校验脚本退化成「什么都不查」也是绿的。
 * 非法语料这一半才是真正的断言 —— 每一类非法组合都必须**恰好**被检出一条。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = resolve(ROOT, 'templates/pm-aispace/scripts/check_questions.py');

/** 每一条都对应 fixtures/questions/invalid/ 里的一份合成件，改语料要同步改这里。 */
const EXPECTED_BAD = [
  ['Q9001.md', '我方推断` 不能关闭问题'],
  ['Q9002.md', '缺必填字段 `asked_of`'],
  ['Q9002.md', '缺必填字段 `source`'],
  ['Q9003.md', '`human_answer: ask` 必须填 `due`'],
  ['Q9004.md', '不在枚举内'],
  ['Q9005.md', '不在四值内'],
  ['Q9006.md', '却没写 `evidence`'],
  ['Q9007.md', '与文件名'],
  ['Q9008.md', '不是 YYYY-MM-DD'],
  ['Q9009.md', '没有 front-matter'],
  ['Q9010.md', '不在四值内'],
];

function run(dir) {
  const out = spawnSync('python3', [CHECKER, resolve(ROOT, dir), '--json'], { encoding: 'utf8' });
  if (out.error) {
    console.error(`跑不起来 python3：${out.error.message}`);
    process.exit(1);
  }
  if (!out.stdout.trim()) {
    console.error(`校验脚本没有输出。stderr：\n${out.stderr}`);
    process.exit(1);
  }
  return JSON.parse(out.stdout);
}

let failed = 0;
const bad = (msg) => {
  console.error(`✗ ${msg}`);
  failed += 1;
};

const valid = run('fixtures/questions/valid');
if (!valid.ok) {
  bad('合法语料被判为有错：');
  for (const e of valid.errors) console.error(`    ${e.file}  ${e.message}`);
} else {
  console.log(`✓ 合法语料 ${valid.checked} 份，零错误`);
}

const invalid = run('fixtures/questions/invalid');
if (invalid.ok) {
  bad('非法语料全部通过了校验 —— 校验脚本已经形同虚设');
} else {
  const left = [...invalid.errors];
  for (const [file, needle] of EXPECTED_BAD) {
    const i = left.findIndex((e) => e.file === file && e.message.includes(needle));
    if (i === -1) bad(`没检出：${file} —— ${needle}`);
    else left.splice(i, 1);
  }
  for (const e of left) bad(`多检出一条没预期的：${e.file}  ${e.message}`);
  if (!failed) console.log(`✓ 非法语料 ${invalid.checked} 份，${EXPECTED_BAD.length} 类非法组合全部检出`);
}

if (failed) {
  console.error(`\n${failed} 项不符。`);
  process.exit(1);
}
console.log('未决问题字段契约回归通过。');
