import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, Copy, ListChecks, RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import { Markdown } from '@/components/Markdown';
import { HeaderIconButton, HeaderTooltip, writeClipboard } from '@/components/Primitives';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { isTypingTarget } from '@/hooks/useGlobalHotkey';
import { useQuestionDetail } from '@/hooks/useQuestions';
import { ApiError, api, type QuestionDetail, type QuestionIndex, type QuestionItem, type QuestionPatch } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * 未决问题弹窗：左边按「阻塞了谁」分组的清单，右边单条卡片 + 消解闭环。
 *
 * 排序轴是「阻塞了谁」不是优先级 —— 清单按 `blocks` 分组，`backlog`（不阻塞任何在途
 * 交付物）默认不占版面。四个筛选与状态机一一对应，`待 AI 更新` 是闭环的枢纽，
 * 必须能点进去而不只是一个数字。
 *
 * 四个标准答案给的是**回答之外的出口** —— 大量问题不需要问任何人，只需要被消解。
 * 它们走向四条不同的路，所以动作区跟着选中项变（「本期不做」是真终态，不出现复制 prompt）。
 *
 * 写请求只有一处：`api.saveQuestion`，即 AGENTS.md 不变量 1 的**第四条窄例外**。
 * 它只改人写区那四个字段与正文「## 人工反馈」—— 结论、凭据、回流去向都是 agent 的写区，
 * 界面上没有任何编辑它们的入口，这不是疏漏，是那条例外的边界。
 */

/** 不阻塞任何在途交付物的归处。与 questions/README.md 的约定同一个词。 */
const BACKLOG = 'backlog';
/** `blocks` 空着 = 迁移出来还没归类过（迁移只搬运不推断），单独成一组 */
const UNSORTED = '待归类';

type FilterKey = 'open' | 'pending_ai' | 'resolved' | 'conflict';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'open', label: '未处理' },
  { key: 'pending_ai', label: '待 AI 更新' },
  { key: 'resolved', label: '已消解' },
  { key: 'conflict', label: '状态冲突' },
];

/**
 * 一条问题落进哪个筛选。
 * 解析不出来的（`broken`）和状态写错的都归到「状态冲突」——
 * 它本来就是「数据不对、等人裁定」这一堆，让违约可见，而不是让它悄悄消失。
 */
function bucketOf(item: QuestionItem): FilterKey {
  if (item.broken) return 'conflict';
  if (item.status === 'open') return 'open';
  if (item.status === 'pending_ai') return 'pending_ai';
  if (item.status === 'answered' || item.status === 'dropped') return 'resolved';
  return 'conflict';
}

/**
 * 已消解、但结论还没回流正文（`flows_to` 空着）。
 * `dropped` 不算 —— 它本来就没有结论要回流。
 */
function isUnflowed(item: QuestionItem): boolean {
  return item.status === 'answered' && !item.flows_to.length;
}

/**
 * 悬浮入口上的角标数：**未处理、且阻塞着在途交付物**的条数。
 * 不是总条数 —— 两百多条里绝大多数沉在 backlog，把总数摆出来只会让人从此无视这个角标。
 */
export function countPending(index: { items: QuestionItem[] } | null): number {
  if (!index) return 0;
  return index.items.filter((i) => i.blocks !== BACKLOG && bucketOf(i) === 'open').length;
}

/**
 * ── prompt 复制 ───────────────────────────────────────────────────────────
 *
 * **贴路径，不贴正文。** 两个理由：批量十条会把粘贴区撑爆；而且贴进去的是快照，
 * agent 自己读文件才拿得到最新内容（人可能刚在看板上补过输入）。
 */
type PromptKind = 'verify' | 'decide' | 'reopen' | 'batch';

const PROMPT_TASK: Record<PromptKind, string> = {
  verify: '去资料里查证下面这些未决问题，把结论写回各自的问题文件：',
  decide: '下面这些未决问题由我方自行决定：各出一份决策草稿放 `output/decisions/`，并把结论写回问题文件：',
  reopen: '下面这些未决问题的上一轮结论不成立，重做一轮：',
  batch: '下面这些未决问题已经人工分派过，逐条按文件里的 `human_answer` 处理，把结论写回各自的文件：',
};

/** 只有批量才需要说清分派映射 —— 单条的去向在按钮上已经写明了 */
const BATCH_MAPPING = [
  '`verify` = 去资料里查证；',
  '`decide` = 出一份决策草稿放 `output/decisions/`；',
  '`ask` = 在等对方答复，**先别下结论**，只把能查到的背景补进「## 为什么需要」。',
].join('');

