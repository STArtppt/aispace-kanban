#!/usr/bin/env node
/**
 * 模板更新（`templates/pm-aispace/scripts/template_update.py`）与铺设（`templates/init_workspace.py`）的回归。
 *
 * 全部在系统临时目录里合成，不联网（一律 `--from`），不碰任何真实工作空间：
 *   1. 复制一份模板当 v1，用 init_workspace.py 铺一个工作空间 → lock 与禁写规则的断言；
 *   2. 复制 v1 改成 v2：新增、修改、删除文件，改 seedOnly；工作空间里也改两个文件；
 *   3. plan 六组逐项断言 → compare 三方对照 → 过期计划被拒 → apply → lock 断言；
 *   4. 冲突不落盘、--resolved 登记后转为「保留」、没有 lock 时按首次接入；
 *   5. 补规则开关在「旧版 deny + 用户 allow」上合并去重、重复运行结果一致。
 *
 * 为什么判定要这样逐项钉住：这套脚本出错的方式是「静默覆盖了用户的本地改动」，
 * 事后几乎发现不了。每一组都必须**恰好**是预期的那几个文件。
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'templates/pm-aispace');
const INIT = path.join(ROOT, 'templates/init_workspace.py');
const PY = process.platform === 'win32' ? 'python' : 'python3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'check-template-update-'));
const V1 = path.join(TMP, 'tpl-v1');
const V2 = path.join(TMP, 'tpl-v2');
const WS = path.join(TMP, 'ws');

let failed = 0;
const ok = (msg) => console.log(`✓ ${msg}`);
const bad = (msg) => {
  console.error(`✗ ${msg}`);
  failed += 1;
};
const check = (cond, msg) => (cond ? ok(msg) : bad(msg));

function copyTemplate(dst) {
  fs.cpSync(TEMPLATE, dst, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      if (['.DS_Store', '__pycache__'].includes(name)) return false;
      // 模板根的 skills 是软链接，铺设脚本会现建，这里不带
      return !(path.dirname(src) === TEMPLATE && name === 'skills');
    },
  });
}

function py(args, cwd = ROOT, env = process.env) {
  const out = spawnSync(PY, args, { cwd, encoding: 'utf8', env });
  if (out.error) {
    console.error(`跑不起来 ${PY}：${out.error.message}`);
    process.exit(1);
  }
  return out;
}

/** 跑工作空间里铺出来的那份 template_update.py —— 测的就是实例会用的那份。 */
function tu(...args) {
  const out = py([path.join(WS, 'scripts/template_update.py'), ...args, '--json'], WS);
  let data = null;
  try {
    data = JSON.parse(out.stdout);
  } catch {
    /* 下面按 null 处理 */
  }
  return { code: out.status, data, stderr: out.stderr };
}

const sha = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);
const lock = () => JSON.parse(fs.readFileSync(path.join(WS, '.aispace/template.lock.json'), 'utf8'));
const paths = (rows) => rows.map((r) => r.path).sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const append = (file, text) => fs.appendFileSync(file, text);

function expectGroups(plan, expected, label) {
  for (const [key, want] of Object.entries(expected)) {
    const got = paths(plan.groups[key]);
    check(same(got, [...want].sort()), `${label}：${key} 组 = [${want.join(', ')}]${same(got, [...want].sort()) ? '' : `，实际 [${got.join(', ')}]`}`);
  }
}

