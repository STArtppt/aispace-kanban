/**
 * 产出物记录的三套状态机 —— **前端与服务端共用的唯一一份**。
 *
 * 服务端用它校验写入（状态值必须属于该 `kind`）并做索引分组；
 * 前端用它渲染状态下拉与分组标题。两边必须同源：抄成两份，
 * 界面上给得出的状态和服务端肯收的状态一旦分叉，就是「选了却存不进去」。
 *
 * 契约的事实源是工作空间里的 `output/records/README.md`
 * （模板在 templates/pm-aispace/ 下），校验脚本 `scripts/check_markdown.py`
 * 里那份 `RECORD_STATUS` 与这里是同一张表。**改一处要同步那两处。**
 *
 * 为什么三类不共用一套：分析中间产物不存在「发给对方」，决策不存在「待修订」——
 * 硬套一套会让每类都带着两三个永远用不上的状态，而状态必须对应分化的后续动作，
 * 不对应的状态就是噪音（`questions/README.md` 里「一半标『高』」是同一个病）。
 *
 * **这个目录的边界：只放两侧共用的纯函数。** 不碰 DOM、不碰 Node API、零依赖。
 */

/** 产出物的三个类别。顺序就是界面上三组的先后。 */
export const RECORD_KINDS = Object.freeze(['analysis', 'docs', 'decisions']);

/**
 * `kind` → 合法状态值（顺序即状态机的推进方向，前端下拉照这个顺序排）。
 *
 * **故意不写 `@type` 注解**：让 tsc 从字面量推出联合类型，
 * 前端的 `RecordKind` / `RecordStatus` 直接由这张表派生（见 `lib/api.ts`）——
 * 写上 `Record<string, string[]>` 就把字面量抹平了，前端只好再抄一遍枚举。
 */
export const RECORD_STATUS = Object.freeze({
  analysis: Object.freeze(['drafting', 'absorbed', 'stale']),
  docs: Object.freeze(['draft', 'delivered', 'revising', 'final', 'superseded']),
  decisions: Object.freeze(['pending', 'confirmed', 'overturned']),
});

/**
 * 进这些状态必须说清被谁消解（`resolved_by`）——
 * 终态意味着「别看这份了」，不说清该看哪份，外部引用就无处可去。
 * `stale`（没被用上，没有下一份）与 `final`（就是它了）不在其中。
 */
export const RECORD_NEEDS_RESOLVED_BY = Object.freeze(['absorbed', 'superseded', 'overturned']);

/**
 * 产出物按 `kind` 落在哪个子目录。`target` 必须落在对应的那个下面。
 * @type {Readonly<Record<string, string>>}
 */
export const RECORD_TARGET_DIR = Object.freeze({
  analysis: 'output/analysis/',
  docs: 'output/docs/',
  decisions: 'output/decisions/',
});

/** 界面上的中文类别名。三处（组标题、空态、错误文案）用同一份，不各写一遍。 */
export const RECORD_KIND_LABEL = Object.freeze({
  analysis: '分析',
  docs: '文档',
  decisions: '决策',
});

/**
 * 状态的中文标签。**只给界面看**，落盘一律是英文值 ——
 * 中文落盘会让「改个文案就等于改数据」。
 * @type {Readonly<Record<string, string>>}
 */
export const RECORD_STATUS_LABEL = Object.freeze({
  drafting: '在写',
  absorbed: '已被吸收',
  stale: '过时未用',
  draft: '草稿',
  delivered: '已发出',
  revising: '待修订',
  final: '已定稿',
  superseded: '被取代',
  pending: '待确认',
  confirmed: '已确认',
  overturned: '已推翻',
});

/**
 * 这个 `kind` 的合法状态值。`kind` 不认识时给空数组 ——
 * 记录是手写文件，`kind` 写错不该让调用方崩，界面上当未知类别显示出来即可。
 * @param {string} kind
 * @returns {readonly string[]}
 */
export function statusValuesOf(kind) {
  return RECORD_STATUS[kind] || [];
}

/**
 * 这个状态值属于这个 `kind` 吗。
 * @param {string} kind
 * @param {string} status
 */
export function isValidStatus(kind, status) {
  return statusValuesOf(kind).includes(status);
}

/**
 * 这个状态必须填 `resolved_by` 吗。
 * @param {string} status
 */
export function needsResolvedBy(status) {
  return RECORD_NEEDS_RESOLVED_BY.includes(status);
}