/**
 * 凭据四值与「查不到就写推断，不要编」必须写进每一份 prompt ——
 * 这套数据契约的命门就在这里：把推断和实证放进同一栏、长得一模一样，
 * 正是存量数据里出现状态冲突的原因。
 */
const PROMPT_RULES = [
  '先读文件的 `source` / `context` 与「## 为什么需要」，按 `source` 指的文档去查，不要凭印象答。',
  '结论一句话写进 front-matter 的 `ai_conclusion`，展开写进正文「## 结论」。',
  '`evidence` 只能取四值之一：客户确认 / 资料实证 / 我方决策 / 我方推断。**查不到就写 `我方推断`，不要编。**',
  '`evidence: 我方推断` 的条目**不能**置为 `answered`，`status` 留 `open` 当待验证假设。',
  '`ai_source` 写依据出处的路径；`flows_to` 写这条结论该回流到哪份正文的哪一节 —— 想不出去处就先别关。',
  '`human_answer` / `human_note` / `due` 与正文「## 人工反馈」是**人写区，一个字都不要动**；`status` 只在结论站得住时改成 `answered`。',
  '改完跑一遍 `python3 scripts/check_questions.py`，有错按提示改。',
];

const REOPEN_RULE =
  '写新结论前，先把现有的 `ai_conclusion` 与正文「## 结论」原样搬进「## 轮次记录」，'
  + '**不要覆盖** —— 覆盖掉就没法回答「上次为什么这么答」。';

function buildPrompt(kind: PromptKind, paths: string[]): string {
  const rules = [
    ...(kind === 'reopen' ? [REOPEN_RULE] : []),
    ...(kind === 'batch' ? [`按各自的 \`human_answer\` 分头处理：${BATCH_MAPPING}`] : []),
    ...PROMPT_RULES,
  ];
  return [
    PROMPT_TASK[kind],
    '',
    ...paths.map((path) => `- ${path}`),
    '',
    '逐条这么做：',
    ...rules.map((rule, i) => `${i + 1}. ${rule}`),
    '',
  ].join('\n');
}

async function copyPrompt(kind: PromptKind, paths: string[], what: string) {
  if (!paths.length) return;
  const ok = await writeClipboard(buildPrompt(kind, paths));
  if (ok) toast.success(`已复制 ${what}（${paths.length} 条），粘给 agent 即可`);
  else toast.error('复制失败。看板跑在 http 下时浏览器常常不给剪贴板，改用 127.0.0.1 打开再试。');
}

const STATUS_LABEL: Record<string, string> = {
  open: '未处理',
  pending_ai: '待 AI 更新',
  answered: '已消解',
  dropped: '本期不做',
  conflict: '状态冲突',
};

const ANSWER_LABEL: Record<string, string> = {
  verify: '资料里应该有，待查证',
  decide: '我方自行决定',
  drop: '本期不做 / 不相关',
  ask: '确需对方答复',
};

/**
 * 状态点。**只有 conflict 上 orange** —— 它是唯一「需要注意」的状态，
 * 其余三态是正常流转，用深浅灰区分就够了。
 */
function StatusDot({ item }: { item: QuestionItem }) {
  const bucket = bucketOf(item);
  return (
    <span
      aria-hidden
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        bucket === 'conflict' && 'bg-destructive',
        bucket === 'open' && 'bg-foreground/70',
        bucket === 'pending_ai' && 'bg-foreground/30 ring-1 ring-foreground/50',
        bucket === 'resolved' && 'bg-muted-foreground/40',
      )}
    />
  );
}

/**
 * 凭据角标。**常驻，不进折叠区** —— 折叠等于默认不看，会回到
 * 「已解决但不知道凭什么」的老路。它只有四个取值，一个角标的成本。
 *
 * `我方推断` 走 orange：它是唯一不能关闭问题的凭据，正面针对
 * 「AI 把未知伪装成确定事实」。其余三种是正常凭据，灰字。
 */
function EvidenceBadge({ value }: { value: string }) {
  const inferred = value === '我方推断';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-xs',
        inferred
          ? 'border-destructive/40 text-destructive'
          : 'border-border text-muted-foreground',
      )}
      title={inferred ? '查不到依据、只能推的结论，不能用来关闭问题' : '结论的凭据'}
    >
      凭据 · {value || '未标注'}
    </span>
  );
}

