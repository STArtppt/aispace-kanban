/** 按源码区间倒序组装，先改文档后面的，前面的坐标才不会被顶掉。编号沿用页面上的序号。 */
export function buildAnnotationPrompt(
  file: string,
  notes: Array<{
    start: number;
    end: number;
    quote: string;
    comment: string;
    structure: string;
  }>,
): string {
  const ordered = notes
    .map((note, index) => ({ note, number: index + 1 }))
    .sort((a, b) => b.note.start - a.note.start || b.note.end - a.note.end);
  const blocks = ordered.map(({ note, number }) => {
    const quoted = note.quote
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    return [
      `### 批注 ${number}`,
      `- 源码区间：UTF-8 字节 ${note.start},${note.end}（左闭右开）`,
      `- 结构：${note.structure}`,
      `- 选中原文：`,
      quoted,
      `- 意见：${note.comment}`,
    ].join('\n');
  });
  return [
    `请根据以下批注修改文件 \`${file}\`。`,
    '',
    '要求：',
    '- 先按批注意见修改，改完后做好全文口径同步，避免出现自相矛盾。',
    '- 按下面列出的顺序处理（从文件后部往前改，以免改动让后面的坐标失效）。编号与页面上的标注一致。',
    '- 每条同时给了源码字节区间和原文引用：区间用于定位；改完前一条后如果区间对不上，以原文引用为准。',
    '',
    ...blocks,
  ].join('\n');
}
