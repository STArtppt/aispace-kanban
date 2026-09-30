import { deliveryNotesAddon } from '@/lib/deaiPrompt';

/** 提示词里的一条。number 是页面序号，noteId 是批注文件里的 N 编号，两套同时出现。 */
export interface PromptNote {
  start: number;
  end: number;
  quote: string;
  comment: string;
  structure: string;
  number?: number;
  noteId?: string;
}

export interface PromptOptions {
  /** 批注文件的工作空间相对路径。没落盘时不要传，免得 agent 去改一个不存在的文件 */
  noteFile?: string;
  /** 这次有没有写进批注文件。false 时去掉回写段，并说明 agent 无处回写 */
  saved?: boolean;
  reason?: string;
  /** 重发尚未回写的条目：沿用原来的 N 编号，并说明区间可能已经失效 */
  resend?: boolean;
  /**
   * 批注针对的是某一版交付稿：开头改成「以它为底改出下一版」，末尾接 pm-deai-writing 的修订与沉淀要求。
   * 没落盘（原稿还没有记录）时附加段照样带上，回写段仍然去掉。
   */
  delivery?: { version: string; nextPath: string; rulesVersion?: number };
}

function heading(number: number | undefined, noteId: string | undefined): string {
  if (noteId && number) return `### 批注 ${number} · ${noteId}`;
  if (noteId) return `### ${noteId}`;
  return `### 批注 ${number ?? ''}`;
}

/**
 * 按源码区间倒序组装，先改文档后面的，前面的坐标才不会被顶掉。
 * 不传 options 时与改落盘之前的提示词一致（页面序号、不含回写段）。
 */
export function buildAnnotationPrompt(file: string, notes: PromptNote[], options?: PromptOptions): string {
  const resend = Boolean(options?.resend);
  const ordered = notes
    .map((note, index) => ({
      note,
      // 重发时不重新编号：有页面序号就沿用，没有就只留 N 编号
      number: resend ? note.number : index + 1,
    }))
    .sort((a, b) => b.note.start - a.note.start || b.note.end - a.note.end);
  const blocks = ordered.map(({ note, number }) => {
    const quoted = note.quote
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    return [
      heading(number, note.noteId),
      `- 源码区间：UTF-8 字节 ${note.start},${note.end}（左闭右开）`,
      `- 结构：${note.structure}`,
      `- 选中原文：`,
      quoted,
      `- 意见：${note.comment}`,
    ].join('\n');
  });

  const saved = Boolean(options?.saved && options.noteFile);
  const lead: string[] = [];
  if (options && options.saved === false) {
    lead.push(
      `这次没有把批注落进工作空间。${options.reason || 'agent 无处回写。'}`,
      '下面没有批注文件路径，也没有回写格式。不要要求 agent 去改一个不存在的批注文件。',
      '',
    );
  }
  const delivery = options?.delivery;
  lead.push(delivery
    ? `以下是对交付稿 ${delivery.version}（\`${file}\`）的批注。请以它为底改出下一版 \`${delivery.nextPath}\`，不要改它本身。`
    : `请根据以下批注修改文件 \`${file}\`。`);
  if (saved && options?.noteFile) {
    lead.push(
      '',
      `批注已经落在 \`${options.noteFile}\`。改完正文后回到这个文件，按每条的 N 编号回写：`,
      '- 只改这一条的 `- 状态：` 和 `- 回执：` 两行，其它行不要动，不要删条目，不要改编号。',
      '- 状态只能是 pending、adopted、rejected、unclear。',
      '- adopted：回执写改了什么。',
      '- rejected：回执必须写原因。没有原因的拒绝等于没有回答。',
      '- unclear：回执写卡在哪。',
      '- 没处理完的留 pending，回执留空。不要因为正文改过了就把没处理的改成 adopted。',
    );
  }

  const rules = [
    '要求：',
    '- 先按批注意见修改，改完后做好全文口径同步，避免出现自相矛盾。',
    '- 按下面列出的顺序处理（从文件后部往前改，以免改动让后面的坐标失效）。',
    resend
      ? '- 这些是还没回写的批注。源码区间可能已经失效，以原文引用为准。N 编号沿用批注文件里的原编号，不要重新编号。'
      : '- 每条标题里的「批注 N」与页面上的标记一致，不要按处理顺序重新编号。带了 N 编号的，回写时认 N 编号。',
    '- 每条同时给了源码字节区间和原文引用：区间用于定位；改完前一条后如果区间对不上，以原文引用为准。',
  ];

  const addon = delivery
    ? ['', deliveryNotesAddon({ file, version: delivery.version, nextPath: delivery.nextPath, rulesVersion: delivery.rulesVersion })]
    : [];
  return [...lead, '', ...rules, '', ...blocks, ...addon].join('\n');
}