try {
  // ── 1. 铺设 ────────────────────────────────────────────────────────────
  copyTemplate(V1);
  const init = py([INIT, '--from', V1, '--name', '合成工作空间', '--path', WS, '--json']);
  if (init.status !== 0) {
    console.error(init.stderr);
    process.exit(1);
  }
  const lockText = fs.readFileSync(path.join(WS, '.aispace/template.lock.json'), 'utf8');
  const l0 = JSON.parse(lockText);
  check(l0.source === 'local:tpl-v1', `新建写了 lock，来源只记目录名（${l0.source}）`);
  check(!lockText.includes(TMP), 'lock 里没有工作空间或模板的绝对路径');
  const missing = Object.keys(l0.files).filter((rel) => !fs.existsSync(path.join(WS, rel)));
  check(missing.length === 0, `lock 里的 ${Object.keys(l0.files).length} 个文件都铺出来了${missing.length ? `，缺 ${missing.join(', ')}` : ''}`);
  check(!('template.yaml' in l0.files) && !Object.keys(l0.files).some((p) => p.startsWith('visualization/')), 'exclude 的文件没进 lock');
  check(!fs.existsSync(path.join(WS, 'AGENTS.local.md')), '模板不带 AGENTS.local.md');
  const settings = JSON.parse(fs.readFileSync(path.join(WS, '.claude/settings.local.json'), 'utf8'));
  const deny = settings.permissions?.deny ?? [];
  check(deny.some((r) => /\/templates\/\*\*\)$/.test(r)), '新建的禁写规则含 templates/');

  // ── 2. 造 v2，工作空间也改两处 ─────────────────────────────────────────
  copyTemplate(V2);
  fs.writeFileSync(path.join(V2, 'scripts/new_tool.py'), 'print("新工具")\n');
  append(path.join(V2, 'scripts/layout.py'), '\n# v2 修了一处\n');
  append(path.join(V2, 'README.md'), '\n模板 v2 加的一段。\n');
  fs.rmSync(path.join(V2, 'scripts/migrate_note_history.py'));
  append(path.join(V2, '.gitignore'), '\n# v2 新增的忽略项\n*.tmp\n');
  append(path.join(V2, '.claude/skills/pm-deai-writing/rules/rules.md'), '\n<!-- v2 规则库变化 -->\n');

  append(path.join(WS, 'README.md'), '\n工作空间自己加的一段。\n');
  append(path.join(WS, 'output/README.md'), '\n工作空间自己的说明。\n');
  const rulesBefore = sha(path.join(WS, '.claude/skills/pm-deai-writing/rules/rules.md'));
  const gitignoreBefore = sha(path.join(WS, '.gitignore'));

  // ── 3. plan ────────────────────────────────────────────────────────────
  const p1 = tu('plan', '--from', V2);
  check(p1.code === 0 && p1.data?.first_time === false, 'plan 成功，不是首次接入');
  expectGroups(
    p1.data,
    {
      add: ['scripts/new_tool.py'],
      overwrite: ['scripts/layout.py'],
      keep: ['output/README.md'],
      conflict: ['README.md'],
      deleted: ['scripts/migrate_note_history.py'],
      seed: ['.claude/skills/pm-deai-writing/rules/rules.md', '.gitignore'],
    },
    '第一次 plan',
  );
  check(p1.data.groups.seed.every((e) => e.diff && e.diff.includes('+')), 'seedOnly 组带 diff');

  // compare：没有 --base-from 时 lock 来源是本地目录名，取不回基线，给两方对照
  const c0 = tu('compare', '--plan', p1.data.plan_file);
  check(c0.code === 0 && c0.data.items[0]?.base === 'none' && c0.data.warnings.length > 0, 'compare：本地来源取不回基线时给 warning 和两方对照');
  const c1 = tu('compare', '--plan', p1.data.plan_file, '--base-from', V1);
  const item = c1.data?.items?.[0];
  check(
    c1.code === 0 && item?.base === 'exact' && item.diff_local.includes('工作空间自己加的一段') && item.diff_template.includes('模板 v2 加的一段'),
    'compare --base-from：基线哈希对得上，给出基线→工作空间、基线→模板新版两份 diff',
  );

  // 过期计划：出计划后手改一个要覆盖的文件
  const layout = path.join(WS, 'scripts/layout.py');
  const layoutOrig = fs.readFileSync(layout);
  append(layout, '\n# 用户手改\n');
  const stale = tu('apply', '--plan', p1.data.plan_file);
  check(stale.code === 2 && !fs.existsSync(path.join(WS, 'scripts/new_tool.py')), '计划过期时 apply 拒绝，一个文件都没写');
  fs.writeFileSync(layout, layoutOrig);

  // ── apply ──────────────────────────────────────────────────────────────
  const a1 = tu('apply', '--plan', p1.data.plan_file);
  check(a1.code === 0, 'apply 成功');
  check(sha(path.join(WS, 'scripts/new_tool.py')) === sha(path.join(V2, 'scripts/new_tool.py')), '新增文件已写入');
  check(sha(layout) === sha(path.join(V2, 'scripts/layout.py')), '没改过的文件已覆盖为新版');
  check(fs.readFileSync(path.join(WS, 'README.md'), 'utf8').includes('工作空间自己加的一段') && !fs.readFileSync(path.join(WS, 'README.md'), 'utf8').includes('<<<<<<<'), '冲突文件保持工作空间版，没写冲突标记');
  check(fs.readFileSync(path.join(WS, 'output/README.md'), 'utf8').includes('工作空间自己的说明'), '「保留」组没被覆盖');
  check(fs.existsSync(path.join(WS, 'scripts/migrate_note_history.py')), '模板删掉的文件没被删');
  check(sha(path.join(WS, '.claude/skills/pm-deai-writing/rules/rules.md')) === rulesBefore && sha(path.join(WS, '.gitignore')) === gitignoreBefore, 'seedOnly 文件一个字节没变');
  const l1 = lock();
  check(l1.source === 'local:tpl-v2', 'lock 来源更新为本次');
  check(l1.files['scripts/layout.py'] === sha(path.join(V2, 'scripts/layout.py')), 'lock：覆盖的文件记新版哈希');
  check(l1.files['README.md'] === l0.files['README.md'], 'lock：冲突文件的哈希没前移');
  check(!('scripts/migrate_note_history.py' in l1.files), 'lock：模板已删除的文件不再登记');

  const again = tu('apply', '--plan', p1.data.plan_file);
  check(again.code === 2, '同一份计划不能执行第二次');

  // ── 4. 冲突一直报，直到 --resolved ──────────────────────────────────────
  const p2 = tu('plan', '--from', V2);
  expectGroups(p2.data, { add: [], overwrite: [], conflict: ['README.md'], seed: [], deleted: [] }, '第二次 plan');
  const bogus = tu('apply', '--plan', p2.data.plan_file, '--resolved', 'scripts/layout.py');
  check(bogus.code === 2, '--resolved 只收冲突组里的文件');
  const r = tu('apply', '--plan', p2.data.plan_file, '--resolved', 'README.md');
  check(r.code === 0 && r.data.remaining.length === 0, '--resolved 登记成功');
  check(lock().files['README.md'] === sha(path.join(V2, 'README.md')), 'lock：登记的是模板这一版的哈希');
  const p3 = tu('plan', '--from', V2);
  expectGroups(p3.data, { conflict: [], keep: ['README.md', 'output/README.md'] }, '登记后再 plan');

  // ── 首次接入：删掉 lock ────────────────────────────────────────────────
  fs.rmSync(path.join(WS, '.aispace'), { recursive: true });
  const p4 = tu('plan', '--from', V2);
  check(p4.data?.first_time === true, '没有 lock 时标首次接入');
  expectGroups(p4.data, { add: [], overwrite: [], keep: [], conflict: ['README.md', 'output/README.md'], deleted: [] }, '首次接入');
  const a4 = tu('apply', '--plan', p4.data.plan_file);
  const l4 = lock();
  check(a4.code === 0 && a4.data.written.length === 0, '首次接入的 apply 不静默覆盖任何文件');
  check(!('README.md' in l4.files) && 'scripts/layout.py' in l4.files, '首次接入后 lock 只登记一致的文件，冲突的等 --resolved');

  // ── 网络不通：代理指向一个没人监听的端口，不真的联网 ────────────────────
  const snapshot = fs.readFileSync(path.join(WS, '.aispace/template.lock.json'), 'utf8');
  const offline = { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', NO_PROXY: '', no_proxy: '' };
  const net = py([path.join(WS, 'scripts/template_update.py'), 'plan'], WS, offline);
  check(
    net.status === 1 && net.stderr.includes('--from') && net.stderr.includes('代理')
      && fs.readFileSync(path.join(WS, '.aispace/template.lock.json'), 'utf8') === snapshot,
    '取不到 GitHub 时退出码 1，给出代理和 --from 两条出路，工作空间没变',
  );

  // ── 5. 补规则开关：旧版 deny + 用户 allow ──────────────────────────────
  const ws2 = path.join(TMP, 'ws-guard');
  fs.mkdirSync(path.join(ws2, '.claude'), { recursive: true });
  const oldDeny = deny.filter((rule) => !/\/templates\/\*\*\)$/.test(rule));
  const settingsPath = path.join(ws2, '.claude/settings.local.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'], deny: oldDeny }, model: 'x' }, null, 2));
  const g1 = py([INIT, '--guard-only', '--path', ws2, '--json']);
  const s1 = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  check(g1.status === 0 && JSON.parse(g1.stdout).guard === 1, '补规则开关只补上缺的那条 templates/');
  check(same(s1.permissions.allow, ['Bash(ls:*)']) && s1.model === 'x' && same(s1.permissions.deny.slice(0, oldDeny.length), oldDeny), '用户的 allow、其它字段、原有 deny 都没动');
  const before = fs.readFileSync(settingsPath, 'utf8');
  const g2 = py([INIT, '--guard-only', '--path', ws2, '--json']);
  check(g2.status === 0 && JSON.parse(g2.stdout).guard === 0 && fs.readFileSync(settingsPath, 'utf8') === before, '重复运行结果一致');
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n${failed} 项不符。`);
  process.exit(1);
}
console.log('\n模板更新回归通过。');