/** 卡片上的折叠区。收起时标题行仍带一行摘要，**单张卡片上不超过两个**。 */
function CardSection({
  label,
  summary,
  defaultOpen = false,
  children,
}: {
  label: string;
  summary?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-border bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
      >
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="shrink-0 text-muted-foreground">{label}</span>
        {!open && summary ? <span className="min-w-0 truncate text-xs text-muted-foreground">{summary}</span> : null}
      </button>
      {open ? <div className="border-t border-border px-3 py-2 text-sm">{children}</div> : null}
    </div>
  );
}

/** 一行「字段名 + 值」，值空时整行不出现（空字段不该占版面） */
function MetaLine({ label, value }: { label: string; value: ReactNode }) {
  if (!value) return null;
  return (
    <div className="flex gap-2 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all">{value}</span>
    </div>
  );
}

/** 按二级标题把问题正文切成几节，卡片按节取用（约定见 questions/README.md 的「正文四节」） */
function splitSections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = body.split(/^##\s+/m);
  for (const part of parts.slice(1)) {
    const cut = part.indexOf('\n');
    const heading = (cut === -1 ? part : part.slice(0, cut)).trim();
    const text = (cut === -1 ? '' : part.slice(cut + 1)).trim();
    if (heading) out.set(heading, text);
  }
  return out;
}

