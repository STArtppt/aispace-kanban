/**
 * 反馈单的两种类型与邮件拼法 —— **前端与服务端共用的唯一一份**。
 *
 * 服务端按它给详情排节（`src/server/feedback.mjs`），前端按它拼邮件标题和正文。
 * 抄成两份，界面上列的节和邮件里发出去的节迟早对不上。
 * 契约的事实源是工作空间里的 `output/feedback/README.md`（模板在 templates/pm-aispace/ 下），
 * **节名改了要同步那份 README**。
 *
 * 这个目录只放两侧共用的纯函数：不碰 DOM、不碰 Node API、零依赖。
 */

/**
 * 项目对外的反馈邮箱。看板用它填 `mailto:`，服务端用它写发送记录。
 * 这是公开地址，不是凭据。其它邮箱不要往这个文件里加。
 */
export const FEEDBACK_EMAIL = 'aispace_kanban@163.com';

/**
 * `kind` → 约定的内容节，顺序即详情和邮件里的顺序。
 * 不写 `kind` 的旧单按 `bug` 处理（`feedbackKind`）。
 */
export const FEEDBACK_SECTIONS = Object.freeze({
  bug: Object.freeze(['现象', '期望', '最小复现', '疑似源码位置', '建议改法', '临时绕法']),
  contribution: Object.freeze(['贡献了什么', '为什么能推广', '合成示例', '涉及的模板文件', '改动内容', '实例里的对应']),
});

/** 认得的类型。其它值原样返回，由界面归到「未识别」。 */
export const FEEDBACK_KINDS = Object.freeze(['bug', 'contribution']);

/**
 * front-matter 里的 `kind` → 类型。空 = 缺陷单（本字段出现之前写的单子都没有它）。
 * @param {unknown} raw
 * @returns {string}
 */
export function feedbackKind(raw) {
  const value = raw == null ? '' : String(raw).trim();
  return value || 'bug';
}

/**
 * 某类型约定的节。写歪的类型没有约定，返回空数组 —— 不拿缺陷单的六节去套，
 * 否则界面会凭空多出六个「（这一节是空的）」。
 * @param {string} kind
 * @returns {readonly string[]}
 */
export function feedbackHeadings(kind) {
  return kind === 'contribution' ? FEEDBACK_SECTIONS.contribution : kind === 'bug' ? FEEDBACK_SECTIONS.bug : [];
}

/**
 * 邮件标题。贡献单另用一个前缀，维护者在收件箱里一眼分得开。
 * @param {{ kind?: string, id?: string, title?: string }} item
 */
export function feedbackMailSubject(item) {
  const prefix = feedbackKind(item.kind) === 'contribution' ? '[aispace-kanban 贡献]' : '[aispace-kanban 反馈]';
  return `${prefix} ${item.id || ''} ${item.title || ''}`.trim();
}

/**
 * 邮件正文：该类型的约定节（缺的写「（空）」）+ 看板版本与日期。
 * 写歪的类型没有约定节，就按文件里的节原样拼。
 * @param {{ kind?: string, sections?: { heading?: string, body?: string }[] }} item
 * @param {string} version 看板版本号
 * @param {string} date `YYYY-MM-DD`
 */
export function feedbackMailBody(item, version, date) {
  const sections = item.sections ?? [];
  const bodyOf = (heading) => sections.find((section) => section.heading === heading)?.body || '';
  const headings = feedbackHeadings(feedbackKind(item.kind));
  const parts = headings.length
    ? headings.map((heading) => `## ${heading}\n\n${bodyOf(heading) || '（空）'}`)
    : sections.map((section) => `## ${section.heading || ''}\n\n${section.body || '（空）'}`);
  parts.push(`看板版本：${version || '未知'}\n日期：${date}`);
  return parts.join('\n\n');
}
