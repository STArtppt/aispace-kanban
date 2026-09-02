/**
 * 预览正文的块索引与跳转高亮。
 *
 * 只读 DOM:遍历、textContent、cloneNode 都不改原文档一个节点。
 * 批注的锚点是「UTF-8 字节区间 → 文本节点」的映射(sourceAnchor 契约 A2),
 * 正文里多插一个元素、多拆一个文本节点,已有批注的位置就会错 ——
 * 所以高亮只给块元素临时加一个 class,永不往正文里塞东西。
 */

/** 可检索的叶子块;嵌套块(li 套 ul、td 套 p)的容器块另取"自己的文字" */
const BLOCK_SELECTOR =
  'h1, h2, h3, h4, h5, h6, p, li, td, th, blockquote, pre, figcaption, dt, dd';

export interface BlockEntry {
  el: HTMLElement;
  text: string;
}

/**
 * 收集正文里可检索的块。只读:遍历 + textContent + 离屏 clone,不动任何活节点。
 *
 * 嵌套块的处理:容器块(li 套子列表、td 套段落)取「挖掉块级后代后剩下的文字」,
 * 容器自己的引导文字不丢,也不会把子块的文字重复算一遍;子块另算一条。
 * 收集时把连续空白折成单空格:换行缩进只影响展示,检索按词匹配不受影响,
 * 展示片段也免得带出一堆换行。此后所有下标都对这份折叠后的串,自洽。
 */
export function collectBlocks(root: HTMLElement | null): BlockEntry[] {
  if (!root) return [];
  // 表格预览按行分块:一行才是「一条记录」,按单元格切会把同一行的字段拆散,
  // 「预警 阈值」这种跨列关键词就永远搜不到。markdown 里的表格仍走下面的 td/th。
  if (root.tagName === 'TABLE') {
    const blocks: BlockEntry[] = [];
    for (const row of Array.from(
      root.querySelectorAll<HTMLElement>(':scope > thead > tr, :scope > tbody > tr'),
    )) {
      // 单元格之间没有空白节点,直接 textContent 会把「point_code」「point_name」粘成一词
      const text = Array.from(row.querySelectorAll('th, td'))
        .map((cell) => (cell.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' ');
      if (text) blocks.push({ el: row, text });
    }
    return blocks;
  }
  // 正文根本身就是一个块:纯文本的 <pre>。行 span(task 5.1 的 .block)不在
  // BLOCK_SELECTOR 里,而 querySelectorAll 只查后代 —— 不特判这一支,
  // 纯文本的块索引就是空数组,搜什么都是 0 命中
  if (root.tagName === 'PRE') {
    const blocks: BlockEntry[] = [];
    for (const line of Array.from(root.querySelectorAll<HTMLElement>(':scope > .block'))) {
      const text = (line.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) blocks.push({ el: line, text });
    }
    return blocks;
  }
  const blocks: BlockEntry[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR))) {
    let text: string;
    const nested = el.querySelectorAll<HTMLElement>(BLOCK_SELECTOR);
    if (nested.length) {
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(BLOCK_SELECTOR).forEach((child) => child.remove());
      text = clone.textContent || '';
    } else {
      text = el.textContent || '';
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text) blocks.push({ el, text });
  }
  return blocks;
}

/** 命中块的临时高亮 class,样式与 @keyframes 在 globals.css(黑白灰,不用 destructive) */
export const SEARCH_FLASH_CLASS = 'search-flash';

/** 临时高亮时长:spec 的约定是"约两秒" */
const FLASH_MS = 2000;

export interface SearchJumper {
  /**
   * 平滑滚到块(大致居中)并临时高亮约两秒。
   * 元素已不在 DOM(正文在这期间被重读)时静默返回:不滚动、不报错、不高亮。
   */
  jump(el: HTMLElement | null | undefined): void;
  /** 收掉高亮与定时器:换文件、再次跳转、组件卸载时都要调 */
  clear(): void;
}

/**
 * 同一时刻只允许一个块带着高亮 class。控制器归 Reader 所有而不是浮层 ——
 * 选中结果后浮层就关了,这两秒的闪烁还得有人管到头。
 */
export function createSearchJumper(): SearchJumper {
  let current: HTMLElement | null = null;
  let timer = 0;
  const clear = () => {
    if (timer) {
      window.clearTimeout(timer);
      timer = 0;
    }
    if (current) {
      current.classList.remove(SEARCH_FLASH_CLASS);
      current = null;
    }
  };
  return {
    jump(el) {
      if (!el || !el.isConnected) return;
      clear();
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // 同一块连续跳两次:先摘 class 再强制回流,动画才会从头播一遍
      el.classList.remove(SEARCH_FLASH_CLASS);
      void el.offsetWidth;
      el.classList.add(SEARCH_FLASH_CLASS);
      current = el;
      timer = window.setTimeout(clear, FLASH_MS);
    },
    clear,
  };
}