/** markdown 段落的第一行纯文本，给折叠区的摘要用 */
function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
    .find(Boolean);
  return (line || '').replace(/[*`]/g, '');
}

/**
 * ── 动作区 ────────────────────────────────────────────────────────────────
 *
 * 四个标准答案**不是平级的终点**，走向四条不同的路，所以按钮区跟着选中项变：
 * 「本期不做」是真终态，不该出现「复制 prompt」（没有后续要派给谁）；
 * 「确需对方答复」不填最迟答复日期就没有任何机制逼它到期 —— 存量那批积压就是这么来的，
 * 所以日期没填时保存直接不可用。
 */
const ANSWERS: { key: 'verify' | 'decide' | 'drop' | 'ask'; hint: string }[] = [
  { key: 'verify', hint: '派给 AI：进「待 AI 更新」，复制查证 prompt 交给 agent' },
  { key: 'decide', hint: '要产出决策：agent 生成 output/decisions/ 草稿' },
  { key: 'drop', hint: '真终态：当场关闭。消解不等于回答 —— 大量问题不需要问任何人' },
  { key: 'ask', hint: '派给人（对外）：进会议清单，必须填最迟答复日期' },
];

/** 四个标准答案各自落到哪个状态。`drop` 是唯一的真终态，其余三个都进 `pending_ai`。 */
const ANSWER_STATUS: Record<string, 'pending_ai' | 'dropped'> = {
  verify: 'pending_ai',
  decide: 'pending_ai',
  drop: 'dropped',
  ask: 'pending_ai',
};

/** 与服务端的 NOTE_LIMIT 同一个数。超了服务端会 400，这里先拦住，不让人白写一段 */
const NOTE_LIMIT = 200;

function AnswerPanel({
  projectId,
  item,
  onSaved,
  onWritten,
}: {
  projectId: string;
  item: QuestionItem;
  onSaved: (id: string) => void;
  onWritten: (detail: QuestionDetail) => void;
}) {
  const [answer, setAnswer] = useState(String(item.human_answer || ''));
  const [note, setNote] = useState('');
  const [due, setDue] = useState(item.due || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const resolved = bucketOf(item) === 'resolved';
  // 原生日期框允许六位年份（`110520-02-06`），服务端会 400。
  // 在这里先按形状拦一道，别让人填完点了保存才知道不对
  const needDue = answer === 'ask' && !/^\d{4}-\d{2}-\d{2}$/.test(due);

  const save = async (patch: QuestionPatch) => {
    setSaving(true);
    setError('');
    try {
      const saved = await api.saveQuestion(projectId, item.id, patch);
      onWritten(saved);
      onSaved(item.id);
    } catch (err) {
      // 老服务进程没有写接口：说清要重启，别让人以为是自己填错了
      setError(
        err instanceof ApiError && err.status === 404 && err.message.startsWith('未知接口')
          ? '服务端还没有保存接口，请重启服务（pnpm serve / pnpm dev）后再试。'
          : (err as Error).message,
      );
    } finally {
      setSaving(false);
    }
  };

  const saveAnswer = () => {
    if (!answer || needDue) return;
    void save({
      status: ANSWER_STATUS[answer],
      human_answer: answer,
      human_note: note.trim(),
      ...(answer === 'ask' ? { due } : {}),
    });
  };

  // 重开一轮：只把 status 推回 open，**上一轮一个字都不删** ——
  // 把旧结论搬进「## 轮次记录」是 agent 的活（prompt 里写明了），那是它的写区。
  const reopen = () => {
    void save({ status: 'open', human_answer: '', human_note: note.trim() });
  };

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 px-3 py-3">
      <div className="flex items-baseline gap-2">
        <h3 className="font-display text-sm">怎么消解这一条</h3>
        <span className="text-xs text-muted-foreground">选一个，四个去向不一样</span>
      </div>

      <div className="grid gap-1.5 sm:grid-cols-2">
        {ANSWERS.map(({ key, hint }) => (
          <label
            key={key}
            title={hint}
            className={cn(
              'flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-sm transition-colors',
              answer === key ? 'border-foreground bg-background' : 'border-border hover:bg-background',
            )}
          >
            <input
              type="radio"
              name={`answer-${item.id}`}
              value={key}
              checked={answer === key}
              onChange={() => setAnswer(key)}
              className="mt-1 accent-foreground"
            />
            <span className="min-w-0">{ANSWER_LABEL[key]}</span>
          </label>
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, NOTE_LIMIT))}
          placeholder="补充一两句（可留空）。要写长文说明这条该拆成几条问题。"
          className="min-h-16 bg-background text-sm"
        />
        <span className="self-end text-[11px] text-muted-foreground">
          {note.length} / {NOTE_LIMIT}
        </span>
      </div>

      {/* 「确需对方答复」专属：没有时限的对外提问会一直躺着 */}
      {answer === 'ask' ? (
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <span className="shrink-0">最迟答复日期</span>
          <Input
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="h-8 w-40 bg-background"
          />
          {needDue ? <span className="text-xs text-destructive">不填就没有任何机制逼它到期</span> : null}
        </label>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!answer || needDue || saving} onClick={saveAnswer}>
          {saving ? '保存中…' : '保存'}
        </Button>

        {/* 动作区随选中项变化：`drop` 是真终态，这里**不出现**复制 prompt */}
        {answer === 'verify' ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void copyPrompt('verify', [item.path], `${item.id} 的查证 prompt`)}
          >
            <Copy className="size-3.5" />
            复制查证 prompt
          </Button>
        ) : null}
        {answer === 'decide' ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void copyPrompt('decide', [item.path], `${item.id} 的决策草稿 prompt`)}
          >
            <Copy className="size-3.5" />
            复制决策草稿 prompt
          </Button>
        ) : null}

        {/* 已消解的条目才给重开入口：结论不满意时要能再问一轮，上一轮痕迹不覆盖 */}
        {resolved ? (
          <>
            <Button size="sm" variant="ghost" disabled={saving} onClick={reopen}>
              <RotateCcw className="size-3.5" />
              重开一轮
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void copyPrompt('reopen', [item.path], `${item.id} 的重做 prompt`)}
            >
              <Copy className="size-3.5" />
              复制重做 prompt
            </Button>
          </>
        ) : null}
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

function QuestionCard({
  projectId,
  item,
  changeToken,
  onSaved,
}: {
  projectId: string;
  item: QuestionItem;
  changeToken: number;
  onSaved: (id: string) => void;
}) {
  const { detail, loading, error, put } = useQuestionDetail(projectId, item.id, changeToken);
  const sections = useMemo(() => splitSections(detail?.body || ''), [detail?.body]);

  const why = sections.get('为什么需要') || '';
  const conclusion = sections.get('结论') || '';
  const feedback = sections.get('人工反馈') || '';
  const rounds = sections.get('轮次记录') || '';
  const aiSource = detail?.ai_source || [];

  // 「依据」折叠区收起时的摘要：凭据已经常驻在上面了，这里说清有几条出处
  const evidenceSummary = [
    aiSource.length ? `出处 ${aiSource.length} 条` : '未标注出处',
    rounds ? '有轮次记录' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{item.id}</span>
        <StatusDot item={item} />
        <span className="text-xs text-muted-foreground">
          {item.broken ? '无法解析' : STATUS_LABEL[item.status] || item.status || '未知状态'}
        </span>
      </div>

      {item.broken ? (
        <div className="rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive">
          {item.reason || '这份问题文件解析不出来'}
          <p className="mt-1 font-mono text-xs opacity-80">{item.path}</p>
        </div>
      ) : null}

      <h2 className="font-display text-lg leading-snug">{item.title || item.name}</h2>

      {why ? (
        <CardSection label="为什么需要" summary={firstLine(why)}>
          <Markdown>{why}</Markdown>
        </CardSection>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <EvidenceBadge value={item.evidence} />
        {item.blocks && item.blocks !== BACKLOG ? (
          <span className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">
            阻塞 · {item.blocks}
          </span>
        ) : null}
        {item.due ? (
          <span className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">
            最迟答复 · {item.due}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <MetaLine label="该问谁" value={item.asked_of} />
        <MetaLine label="标准答案" value={ANSWER_LABEL[item.human_answer] || item.human_answer} />
        <MetaLine label="人工补充" value={detail?.human_note} />
      </div>

      {loading && !detail ? <p className="text-xs text-muted-foreground">正在读正文…</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      {/*
        解析不出来的条目不给动作区：字段级写入需要一份能解析的 front-matter，
        服务端也会拒。这种条目先去编辑器里修文件。
      */}
      {item.broken ? null : (
        <AnswerPanel projectId={projectId} item={item} onSaved={onSaved} onWritten={put} />
      )}

      {conclusion || item.ai_conclusion ? (
        <section className="flex flex-col gap-2">
          <h3 className="font-display text-base">结论</h3>
          {conclusion ? (
            <Markdown>{conclusion}</Markdown>
          ) : (
            <p className="text-sm">{item.ai_conclusion}</p>
          )}
          {item.status === 'answered' && !item.flows_to.length ? (
            <p className="text-xs text-destructive">这条结论还没回流正文（flows_to 还空着）</p>
          ) : null}
        </section>
      ) : null}

      {feedback ? (
        <section className="flex flex-col gap-2">
          <h3 className="font-display text-base">人工反馈</h3>
          <Markdown>{feedback}</Markdown>
        </section>
      ) : null}

      <CardSection label="依据" summary={evidenceSummary}>
        <div className="flex flex-col gap-1">
          {aiSource.map((src) => (
            <MetaLine key={src} label="出处" value={src} />
          ))}
          <MetaLine label="回流到" value={item.flows_to.join('、')} />
          <MetaLine label="触发文档" value={item.source} />
          <MetaLine label="触发时在做" value={item.context} />
          <MetaLine label="问题文件" value={item.path} />
          <MetaLine label="更新于" value={item.updated} />
        </div>
        {rounds ? (
          <div className="mt-2 border-t border-border pt-2">
            <p className="mb-1 text-xs text-muted-foreground">轮次记录</p>
            <Markdown>{rounds}</Markdown>
          </div>
        ) : null}
      </CardSection>
    </div>
  );
}

/** 弹窗正文区：左清单 + 右卡片。抽出来是为了让 open 时才挂载，索引没变就不重算分组。 */
function QuestionsBody({
  projectId,
  index,
  changeToken,
  reload,
}: {
  projectId: string;
  index: QuestionIndex;
  changeToken: number;
  reload: (silent?: boolean) => void;
}) {
  const [filter, setFilter] = useState<FilterKey>('open');
  const [showBacklog, setShowBacklog] = useState(false);
  /** 只看「结论还没回流正文」的那些。只在「已消解」筛选下有意义，切走就关掉 */
  const [onlyUnflowed, setOnlyUnflowed] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  // 四个筛选各自的计数：全量算一次，切筛选不重算
  const counts = useMemo(() => {
    const out: Record<FilterKey, number> = { open: 0, pending_ai: 0, resolved: 0, conflict: 0 };
    for (const item of index.items) {
      if (item.blocks === BACKLOG && !showBacklog) continue;
      out[bucketOf(item)] += 1;
    }
    return out;
  }, [index.items, showBacklog]);

  const backlogCount = useMemo(
    () => index.items.filter((i) => i.blocks === BACKLOG).length,
    [index.items],
  );

  /**
   * 「结论躺在已关闭的卡片里、正文还是旧的」——「只有入口没有出口」的另一面。
   * 光靠关闭状态挡不住，所以在已消解视图里单独把它摆出来。
   */
  const unflowedCount = useMemo(
    () => index.items.filter((i) => (i.blocks !== BACKLOG || showBacklog) && isUnflowed(i)).length,
    [index.items, showBacklog],
  );

  /**
   * 当前筛选下的分组。**计数跟着筛选重算** —— 否则切到「已消解」还看到按未处理算的
   * 分组数，点开却是空的。计数为零的分组不出现。
   */
  const groups = useMemo(() => {
    const map = new Map<string, QuestionItem[]>();
    for (const item of index.items) {
      if (item.blocks === BACKLOG && !showBacklog) continue;
      if (bucketOf(item) !== filter) continue;
      if (onlyUnflowed && !isUnflowed(item)) continue;
      const key = item.blocks || UNSORTED;
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    }
    return [...map.entries()]
      .map(([name, items]) => ({ name, items }))
      // 条数多的排前面；backlog 一律垫底，它本来就不该抢注意力
      .sort((a, b) => {
        if ((a.name === BACKLOG) !== (b.name === BACKLOG)) return a.name === BACKLOG ? 1 : -1;
        return b.items.length - a.items.length || a.name.localeCompare(b.name);
      });
  }, [index.items, filter, showBacklog, onlyUnflowed]);

  /**
   * 某个分组里「待 AI 更新」的条目。批量复制取的是它，**不看当前筛选** ——
   * 用户在「未处理」分组上点批量，想要的仍然是这组已经分派出去、等着发 prompt 的那些。
   */
  const batchOf = (name: string) =>
    index.items.filter((i) => (i.blocks || UNSORTED) === name && i.status === 'pending_ai');

  /** 翻页走的是这条扁平序列：分组顺序里的全部条目，与折叠与否无关 */
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const position = flat.findIndex((i) => i.id === selectedId);
  const current = position >= 0 ? flat[position] : null;

  // 切筛选、或选中的那条被消解掉之后，落到当前结果的第一条上，不让焦点悬空
  useEffect(() => {
    if (flat.some((i) => i.id === selectedId)) return;
    setSelectedId(flat[0]?.id || '');
  }, [flat, selectedId]);

  // 选中项所在的分组必须是展开的，否则翻到它时左栏看不出翻到哪了
  const currentGroup = current ? current.blocks || UNSORTED : '';
  useEffect(() => {
    if (!currentGroup) return;
    setCollapsed((prev) => {
      if (!prev.has(currentGroup)) return prev;
      const next = new Set(prev);
      next.delete(currentGroup);
      return next;
    });
  }, [currentGroup]);

  // 翻页后把选中行滚进可视区
  useEffect(() => {
    if (!selectedId) return;
    rowRefs.current.get(selectedId)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  // 方向键翻页。**焦点在输入框里时不劫持** —— 那时方向键属于输入框。
  // capture 阶段：Base UI 的 Popup 会在冒泡阶段拦掉方向键（同 ImageLightbox 的做法）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      if (isTypingTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setSelectedId((id) => {
        const at = flat.findIndex((i) => i.id === id);
        const next = Math.min(flat.length - 1, Math.max(0, (at < 0 ? 0 : at) + step));
        return flat[next]?.id || id;
      });
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [flat]);

  const go = (step: number) => {
    const next = Math.min(flat.length - 1, Math.max(0, position + step));
    setSelectedId(flat[next]?.id || '');
  };

  /**
   * 消解一条之后**前进到顶上来的那一条**（它占了刚消解那条的位置），
   * 已经是最后一条就退回上一条，整个筛选被清空就落到空态。
   *
   * 不这么做的话焦点会悬空，人得每次回左栏重新找位置 —— 而消解是连着做的动作。
   */
  const handleSaved = (savedId: string) => {
    const at = flat.findIndex((i) => i.id === savedId);
    const next = flat[at + 1] || flat[at - 1] || null;
    setSelectedId(next ? next.id : '');
    reload(true);
  };

  const pickFilter = (key: FilterKey) => {
    setFilter(key);
    // 「尚未回流」是已消解视图里的子筛选，切走就不该继续生效
    if (key !== 'resolved') setOnlyUnflowed(false);
  };

  return (
    <>
      {/* 四个筛选入口，各带计数。「待 AI 更新」是闭环的枢纽，必须点得进去 */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-3">
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => pickFilter(key)}
            aria-pressed={filter === key}
            className={cn(
              'relative h-11 px-3 text-sm transition-colors',
              filter === key
                ? 'font-medium text-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
            <span className={cn('ml-1 text-xs', key === 'conflict' && counts[key] > 0 && 'text-destructive')}>
              ({counts[key]})
            </span>
          </button>
        ))}
      </div>

      {/*
        已消解视图里的「N 条结论尚未回流正文」。问题关掉了但知识没收敛回去，
        下一个人读到的仍然是过期信息 —— 所以它必须是可点的筛选，不是一句提示。
      */}
      {filter === 'resolved' && unflowedCount ? (
        <button
          type="button"
          onClick={() => setOnlyUnflowed((v) => !v)}
          aria-pressed={onlyUnflowed}
          className={cn(
            'flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-left text-xs transition-colors hover:bg-accent',
            onlyUnflowed ? 'bg-muted text-foreground' : 'text-muted-foreground',
          )}
        >
          <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden />
          {unflowedCount} 条结论尚未回流正文（flows_to 还空着）
          <span className="text-muted-foreground">{onlyUnflowed ? '· 点此看全部已消解' : '· 点此筛出'}</span>
        </button>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* ── 左：按 blocks 分组的清单。每行只出「编号 + 一句话 + 状态点」 ── */}
        <div className="flex w-[20rem] shrink-0 flex-col border-r border-border">
          <ScrollArea className="min-h-0 flex-1" viewportClassName="py-1">
            {groups.length ? (
              groups.map((group) => {
                const isOpen = !collapsed.has(group.name);
                const batch = batchOf(group.name);
                return (
                  <div key={group.name}>
                    <div className="flex items-center border-b border-border hover:bg-accent">
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onClick={() =>
                          setCollapsed((prev) => {
                            const next = new Set(prev);
                            if (next.has(group.name)) next.delete(group.name);
                            else next.add(group.name);
                            return next;
                          })
                        }
                        className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-3 text-left text-sm"
                      >
                        <ChevronRight
                          className={cn('size-3.5 shrink-0 transition-transform', isOpen && 'rotate-90')}
                        />
                        <span className="min-w-0 flex-1 truncate">{group.name}</span>
                        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {group.items.length}
                        </span>
                      </button>
                      {/*
                        批量复制，范围**就是这一组**，不是全局待更新 ——
                        跨交付物的批量会把 agent 的上下文打散，那正是这套东西要消除的问题，
                        不能从 200 条缩到 10 条就当解决了。分组本来就是注意力单元。
                      */}
                      <button
                        type="button"
                        disabled={!batch.length}
                        title={
                          batch.length
                            ? `复制「${group.name}」待 AI 更新的 ${batch.length} 条 prompt`
                            : '这一组没有待 AI 更新的问题'
                        }
                        aria-label={`复制「${group.name}」的批量 prompt`}
                        onClick={() =>
                          void copyPrompt('batch', batch.map((i) => i.path), `「${group.name}」`)
                        }
                        className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                      >
                        <Copy className="size-3.5" />
                      </button>
                    </div>
                    {isOpen
                      ? group.items.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            ref={(node) => {
                              if (node) rowRefs.current.set(item.id, node);
                              else rowRefs.current.delete(item.id);
                            }}
                            onClick={() => setSelectedId(item.id)}
                            className={cn(
                              'flex w-full items-start gap-2 border-l-2 border-transparent py-1.5 pr-3 pl-4 text-left transition-colors hover:bg-accent',
                              item.id === selectedId && 'border-l-foreground bg-muted hover:bg-muted',
                            )}
                          >
                            <span className="mt-1.5">
                              <StatusDot item={item} />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="mr-1.5 font-mono text-[11px] text-muted-foreground">
                                {item.id}
                              </span>
                              <span className="line-clamp-2 align-middle text-xs">
                                {item.title || item.name}
                              </span>
                            </span>
                          </button>
                        ))
                      : null}
                  </div>
                );
              })
            ) : (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                这个筛选下没有问题
              </p>
            )}
          </ScrollArea>

          {/*
            backlog 默认不占版面（它不阻塞任何在途交付物），但也不能凭空消失 ——
            两百多条沉在里面，用户得有一条路看见它们。
          */}
          {backlogCount ? (
            <button
              type="button"
              onClick={() => setShowBacklog((v) => !v)}
              aria-pressed={showBacklog}
              className="shrink-0 border-t border-border px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {showBacklog ? '隐藏' : '显示'} backlog（{backlogCount} 条不阻塞在途交付物）
            </button>
          ) : null}
        </div>

        {/* ── 右：单条卡片 + 方向键翻页 ── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-3">
            <HeaderIconButton label="上一条（↑）" disabled={position <= 0} onClick={() => go(-1)}>
              <ArrowUp className="size-4" />
            </HeaderIconButton>
            <HeaderIconButton
              label="下一条（↓）"
              disabled={position < 0 || position >= flat.length - 1}
              onClick={() => go(1)}
            >
              <ArrowDown className="size-4" />
            </HeaderIconButton>
            <span
              className="ml-1 font-mono text-xs text-muted-foreground"
              title={flat.length ? `第 ${position + 1} 条，共 ${flat.length} 条` : '这个筛选下没有问题'}
            >
              {flat.length ? `${position + 1} / ${flat.length}` : '— / 0'}
            </span>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            {current ? (
              <QuestionCard
                key={current.id}
                projectId={projectId}
                item={current}
                changeToken={changeToken}
                onSaved={handleSaved}
              />
            ) : (
              <p className="px-5 py-10 text-center text-sm text-muted-foreground">
                这个筛选下没有问题
              </p>
            )}
          </ScrollArea>
        </div>
      </div>
    </>
  );
}

export function QuestionsDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
  index,
  loading,
  error,
  unsupported,
  changeToken,
  reload,
  workspaceAvailable = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectName: string;
  index: QuestionIndex | null;
  loading: boolean;
  error: string;
  unsupported: boolean;
  changeToken: number;
  /** 保存之后重取索引。静默重取，不闪 loading —— 人正连着消解下一条 */
  reload: (silent?: boolean) => void;
  /**
   * 工作空间目录还在不在（`scan.available`）。目录被改名/移走时问题接口同样返回空列表，
   * 但那不是「还没迁移」—— 照着说会让人去跑一个根本跑不了的迁移脚本。
   */
  workspaceAvailable?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup className="h-[min(78vh,780px)] w-[min(1100px,94vw)] max-w-none gap-0 p-0 max-sm:max-w-none">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
            <DialogTitle className="font-display text-base">待澄清问题清单</DialogTitle>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
              {projectName}
            </span>
            <DialogClose
              render={
                <Button variant="ghost" size="icon" aria-label="关闭" className="shrink-0">
                  <X className="size-4" />
                </Button>
              }
            />
          </header>

          {unsupported ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center">
              <div>
                <p className="text-sm">服务端未提供未决问题接口，请重启服务。</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  看板服务是常驻进程、不热更。在终端里重跑
                  <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono">pnpm serve</code>
                  （开发时是 <code className="rounded bg-muted px-1.5 py-0.5 font-mono">pnpm dev</code>）再打开这里。
                </p>
              </div>
            </div>
          ) : error ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-destructive">
              {error}
            </div>
          ) : !projectId ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              还没有选中工作空间。
            </div>
          ) : !workspaceAvailable ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center">
              <div>
                <p className="text-sm">这个工作空间的目录现在读不到。</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  目录可能被改名或移走了。先在「概览」里重新指到它，问题清单会跟着回来 ——
                  看板不动你本地的任何文件。
                </p>
              </div>
            </div>
          ) : index && !index.available ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center">
              <div>
                <p className="text-sm">这个工作空间还没有结构化问题清单。</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  问题文件放在
                  <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono">{index.dir}</code>
                  下，一问一文件。旧工作空间要先在终端里跑一次迁移脚本
                  <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono">
                    scripts/migrate_questions.py
                  </code>
                  。
                </p>
              </div>
            </div>
          ) : index && !index.items.length ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              这个工作空间暂时没有未决问题。
            </div>
          ) : index ? (
            <QuestionsBody
              projectId={projectId}
              index={index}
              changeToken={changeToken}
              reload={reload}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              {loading ? '正在读问题清单…' : '暂无数据'}
            </div>
          )}
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}

/**
 * 右下角的圆形悬浮入口。快捷键（⌘K）是给熟手的，按钮是给第一次用的人的 ——
 * 一个没有可见入口的功能等于不存在。
 */
export function QuestionsFab({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <div className="fixed right-5 bottom-5 z-40">
      <HeaderTooltip label="待澄清问题清单（⌘K）" side="left">
        <button
          type="button"
          onClick={onClick}
          aria-label="待澄清问题清单"
          className="relative flex size-12 items-center justify-center rounded-full border border-border bg-foreground text-background shadow-lg transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
        >
          <ListChecks className="size-5" />
          {count > 0 ? (
            <span className="absolute -top-1 -right-1 min-w-5 rounded-full border border-background bg-background px-1 text-[11px] leading-[1.125rem] font-medium text-foreground">
              {count > 99 ? '99+' : count}
            </span>
          ) : null}
        </button>
      </HeaderTooltip>
    </div>
  );
}
