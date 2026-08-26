#!/usr/bin/env node
/**
 * anydoc 的文档模型 → Markdown。**只重写渲染，不碰解析。**
 *
 * 为什么要有这个文件：anydoc 自带的 Writer 在 Rust 里，把嵌入图渲染成 alt 文本就把字节丢了
 * （README 明说 Markdown 装不下字节，字节留在 document.assets 上），而包的导出面是死的——
 * toDocument() 给模型不给 writer，toMarkdown() 给成品字符串图已经没了，中间没有接口。
 * 所以只能整段重写 Writer。好在解析那一半（OOXML / ODF / RTF 控制字 / EPUB 容器、
 * 样式继承、编号定义、WPS 方言）anydoc 已经做完，而且在真实语料上比 pandoc 准——
 * 那正是走这条路而不是装回 pandoc 的理由。
 *
 * 用法（由 scripts/anydoc.py 的 to_markdown_with_assets() spawn，不手工调）：
 *
 *     node scripts/anydoc_writer.mjs <src> \
 *       --anydoc-module <index.js 的绝对路径> \
 *       --assets-dir <图片落盘目录，绝对路径> \
 *       --link-prefix <正文里图片链接的前缀，已过 md_link()> \
 *       [--span=blank|fill]
 *
 *     stdout = Markdown 正文（不含 frontmatter）
 *     stderr = 诊断
 *     退出码 0 成功 / 1 转换失败 / 2 用法错
 *
 * 自己不装 @firecrawl/anydoc：从 --anydoc-module 侧载，跟 anydoc.py 的四级查找链共用
 * 同一个二进制，看板注入和终端直跑结果一致。
 *
 * **遇到不认识的节点一律降级成纯文本，不抛错**：anydoc 是 0.x，模型没有语义化保证，
 * 升级后冒出新 kind 是迟早的事。宁可少一层格式，也不能让整批转换断在一份文件上。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = 2;
const FAILED = 1;

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

/** 命令行参数。缺一个就是用法错，不猜默认值——这个 helper 只有一个调用方。 */
function parseArgv(argv) {
  const opts = { src: '', module: '', assetsDir: '', linkPrefix: '', span: 'blank' };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--anydoc-module') opts.module = argv[++i] ?? '';
    else if (arg === '--assets-dir') opts.assetsDir = argv[++i] ?? '';
    else if (arg === '--link-prefix') opts.linkPrefix = argv[++i] ?? '';
    else if (arg.startsWith('--span=')) opts.span = arg.slice('--span='.length);
    else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
    else rest.push(arg);
  }
  opts.src = rest[0] ?? '';
  if (!opts.src) throw new Error('缺少源文件');
  if (!opts.module) throw new Error('缺少 --anydoc-module');
  if (!opts.assetsDir) throw new Error('缺少 --assets-dir');
  if (!['blank', 'fill'].includes(opts.span)) throw new Error(`--span 只能是 blank / fill，收到 ${opts.span}`);
  return opts;
}

// ---------------------------------------------------------------------------
// 图片落盘
//
// 走文件不走管道：一份十几张图的 PRD 转成 data URI 就是十几 MB，
// 经 stdout 回 Python 等于把图片在内存里复制两遍。正文里只留路径。
// ---------------------------------------------------------------------------

/** mediaType → 扩展名。认不出来的一律 .bin：宁可存个怪扩展名，也不要丢字节。 */
const EXT_BY_TYPE = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/svg+xml': '.svg',
  'image/x-emf': '.emf',
  'image/x-wmf': '.wmf',
};

/**
 * 把 document.assets 全部写进 assetsDir，返回 assetId → 文件名 的映射。
 *
 * 命名用 `image<id>` 而不是原始部件名：originPart 来自源文档内部（word/media/image1.png），
 * 同名冲突和奇怪字符都得自己收拾，而 id 本来就是 Document.assets 的下标，天然唯一。
 */
