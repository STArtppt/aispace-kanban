/**
 * 工作空间 Markdown 里 Obsidian 那一组扩展的 remark 变换。
 *
 * wikilink 不按全库文件名找：`input/converted/` 镜像原始资料，同名文件会重复，
 * 猜一个就是指错。规则是：`./` `../` 相对当前文件，带 `/` 的从工作空间根算，
 * 裸文件名只认同一目录。`[[目标#标题]]` 的标题不写进 href —— 阅读器的
 * `resolveRelative` 会把 `#` 后面当成文件名的一部分，点开就 404。
 *
 * 文档嵌入只内联图片。把另一份 Markdown 嵌进来要处理循环引用和批注锚点算在哪份文件上。
 */

type Point = { line?: number; column?: number; offset?: number };
type Pos = { start?: Point; end?: Point };

type MdNode = {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  title?: string | null;
  children?: MdNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
  position?: Pos;
};

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const WIKI_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
const BLOCK_ID_RE = /(?:^|\s)\^[A-Za-z0-9_-]+\s*$/;
const CALLOUT_RE = /^\[!([A-Za-z][\w-]*)\]([+-])?[ \t]*([^\n]*?)[ \t]*(?:\n([\s\S]*))?$/;

const ATTENTION = new Set([
  'warning',
  'caution',
  'attention',
  'failure',
  'fail',
  'missing',
  'danger',
  'error',
  'bug',
  'important',
]);

const CALLOUT_LABEL: Record<string, string> = {
  note: '注记',
  abstract: '摘要',
  summary: '摘要',
  tldr: '摘要',
  info: '信息',
  todo: '待办',
  tip: '提示',
  hint: '提示',
  success: '完成',
  check: '完成',
  done: '完成',
  question: '疑问',
  help: '疑问',
  faq: '疑问',
  warning: '注意',
  caution: '注意',
  attention: '注意',
  failure: '失败',
  fail: '失败',
  missing: '缺失',
  danger: '危险',
  error: '错误',
  bug: '缺陷',
  example: '示例',
  quote: '引用',
  cite: '引用',
  important: '重要',
};

export function remarkWorkspace(options?: { sourceFile?: string }) {
  const sourceFile = options?.sourceFile || undefined;
  return (tree: MdNode) => {
    stripComments(tree);
    expandWikilinks(tree, sourceFile, false);
    renderTags(tree, false);
    stripBlockIds(tree);
    renderCallouts(tree);
    pruneEmpty(tree);
  };
}

function stripComments(tree: MdNode) {
  const texts: MdNode[] = [];
  collectText(tree, texts);
  let hiding = false;
  for (const node of texts) {
    const value = node.value ?? '';
    let out = '';
    let i = 0;
    while (i < value.length) {
      const mark = value.indexOf('%%', i);
      if (mark === -1) {
        if (!hiding) out += value.slice(i);
        break;
      }
      if (!hiding) out += value.slice(i, mark);
      hiding = !hiding;
      i = mark + 2;
    }
    node.value = out;
  }
}

function collectText(node: MdNode, out: MdNode[]) {
  if (!node.children) return;
  for (const child of node.children) {
    if (child.type === 'text') out.push(child);
    else if (child.type !== 'code' && child.type !== 'inlineCode' && child.type !== 'math' && child.type !== 'inlineMath') {
      collectText(child, out);
    }
  }
}

function expandWikilinks(node: MdNode, sourceFile: string | undefined, inLink: boolean) {
  if (!node.children) return;
  const here = inLink || node.type === 'link' || node.type === 'linkReference';
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (!here && child.type === 'text' && child.value?.includes('[[')) {
      const parts = splitWikilinks(child, sourceFile);
      if (parts) {
        node.children.splice(i, 1, ...parts);
        i += parts.length - 1;
        continue;
      }
    }
    expandWikilinks(child, sourceFile, here);
  }
}

function splitWikilinks(node: MdNode, sourceFile: string | undefined): MdNode[] | null {
  const value = node.value ?? '';
  WIKI_RE.lastIndex = 0;
  const parts: MdNode[] = [];
  let last = 0;
  let matched = false;
  for (let m = WIKI_RE.exec(value); m; m = WIKI_RE.exec(value)) {
    matched = true;
    if (m.index > last) parts.push(textAt(node, last, m.index));
    parts.push(wikiNode(m[1] === '!', m[2], sourceFile, node, m.index, m.index + m[0].length));
    last = m.index + m[0].length;
  }
  if (!matched) return null;
  if (last < value.length) parts.push(textAt(node, last, value.length));
  return parts;
}

