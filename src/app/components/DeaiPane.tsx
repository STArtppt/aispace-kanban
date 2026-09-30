import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, ClipboardCopy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DiffView } from '@/components/DiffView';
import { Markdown } from '@/components/Markdown';
import { EmptyState, writeClipboard } from '@/components/Primitives';
import { api, type DeaiRule, type DeaiRules, type FileItem } from '@/lib/api';
import { checkupPrompt, deaiPrompt, deliveryOf, installSkillPrompt, RULES_PATH } from '@/lib/deaiPrompt';
import { cn } from '@/lib/utils';

const CATEGORY_ORDER = ['引用', '强调', '结构', '措辞', '格式'];
const SELECT = 'h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-xs';
/** 规则来源、CHANGELOG 里提到的交付稿路径：点了跳到阅读器里那一版的批注清单 */
const DELIVERY_PATH_RE = /output\/delivery\/(?:analysis|docs|decisions)\/[^\s，。、；;,)）]+?\/v\d{3}\.md/g;

type Tab = 'rules' | 'versions' | 'prompts';

async function copy(text: string, ok: string) {
  if (await writeClipboard(text)) toast.success(ok);
  else toast.error('复制失败：浏览器没给剪贴板权限');
}

/** 把文字里的交付稿路径换成可点的链接，其余原样 */
function Linked({ text, onOpen }: { text: string; onOpen: (source: string, version: string) => void }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(DELIVERY_PATH_RE)) {
    const d = deliveryOf(m[0]);
    parts.push(text.slice(last, m.index));
    parts.push(d ? (
      <button
        key={m.index}
        type="button"
        className="underline decoration-muted-foreground/60 underline-offset-2 hover:text-foreground"
        title="在阅读器里打开这一版的批注"
        onClick={() => onOpen(d.source, d.version)}
      >
        {m[0].replace(/^output\/delivery\//, '')}
      </button>
    ) : m[0]);
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</>;
}

/** CHANGELOG 按 `## v<N>` 切节 */
function changelogSections(text: string): Map<number, string> {
  const out = new Map<number, string>();
  const heads = [...text.matchAll(/^##[ \t]+v(\d+)\b.*$/gm)];
  heads.forEach((m, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
    out.set(Number(m[1]), text.slice(m.index, end).trim());
  });
  return out;
}

/**
 * 工作台「去 AI 味」：规则库（只读）、版本与变更（CHANGELOG 小节、两版对比）、三张提示词卡片。
 * **只读**：复制提示词只写剪贴板，不发任何写请求（AGENTS.md 不变量 1：这条线看板不新增写入）。
 */
export function DeaiPane({
  projectId,
  state,
  outputDocs,
  focusRule,
  onOpenDelivery,
}: {
  projectId: string;
  state: { rules: DeaiRules | null; loading: boolean; error: string; unsupported: boolean; reload: (silent?: boolean) => void };
  /** 产出三组里的 .md（不含已归档），「给文档去 AI 味」从这里选 */
  outputDocs: FileItem[];
  /** 从批注回执的沉淀标签跳进来：展开这条规则 */
  focusRule?: { rule: string; seq: number } | null;
  onOpenDelivery: (source: string, version: string) => void;
}) {
  const { rules, loading, error, unsupported } = state;
  const [tab, setTab] = useState<Tab>('rules');
  const [openRule, setOpenRule] = useState('');
  const ruleRefs = useRef(new Map<string, HTMLLIElement>());

  useEffect(() => {
    if (!focusRule) return;
    setTab('rules');
    setOpenRule(focusRule.rule);
    // 等这一帧把规则展开、tab 切过来再滚
    window.setTimeout(() => ruleRefs.current.get(focusRule.rule)?.scrollIntoView({ block: 'center' }), 50);
  }, [focusRule]);

  if (unsupported) {
    return <EmptyState title="看板服务是旧版本，还没有去 AI 味接口" hint="重启看板服务后可用。" />;
  }
  if (error) return <p className="px-5 py-6 text-sm text-destructive">读不到规则库：{error}</p>;
  if (!rules) return <p className="px-5 py-6 text-sm text-muted-foreground">{loading ? '正在读取规则库…' : ''}</p>;
  if (!rules.installed) {
    return (
      <div className="flex flex-col items-start gap-3 px-5 py-6 text-sm">
        <p className="font-medium">这个工作空间还没有「去 AI 味」技能</p>
        <p className="max-w-2xl text-muted-foreground">
          去 AI 味按一份带版本的规则库把原稿改写成交付稿（放在 output/delivery/，原稿不动），
          人在交付稿上写批注，AI 改出下一版并把能推广的写法偏好沉淀进规则库。
          技能和规则库随工作空间模板分发，旧工作空间要从模板补齐。看板不替你复制文件。
        </p>
        <Button size="sm" onClick={() => void copy(installSkillPrompt(), '已复制，粘贴给工作空间 AI')}>
          <ClipboardCopy className="size-3.5" />
          复制提示词：从模板补齐技能
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-5 py-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList variant="line" className="px-0">
            <TabsTrigger value="rules">规则库</TabsTrigger>
            <TabsTrigger value="versions">版本与变更</TabsTrigger>
            <TabsTrigger value="prompts">提示词</TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="text-xs text-muted-foreground">
          {rules.version ? `当前 v${rules.version}` : '版本未记'}
          {rules.updated ? ` · 更新于 ${rules.updated}` : ''}
          {' · '}
          {RULES_PATH}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {rules.warnings?.length ? (
          <ul className="mb-3 flex flex-col gap-1 text-xs text-destructive">
            {rules.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        ) : null}
        {tab === 'rules' ? (
          <RuleList
            rules={rules.rules ?? []}
            openRule={openRule}
            onToggle={(id) => setOpenRule((cur) => (cur === id ? '' : id))}
            refs={ruleRefs.current}
            onOpenDelivery={onOpenDelivery}
          />
        ) : tab === 'versions' ? (
          <Versions projectId={projectId} rules={rules} onOpenDelivery={onOpenDelivery} />
        ) : (
          <Prompts rules={rules} outputDocs={outputDocs} onOpenDelivery={onOpenDelivery} />
        )}
      </div>
    </div>
  );
}

function RuleList({
  rules,
  openRule,
  onToggle,
  refs,
  onOpenDelivery,
}: {
  rules: DeaiRule[];
  openRule: string;
  onToggle: (id: string) => void;
  refs: Map<string, HTMLLIElement>;
  onOpenDelivery: (source: string, version: string) => void;
}) {
  if (!rules.length) return <EmptyState title="规则库里还没有规则" hint="rules.md 里一条规则一个 `### R001 短名` 三级标题。" />;
  const cats = [...CATEGORY_ORDER, ...new Set(rules.map((r) => r.category).filter((c) => !CATEGORY_ORDER.includes(c)))];
  const enabled = rules.filter((r) => r.enabled).length;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        共 {rules.length} 条，启用 {enabled} 条。点一条看判据、反例和正例。格式类规则转 Word 时脚本也会处理。
      </p>
      {cats.map((cat) => {
        const list = rules.filter((r) => r.category === cat);
        if (!list.length) return null;
        return (
          <section key={cat} className="flex flex-col gap-1">
            <h4 className="text-xs font-medium text-muted-foreground">{cat}</h4>
            <ul className="flex flex-col gap-1">
              {list.map((r) => {
                const open = openRule === r.id;
                return (
                  <li
                    key={r.id}
                    ref={(el) => {
                      if (el) refs.set(r.id, el);
                      else refs.delete(r.id);
                    }}
                    className={cn('rounded-md border border-border', !r.enabled && 'opacity-50', open && 'bg-muted/40')}
                  >
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => onToggle(r.id)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm"
                    >
                      <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
                      <span className="font-mono text-xs text-muted-foreground">{r.id}</span>
                      <span className="min-w-0 flex-1 truncate">{r.name}</span>
                      {!r.enabled ? <span className="text-xs text-muted-foreground">停用</span> : null}
                    </button>
                    {open ? (
                      <dl className="grid grid-cols-[4rem_1fr] gap-x-3 gap-y-1 px-3 pb-3 text-xs">
                        {([['判据', r.criteria], ['反例', r.bad], ['正例', r.good], ['改法', r.fix]] as const).map(([k, v]) => (v ? (
                          <Fragment key={k}>
                            <dt className="text-muted-foreground">{k}</dt>
                            <dd className="whitespace-pre-wrap">{v}</dd>
                          </Fragment>
                        ) : null))}
                        {r.source ? (
                          <>
                            <dt className="text-muted-foreground">来源</dt>
                            <dd><Linked text={r.source} onOpen={onOpenDelivery} /></dd>
                          </>
                        ) : null}
                      </dl>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function Versions({
  projectId,
  rules,
  onOpenDelivery,
}: {
  projectId: string;
  rules: DeaiRules;
  onOpenDelivery: (source: string, version: string) => void;
}) {
  const versions = useMemo(() => {
    const list = (rules.versions ?? []).map((v) => v.version);
    if (rules.version && !list.includes(rules.version)) list.unshift(rules.version);
    return list.sort((a, b) => b - a);
  }, [rules.versions, rules.version]);
  const sections = useMemo(() => changelogSections(rules.changelog ?? ''), [rules.changelog]);
  const [picked, setPicked] = useState<number>(versions[0] ?? 0);
  const [against, setAgainst] = useState<number | null>(null);
  const [diff, setDiff] = useState<{ left: string; right: string } | null>(null);
  const [diffError, setDiffError] = useState('');
  const snapshots = new Set((rules.versions ?? []).map((v) => v.version));

  useEffect(() => {
    if (!versions.includes(picked)) setPicked(versions[0] ?? 0);
  }, [versions, picked]);

  useEffect(() => {
    setDiff(null);
    setDiffError('');
    if (against === null || !picked) return;
    let alive = true;
    const [older, newer] = against < picked ? [against, picked] : [picked, against];
    Promise.all([api.deaiRuleVersion(projectId, older), api.deaiRuleVersion(projectId, newer)])
      .then(([a, b]) => { if (alive) setDiff({ left: a.text, right: b.text }); })
      .catch((err: Error) => { if (alive) setDiffError(err.message); });
    return () => {
      alive = false;
    };
  }, [projectId, picked, against]);

  if (!versions.length) return <EmptyState title="还没有历史版本" hint="规则库每改一次，技能会在 rules/history/ 下存一份全文快照。" />;
  const section = sections.get(picked) ?? '';
  const [older, newer] = against !== null && against < picked ? [against, picked] : [picked, against];
  return (
    <div className="flex flex-col gap-4 md:flex-row">
      <ul className="flex shrink-0 flex-row flex-wrap gap-1 md:w-28 md:flex-col">
        {versions.map((v) => (
          <li key={v}>
            <button
              type="button"
              aria-pressed={picked === v}
              onClick={() => {
                setPicked(v);
                setAgainst(null);
              }}
              className={cn(
                'w-full rounded-md px-2 py-1 text-left font-mono text-xs',
                picked === v ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-accent',
              )}
            >
              v{v}
              {v === rules.version ? '（当前）' : ''}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {section ? (
          <div className="flex flex-col gap-2">
            <Markdown>{section}</Markdown>
            {[...new Set(section.match(DELIVERY_PATH_RE) ?? [])].length ? (
              <p className="text-xs text-muted-foreground">
                来源：<Linked text={[...new Set(section.match(DELIVERY_PATH_RE) ?? [])].join('、')} onOpen={onOpenDelivery} />
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">CHANGELOG.md 里没有 v{picked} 这一节。</p>
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">与</span>
          <select
            aria-label="对比的版本"
            className={cn(SELECT, 'w-28')}
            value={against ?? ''}
            disabled={!snapshots.has(picked)}
            onChange={(e) => setAgainst(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">选一个版本</option>
            {versions.filter((v) => v !== picked && snapshots.has(v)).map((v) => <option key={v} value={v}>v{v}</option>)}
          </select>
          <span className="text-muted-foreground">对比全文</span>
          {!snapshots.has(picked) ? <span className="text-muted-foreground">（history/ 里没有 v{picked} 的快照）</span> : null}
        </div>
        {diffError ? <p className="text-xs text-destructive">{diffError}</p> : null}
        {against !== null && diff ? (
          <DiffView left={diff.left} right={diff.right} leftLabel={`v${older}`} rightLabel={`v${newer}`} />
        ) : against !== null && !diffError ? (
          <p className="text-xs text-muted-foreground">读取中…</p>
        ) : null}
      </div>
    </div>
  );
}

function PromptCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3">
      <h4 className="text-sm font-medium">{title}</h4>
      {children}
    </section>
  );
}

function Prompts({
  rules,
  outputDocs,
  onOpenDelivery,
}: {
  rules: DeaiRules;
  outputDocs: FileItem[];
  onOpenDelivery: (source: string, version: string) => void;
}) {
  const [source, setSource] = useState('');
  const pending = rules.pendingDeliveries ?? [];
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <PromptCard title="给文档去 AI 味">
        <p className="text-xs text-muted-foreground">
          按当前规则库把原稿改写成一版交付稿，写到 output/delivery/ 下；原稿不动，事实和数字不变，依据集中到文末。
        </p>
        <select aria-label="要去味的原稿" className={SELECT} value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">先不选（让 AI 问我要哪一份）</option>
          {outputDocs.map((f) => <option key={f.path} value={f.path}>{f.path.replace(/^output\//, '')}</option>)}
        </select>
        <Button
          size="sm"
          className="self-start"
          onClick={() => void copy(deaiPrompt({ sourcePath: source || undefined, rulesVersion: rules.version }), '已复制，粘贴给工作空间 AI')}
        >
          <ClipboardCopy className="size-3.5" />
          复制提示词
        </Button>
      </PromptCard>
      <PromptCard title="规则库体检">
        <p className="text-xs text-muted-foreground">
          找重复、冲突、长期零命中的规则，汇总各交付稿的命中统计。只给建议，不改规则库。
        </p>
        <Button
          size="sm"
          className="self-start"
          onClick={() => void copy(checkupPrompt({ rulesVersion: rules.version }), '已复制，粘贴给工作空间 AI')}
        >
          <ClipboardCopy className="size-3.5" />
          复制提示词
        </Button>
      </PromptCard>
      <PromptCard title="批注 → 修改 → 沉淀">
        <p className="text-xs text-muted-foreground">
          改交付稿不要直接改文件：在阅读器里打开原稿，版本条切到那一版，点「批注」写意见，再「复制提示词」。
          AI 以那一版为底改出下一版，同一轮把能推广的写法偏好沉淀进规则库，回执里写「沉淀为 R0xx（规则库 vN）」。
        </p>
        {pending.length ? (
          <ul className="flex flex-col gap-1 text-xs">
            {pending.map((p) => (
              <li key={p.path}>
                <button
                  type="button"
                  onClick={() => onOpenDelivery(p.source, p.version)}
                  className="flex w-full items-center justify-between gap-2 rounded-md border border-border px-2 py-1 text-left hover:bg-accent"
                >
                  <span className="truncate">{p.source.replace(/^output\//, '')} · {p.version}</span>
                  <span className="shrink-0 text-muted-foreground">{p.pending} 条待处理</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">现在没有待处理批注的交付稿。</p>
        )}
      </PromptCard>
    </div>
  );
}
