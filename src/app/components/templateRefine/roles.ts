/**
 * 格式簇可以映射过去的角色。键与工作空间 `scripts/docxkit/spec.py` 的 `ROLES` 一一对应，
 * 增删角色两边一起改（键写错了，脚本会以「角色不认识」拒绝整份决定）。
 */
export const ROLES = [
  { key: 'BodyText', label: '正文', style: 'Body Text' },
  { key: 'Heading1', label: '一级标题', style: 'heading 1' },
  { key: 'Heading2', label: '二级标题', style: 'heading 2' },
  { key: 'Heading3', label: '三级标题', style: 'heading 3' },
  { key: 'Heading4', label: '无编号小标题', style: 'heading 4' },
  { key: 'Title', label: '文档标题', style: 'Title' },
  { key: 'Caption', label: '题注', style: 'caption' },
  { key: 'TableCaption', label: '表题', style: 'Table Caption' },
  { key: 'ImageCaption', label: '图题', style: 'Image Caption' },
  { key: 'Compact', label: '列表 / 紧凑段落', style: 'Compact' },
  { key: 'SourceCode', label: '代码块', style: 'Source Code' },
  { key: 'BlockText', label: '引用', style: 'Block Text' },
  { key: 'Note', label: '提示框', style: '提示框' },
  { key: 'FootnoteText', label: '脚注', style: 'footnote text' },
  { key: 'TOCHeading', label: '目录标题', style: 'TOC Heading' },
  { key: 'Table', label: '表格内文字', style: '表格样式' },
] as const;

export type RoleKey = (typeof ROLES)[number]['key'];

export const ROLE_LABEL: Record<string, string> = Object.fromEntries(ROLES.map((r) => [r.key, r.label]));

export const HEADING_ROLES = ['Heading1', 'Heading2', 'Heading3', 'Heading4'] as const;

/** spec.md 里写 md 用法时各角色对应的写法（第 ④ 步的文字规定预览用） */
export const ROLE_MD: Record<string, string> = {
  BodyText: '普通段落',
  Heading1: '`#`',
  Heading2: '`##`',
  Heading3: '`###`',
  Heading4: '`####`',
  Title: 'front-matter 的 `title:`',
  Caption: '题注',
  TableCaption: '表格下方一行 `Table: 表 N 标题`',
  ImageCaption: '`![图 N 标题](路径)` 的方括号',
  Compact: '紧凑列表 `-` / `1.`',
  SourceCode: '围栏代码块',
  BlockText: '`> 引用`',
  Note: '`::: {custom-style="提示框"}`',
  FootnoteText: '`[^1]` 脚注',
  TOCHeading: '（目录由 Word 生成）',
  Table: '管道表格',
};