function wikiNode(
  embed: boolean,
  inner: string,
  sourceFile: string | undefined,
  origin: MdNode,
  start: number,
  end: number,
): MdNode {
  const pipe = inner.indexOf('|');
  const main = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
  const alias = pipe === -1 ? '' : inner.slice(pipe + 1).trim();
  const hash = main.indexOf('#');
  const target = (hash === -1 ? main : main.slice(0, hash)).trim();
  const heading = hash === -1 ? '' : main.slice(hash + 1).trim();
  const pos = slicePos(origin, start, end);

  if (!target) return textAt(origin, start, end, alias || heading || inner);

  const resolved = resolveWikiTarget(target, sourceFile);
  if (!resolved) return textAt(origin, start, end, alias || target);
  const name = fileLabel(target);
  const label = alias || (heading ? `${name} · ${heading}` : name);

  if (embed && resolved.image) {
    return { type: 'image', url: resolved.href, alt: alias || name, position: pos };
  }

  const link: MdNode = {
    type: 'link',
    url: resolved.href,
    title: heading || null,
    children: [{ type: 'text', value: embed && !alias ? `嵌入 ${label}` : label }],
    position: pos,
  };
  if (embed) link.data = { hProperties: { className: ['md-embed'] } };
  return link;
}

function resolveWikiTarget(
  target: string,
  sourceFile: string | undefined,
): { href: string; image: boolean } | null {
  if (target.includes('\0')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    if (!/^https?:/i.test(target)) return null;
    return { href: target, image: IMAGE_EXT.test(target.split(/[?#]/, 1)[0]) };
  }

  const file = ensureExt(target.replace(/\\/g, '/'));
  const fromDir = sourceFile ? dirOf(sourceFile) : '';
  let href = file;
  if (sourceFile) {
    const workspacePath =
      file.startsWith('./') || file.startsWith('../')
        ? normalizeJoin(fromDir, file)
        : file.includes('/')
          ? normalizeJoin('', file)
          : normalizeJoin(fromDir, file);
    if (!workspacePath) return null;
    href = relativePath(fromDir, workspacePath);
  }
  return { href, image: IMAGE_EXT.test(file) };
}

function ensureExt(path: string): string {
  const last = path.split('/').pop() ?? '';
  if (!last || last === '.' || last === '..' || last.includes('.')) return path;
  return `${path}.md`;
}

function fileLabel(target: string): string {
  const last = target.split('/').filter(Boolean).pop() || target;
  return last.replace(/\.[A-Za-z0-9]+$/, '') || last;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function normalizeJoin(base: string, rel: string): string {
  const stack: string[] = [];
  for (const seg of `${base}/${rel}`.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return stack.join('/');
}

function relativePath(fromDir: string, toPath: string): string {
  const from = fromDir ? fromDir.split('/') : [];
  const to = toPath.split('/');
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  const parts = [...Array(from.length - i).fill('..'), ...to.slice(i)];
  return parts.join('/') || toPath;
}

function renderTags(node: MdNode, inLink: boolean) {
  if (!node.children) return;
  const here = inLink || node.type === 'link' || node.type === 'linkReference';
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (!here && child.type === 'text' && child.value && /(^|\n)#[^\s#]/.test(child.value)) {
      const parts = splitTags(child);
      if (parts) {
        node.children.splice(i, 1, ...parts);
        i += parts.length - 1;
        continue;
      }
    }
    renderTags(child, here);
  }
}

function splitTags(node: MdNode): MdNode[] | null {
  const value = node.value ?? '';
  const parts: MdNode[] = [];
  let plain = '';
  let plainStart = 0;
  const flush = () => {
    if (!plain) return;
    parts.push(textAt(node, plainStart, plainStart + plain.length));
    plain = '';
  };

  let i = 0;
  while (i < value.length) {
    const atLineStart = i === 0 || value[i - 1] === '\n';
    const next = value[i + 1];
    if (atLineStart && value[i] === '#' && next && next !== '#' && !/\s/.test(next)) {
      flush();
      while (i < value.length) {
        const m = /^#[^\s#]\S*/.exec(value.slice(i));
        if (!m) break;
        parts.push(tagNode(m[0], node, i, i + m[0].length));
        i += m[0].length;
        const sp = /^[ \t]+/.exec(value.slice(i));
        if (!sp) break;
        const after = i + sp[0].length;
        const afterNext = value[after + 1];
        if (value[after] === '#' && afterNext && afterNext !== '#' && !/\s/.test(afterNext)) {
          i = after;
          continue;
        }
        break;
      }
      plainStart = i;
      continue;
    }
    if (!plain) plainStart = i;
    plain += value[i];
    i++;
  }
  flush();
  return parts.length ? parts : null;
}

function tagNode(label: string, origin: MdNode, start: number, end: number): MdNode {
  return {
    type: 'mdTag',
    children: [{ type: 'text', value: label }],
    data: { hName: 'span', hProperties: { className: ['md-tag'] } },
    position: slicePos(origin, start, end),
  };
}

function stripBlockIds(node: MdNode) {
  if ((node.type === 'paragraph' || node.type === 'heading') && node.children?.length) {
    const last = node.children[node.children.length - 1];
    if (last.type === 'text' && last.value) {
      const m = BLOCK_ID_RE.exec(last.value);
      if (m && m.index + m[0].length === last.value.length) {
        last.value = last.value.slice(0, m.index).replace(/[ \t]+$/, '');
      }
    }
  }
  for (const child of node.children ?? []) stripBlockIds(child);
}

function renderCallouts(node: MdNode) {
  if (node.type === 'blockquote') applyCallout(node);
  for (const child of node.children ?? []) renderCallouts(child);
}

function applyCallout(node: MdNode) {
  const first = node.children?.[0];
  if (!first || first.type !== 'paragraph' || !first.children?.length) return;
  const lead = first.children[0];
  if (lead.type !== 'text' || !lead.value) return;
  const m = CALLOUT_RE.exec(lead.value);
  if (!m) return;

  const rawType = m[1];
  const type = rawType.toLowerCase();
  const fold = m[2];
  const custom = (m[3] || '').trim();
  const rest = m[4];

  if (rest === undefined || rest.length === 0) {
    first.children.shift();
  } else {
    const removed = lead.value.length - rest.length;
    lead.value = rest;
    if (lead.position?.start?.offset != null) {
      lead.position = {
        start: { ...lead.position.start, offset: lead.position.start.offset + removed },
        end: lead.position.end,
      };
    }
  }
  if (!first.children.some((child) => child.type !== 'text' || child.value)) {
    node.children!.shift();
  }

  const kind = CALLOUT_LABEL[type] || rawType;
  const title = custom && custom !== kind ? `${kind}  ${custom}` : custom || kind;
  const titleNode: MdNode = {
    type: 'paragraph',
    data: {
      hName: fold ? 'summary' : 'div',
      hProperties: { className: ['callout-title'] },
    },
    children: [{ type: 'text', value: title }],
  };
  node.children!.unshift(titleNode);
  node.data = {
    hName: fold ? 'details' : 'div',
    hProperties: {
      className: ['callout', ATTENTION.has(type) ? 'callout-attention' : 'callout-plain'],
      ...(fold === '+' ? { open: true } : {}),
    },
  };
}

function pruneEmpty(node: MdNode) {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    pruneEmpty(child);
    if (child.type === 'text' && !child.value) continue;
    if (child.type === 'paragraph' && !child.children?.length) continue;
    next.push(child);
  }
  node.children = next;
}

function textAt(origin: MdNode, start: number, end: number, value?: string): MdNode {
  return {
    type: 'text',
    value: value ?? (origin.value ?? '').slice(start, end),
    position: slicePos(origin, start, end),
  };
}

function slicePos(origin: MdNode, start: number, end: number): Pos | undefined {
  const base = origin.position?.start?.offset;
  if (base == null || !origin.position) return undefined;
  return {
    start: { offset: base + start, line: origin.position.start?.line, column: origin.position.start?.column },
    end: { offset: base + end, line: origin.position.end?.line, column: origin.position.end?.column },
  };
}