async function writeAssets(assets, assetsDir) {
  const names = new Map();
  if (!assets.length) return names;
  await mkdir(assetsDir, { recursive: true });
  for (const asset of assets) {
    const ext = EXT_BY_TYPE[(asset.mediaType || '').toLowerCase()] ?? '.bin';
    const name = `image${asset.id}${ext}`;
    await writeFile(path.join(assetsDir, name), asset.data);
    names.set(asset.id, name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// 转义
//
// 最容易出隐蔽 bug 的一段。原则：只转义**在当前位置真的有语法含义**的字符——
// 见字就转会把中文正文里的下划线、括号全变成反斜杠，可读性当场归零。
// ---------------------------------------------------------------------------

/** 行内正文的转义。`code` 样式内部不走这里（见 renderStyled）。 */
function escapeText(text) {
  return text
    .replace(/([\\`*_[\]<>])/g, '\\$1')
    // & 只在像实体时才转义（`&amp;` `&#65;`），否则中文文档里的 & 会被无谓地打上反斜杠
    .replace(/&(?=[a-zA-Z]+;|#\d+;|#x[0-9a-fA-F]+;)/g, '\\&');
}

/**
 * 行首的转义。`#` `-` `+` `>` 和「数字+点/右括号」只有在行首才是块级语法，
 * 在句子中间转义纯属噪音，所以跟 escapeText 分开做。
 *
 * 逐行处理：一个 paragraph 里有 lineBreak 就会跨多行，只管第一行会漏掉后面的。
 */
function escapeLineStart(text) {
  return text
    .split('\n')
    .map((line) => line
      .replace(/^(\s*)([#\-+>])/, '$1\\$2')
      .replace(/^(\s*)(\d+)([.)])/, '$1$2\\$3'))
    .join('\n');
}

/**
 * 表格单元格：`|` 会切断列，换行会切断行——后者只能转成 `<br>`，GFM 没有别的表达
 * （pandoc 也是这么做的）。换行两侧的空白一并吃掉，否则会留下 lineBreak 的行尾双空格。
 */
function escapeCell(text) {
  return text.replace(/\|/g, '\\|').replace(/[ \t]*\n+[ \t]*/g, '<br>');
}

/**
 * 包反引号的行内代码。内容自带反引号时要用更长的围栏，
 * 首尾是反引号或空格还得垫一个空格——CommonMark 的老规矩，照做。
 */
function wrapCode(text) {
  const longest = (text.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') || /^\s|\s$/.test(text) ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

// ---------------------------------------------------------------------------
// 行内
// ---------------------------------------------------------------------------

/** 两个 Style 是不是一回事。undefined 与全 false 视作同一种「无样式」。 */
function sameStyle(a, b) {
  const norm = (s) => `${!!s?.bold}${!!s?.italic}${!!s?.strike}${!!s?.code}`;
  return norm(a) === norm(b);
}

/**
 * 把相邻的同样式 text 合并成一段再渲染。
 *
 * **不能省。** anydoc 读 RTF 时按控制字切 run，中文正文会被切成一字一个 Inline，
 * 逐个包裹就得到 `**合****成****回****归****件**` —— 既难读，CommonMark 也不保证
 * 把它当成一整段粗体。docx / odt 同样会因为拼写检查标记、修订痕迹把一句话切成几段。
 */
function coalesce(inlines) {
  const out = [];
  for (const inline of inlines ?? []) {
    const prev = out[out.length - 1];
    if (inline.kind === 'text' && prev?.kind === 'text' && sameStyle(prev.style, inline.style)) {
      out[out.length - 1] = { ...prev, text: (prev.text ?? '') + (inline.text ?? '') };
    } else {
      out.push(inline);
    }
  }
  return out;
}

/**
 * Style 的四个布尔值 → Markdown 包裹。code 最贴身：它内部不再转义也不再嵌套强调。
 *
 * 首尾空白要挪到标记外面：`** 粗体 **` 在 CommonMark 里根本不是强调，
 * 而 Word 的 run 经常把尾随空格一起带上，不处理就会整段丢格式。
 */
function renderStyled(text, style) {
  if (!text) return '';
  if (style?.code) return wrapCode(text);
  if (!style?.bold && !style?.italic && !style?.strike) return escapeText(text);
  const [, lead, core, tail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!core) return escapeText(text);
  let out = escapeText(core);
  if (style.strike) out = `~~${out}~~`;
  if (style.italic) out = `*${out}*`;
  if (style.bold) out = `**${out}**`;
  return `${lead}${out}${tail}`;
}

/** 链接目标。anchor 类的目标补上 `#`，relative / external 原样写。 */
function renderTarget(target) {
  if (!target) return '';
  const value = target.value ?? '';
  const href = target.kind === 'anchor' && !value.startsWith('#') ? `#${value}` : value;
  // 链接地址里的空格和括号会当场截断 `[](...)`，这里必须转义（图片前缀由 Python 侧的
  // md_link() 负责，两边规则一致）
  return href.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/**
 * 一串 Inline → Markdown。
 *
 * ctx 带 assetNames / linkPrefix / notes：图片和脚注引用要用到。
 * 认不出的 kind 掉进最后那个分支，吐 text 字段（有的话）而不是抛错。
 */
function renderInlines(inlines, ctx) {
  let out = '';
  for (const inline of coalesce(inlines)) {
    switch (inline.kind) {
      case 'text':
        out += renderStyled(inline.text ?? '', inline.style);
        break;
      case 'link': {
        const label = renderInlines(inline.content, ctx) || escapeText(inline.target?.value ?? '');
        const href = renderTarget(inline.target);
        out += href ? `[${label}](${href})` : label;
        break;
      }
      case 'image':
        out += renderImage(inline, ctx);
        break;
      case 'anchor':
        // 零宽标记。pandoc 会吐 <span id="..."></span>，正是本仓要甩掉的裸 HTML 噪音，
        // 所以这里什么都不写——链接指向它时用的是 anchor 值，不需要正文里有实体。
        break;
      case 'noteRef':
        out += `[^${inline.noteId}]`;
        ctx.usedNotes.add(inline.noteId);
        break;
      case 'lineBreak':
        // GFM 的硬换行：行尾两个空格。用 <br> 就又是裸 HTML 了。
        out += '  \n';
        break;
      case 'math':
        // 真实语料里一次都没出现过。先按 $...$ 落个降级实现，不影响上线。
        out += inline.text ? `$${inline.text}$` : '';
        break;
      case 'checkbox':
        out += inline.checked ? '[x]' : '[ ]';
        break;
      default:
        // 未知 kind：能吐字就吐字，不能就跳过。**不抛错**——见文件顶部。
        out += inline.text ? escapeText(inline.text) : '';
        break;
    }
  }
  return out;
}

/**
 * 图片。三种 source：
 *   asset      —— 已落盘，写 linkPrefix + 文件名
 *   external   —— 原样写 URL
 *   unavailable—— 部件缺失，只剩 alt。写成 `![alt]()` 只会得到一个坏链接，
 *                 所以退成纯文本，至少不骗人。
 */
function renderImage(inline, ctx) {
  const alt = escapeText(inline.alt ?? '');
  const source = inline.source;
  if (source?.kind === 'external' && source.url) return `![${alt}](${renderTarget({ value: source.url })})`;
  if (source?.kind === 'asset') {
    const name = ctx.assetNames.get(source.assetId);
    if (name) return `![${alt}](${ctx.linkPrefix}${name})`;
  }
  ctx.missingImages += 1;
  return alt;
}

// ---------------------------------------------------------------------------
// 块级
// ---------------------------------------------------------------------------

/** 一组 Block → 用空行隔开的 Markdown 段落序列。空块直接丢，不留多余空行。 */
function renderBlocks(blocks, ctx, indent = '') {
  const parts = [];
  for (const block of blocks ?? []) {
    const text = renderBlock(block, ctx, indent);
    if (text.trim()) parts.push(text);
  }
  return parts.join('\n\n');
}

function renderBlock(block, ctx, indent) {
  switch (block.kind) {
    case 'heading': {
      const level = Math.min(Math.max(block.level ?? 1, 1), 6);
      const text = renderInlines(block.content, ctx).replace(/\n+/g, ' ').trim();
      return text ? `${indent}${'#'.repeat(level)} ${text}` : '';
    }
    case 'paragraph': {
      const text = renderInlines(block.content, ctx);
      return text.trim() ? indentLines(escapeLineStart(text), indent) : '';
    }
    case 'blockQuote': {
      const inner = renderBlocks(block.blocks, ctx);
      return inner
        .split('\n')
        .map((line) => `${indent}> ${line}`.trimEnd())
        .join('\n');
    }
    case 'rule':
      return `${indent}---`;
    case 'codeBlock': {
      // 真实语料里没出现过，先落降级实现。围栏按内容里最长的一串反引号加长，
      // 否则源码里恰好有 ``` 会把代码块提前关掉。
      const text = block.text ?? '';
      const longest = (text.match(/`{3,}/g) ?? []).reduce((n, run) => Math.max(n, run.length), 2);
      const fence = '`'.repeat(longest + 1);
      return indentLines(`${fence}${block.lang ?? ''}\n${text}\n${fence}`, indent);
    }
    case 'math':
      return block.text ? indentLines(`$$\n${block.text}\n$$`, indent) : '';
    case 'list':
      return renderList(block.list, ctx, indent);
    case 'table':
      return renderTable(block.table, ctx, indent);
    default: {
      // 未知 kind：把能找到的内容尽量吐出来，**不抛错**。
      const text = renderInlines(block.content, ctx) || escapeText(block.text ?? '');
      const inner = block.blocks ? renderBlocks(block.blocks, ctx, indent) : '';
      ctx.unknownBlocks.add(block.kind);
      return [text ? indentLines(escapeLineStart(text), indent) : '', inner].filter(Boolean).join('\n\n');
    }
  }
}

/** 给多行文本整体加缩进。列表项内部的续行要对齐，否则会掉出列表。 */
function indentLines(text, indent) {
  if (!indent) return text;
  return text
    .split('\n')
    .map((line) => (line ? `${indent}${line}` : ''))
    .join('\n');
}

// ---------------------------------------------------------------------------
// 列表
//
// GFM 的有序列表只认阿拉伯数字。源文档里的 `1-a)`、`（3）`、`a)`、`iii.` 都表达不了，
// 而这些编号在规范类文档里常常被正文交叉引用（「见 3.1-a」），改掉就等于制造错误引用。
// 所以：数字和圆点走真列表，其余一律降级成**带缩进的段落序列**，编号原样写在行首。
// ---------------------------------------------------------------------------

/** 阿拉伯数字之外的 marker 家族，用来生成降级时写在行首的字面编号。 */
const ALPHA = 'abcdefghijklmnopqrstuvwxyz';
const ROMAN = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
  [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
];

function toRoman(n) {
  let rest = n;
  let out = '';
  for (const [value, sign] of ROMAN) {
    while (rest >= value) {
      out += sign;
      rest -= value;
    }
  }
  return out;
}

/** 第 n 项（从 1 数）在某个 marker 家族里的字面编号，不含标点。 */
function markerText(kind, n) {
  switch (kind) {
    case 'lowerAlpha': return ALPHA[(n - 1) % 26];
    case 'upperAlpha': return ALPHA[(n - 1) % 26].toUpperCase();
    case 'lowerRoman': return toRoman(n);
    case 'upperRoman': return toRoman(n).toUpperCase();
    default: return String(n);
  }
}

/**
 * 一个 List → Markdown。
 *
 * 两条路：
 *   真列表   —— bullet 走 `-`，decimal 走 `N.`，续行按 marker 宽度对齐
 *   降级段落 —— 只要出现 markerLabel，或者 marker 家族是字母 / 罗马数字，整个列表都走这条。
 *               **整个列表**一起降级，不混着来：半列表半段落读起来比全段落更糟。
 */
function renderList(list, ctx, indent) {
  const items = list?.items ?? [];
  if (!items.length) return '';
  const start = Number.isFinite(list.start) ? list.start : 1;
  const marker = list.marker ?? 'bullet';
  const degrade = marker !== 'bullet' && marker !== 'decimal';
  const hasLabel = items.some((item) => item.markerLabel);

  if (degrade || hasLabel) return renderDegradedList(list, ctx, indent, start, marker);

  const parts = [];
  items.forEach((item, i) => {
    const sign = marker === 'bullet' ? '-' : `${start + i}.`;
    // 续行缩进要对齐到内容列，否则第二段会掉出这一项
    const inner = renderBlocks(item.blocks, ctx, ' '.repeat(sign.length + 1));
    parts.push(`${indent}${sign} ${inner.trimStart()}`);
  });
  return parts.join('\n');
}

/**
 * 降级：每项是一个普通段落，字面编号写在行首并转义，防止被重新解析成列表。
 *
 * 缩进只加 2 空格且封顶 3 —— **不能到 4**：顶格 4 空格在 Markdown 里是缩进代码块，
 * 一份嵌套深一点的文档会整片变成代码。真实语料最深两层，2 空格足够表达层级。
 */
function renderDegradedList(list, ctx, indent, start, marker) {
  const step = indent.length >= 3 ? '' : '  ';
  const parts = [];
  (list.items ?? []).forEach((item, i) => {
    const label = item.markerLabel ?? `${markerText(marker, start + i)}.`;
    const inner = renderBlocks(item.blocks, ctx, indent + step);
    const [first, ...rest] = inner.split('\n');
    // label 里的 `.` `)` 会让「数字 + 标点」被当成有序列表，escapeLineStart 负责挡住
    const head = escapeLineStart(`${indent}${step}${label} ${first.trimStart()}`);
    parts.push([head, ...rest].join('\n'));
  });
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// 表格
//
// anydoc 给的是规范网格：每个格子恰好出现一次，跨行列的位置是 covered 槽回指 origin。
// GFM 没有 rowspan / colspan，只能拍平——被覆盖的格子**默认留空**。
// 复制 origin 的内容看着更「完整」，但会让下游把同一条统计两遍；一份采购规范里
// 两千多个 covered 格，翻倍的后果是实打实的。要另一种行为用 --span=fill。
// ---------------------------------------------------------------------------

/** 一个格子 → 单行文本。GFM 的格子装不下块结构，只能拍成一行。 */
function renderCell(blocks, ctx) {
  const text = renderBlocks(blocks, ctx).trim();
  return escapeCell(text);
}

function renderTable(table, ctx, indent) {
  const grid = table?.grid ?? [];
  if (!grid.length) return '';
  const width = grid.reduce((n, row) => Math.max(n, row.length), 0);
  if (!width) return '';

  const cells = grid.map((row) => {
    const out = [];
    for (let col = 0; col < width; col += 1) {
      const slot = row[col];
      if (slot?.kind === 'origin') {
        out.push(renderCell(slot.cell?.blocks, ctx));
      } else if (slot?.kind === 'covered' && ctx.span === 'fill') {
        const origin = grid[slot.originRow]?.[slot.originCol];
        out.push(origin?.kind === 'origin' ? renderCell(origin.cell?.blocks, ctx) : '');
      } else {
        // covered（默认）、越界补齐、以及未知 slot 类型，都留空
        out.push('');
      }
    }
    return out;
  });

  // GFM 表格必须有表头。headerRows 为 0 时补一行空表头——这也是 pandoc 的做法；
  // headerRows > 1 时只有第一行当表头，其余降成正文行（GFM 表达不了多行表头）。
  const hasHeader = (table.headerRows ?? 0) > 0;
  const header = hasHeader ? cells[0] : new Array(width).fill('');
  const body = hasHeader ? cells.slice(1) : cells;

  const line = (row) => `${indent}| ${row.join(' | ')} |`;
  return [line(header), line(new Array(width).fill('---')), ...body.map(line)].join('\n');
}

// ---------------------------------------------------------------------------
// 脚注
// ---------------------------------------------------------------------------

/**
 * 文末的脚注定义。只写正文真的引用过的那些——
 * 没被引用的定义在 Markdown 里是死内容，反而会让读者以为漏了什么。
 */
function renderNotes(notes, ctx) {
  const parts = [];
  for (const note of notes ?? []) {
    if (!ctx.usedNotes.has(note.id)) continue;
    const body = renderBlocks(note.blocks, ctx)
      .split('\n')
      .map((line, i) => (i === 0 ? line : `    ${line}`.trimEnd()))
      .join('\n');
    parts.push(`[^${note.id}]: ${body}`);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(argv) {
  let opts;
  try {
    opts = parseArgv(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return USAGE;
  }

  let anydoc;
  try {
    anydoc = await import(pathToFileURL(opts.module).href);
  } catch (err) {
    process.stderr.write(`侧载 anydoc 失败（${opts.module}）：${err.message}\n`);
    return FAILED;
  }

  let doc;
  try {
    doc = await anydoc.toDocument(await readFile(opts.src));
  } catch (err) {
    // anydoc 的失败在 Error.code 上带 ConvertErrorCode，原样传回去让 Python 侧转人话
    const code = err?.code ? `[${err.code}] ` : '';
    process.stderr.write(`${code}${err?.message ?? err}\n`);
    return FAILED;
  }

  const ctx = {
    assetNames: await writeAssets(doc.assets ?? [], opts.assetsDir),
    linkPrefix: opts.linkPrefix,
    span: opts.span,
    usedNotes: new Set(),
    unknownBlocks: new Set(),
    missingImages: 0,
  };

  const body = renderBlocks(doc.blocks, ctx);
  const notes = renderNotes(doc.notes, ctx);
  process.stdout.write(`${[body, notes].filter(Boolean).join('\n\n')}\n`);

  // 诊断走 stderr：Python 侧不解析它，但转换出问题时人要能一眼看到发生了什么
  if (ctx.unknownBlocks.size) {
    process.stderr.write(`未知块类型已降级成文本：${[...ctx.unknownBlocks].join(', ')}\n`);
  }
  if (ctx.missingImages) {
    process.stderr.write(`${ctx.missingImages} 张图在源文档里就没有可用字节，只保留了说明文字\n`);
  }
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
