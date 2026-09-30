import { useMemo, useState } from 'react';
import { ClipboardCopy, FolderOpen } from 'lucide-react';
import { toast } from 'sonner';
import { DocxView } from '@/components/DocxView';
import { Markdown } from '@/components/Markdown';
import { writeClipboard } from '@/components/Primitives';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useFileManagerName } from '@/hooks/useFileManager';
import {
  ApiError,
  api,
  isUnsupported,
  type DocxBuildResult,
  type DocxCluster,
  type DocxClusterDecision,
  type DocxCollectReport,
  type DocxFrontReport,
  type DocxFrontRole,
  type DocxTableRule,
  type DocxTemplateDetail,
  type FileItem,
} from '@/lib/api';
import { refinePrompt } from '@/lib/docxPrompt';
import { cn } from '@/lib/utils';
import {
  describeProps,
  formatValue,
  FRONT_ROLE_LABEL,
  FRONT_ROLES,
  frontDecision,
  initialFront,
  planRoles,
  TABLE_RULE_LABEL,
  TABLE_RULES,
  type FrontPlan,
  PROP_LABEL,
  propValues,
  roleLabel,
  previewSpec,
  type PropKey,
  type PropValue,
} from '@/components/templateRefine/plan';
import { HEADING_ROLES, ROLES } from '@/components/templateRefine/roles';

const STEPS = ['选来源', '样式分析', '大纲层级', '模板补全'] as const;
const BAD_NAME = /[/\\:*?"<>|\0]/;

/** 与服务端 / 脚本同一条模板名规则：一层目录名 */
export function nameProblem(name: string): string {
  if (!name) return '填一个模板名';
  if (name !== name.trim()) return '首尾不要有空格';
  if (name.startsWith('.') || name.includes('..') || BAD_NAME.test(name)) return '不以 . 开头，不含 / \\ : * ? " < > | 和 ..';
  if (name.length > 80) return '不超过 80 字';
  return '';
}

export interface WizardInit {
  step: number;
  name: string;
  sourceKey: string;
  sourcePath: string;
  regenerate: boolean;
  /** 「继续」时带进来的已有采集报告 */
  report?: DocxCollectReport;
}

interface Tools {
  readOnlyReason: string;
  scriptsMissing: boolean;
}

type ErrorState = { message: string; kind?: string } | null;

function describeError(err: unknown, what: string): ErrorState {
  if (isUnsupported(err)) return { message: `看板服务是旧版本，还没有${what}接口；重启看板后可用。`, kind: 'unsupported' };
  return { message: (err as Error).message, kind: err instanceof ApiError ? err.kind : undefined };
}

const decisionValue = (d: DocxClusterDecision | undefined, c: DocxCluster) => {
  if (!d) return c.suggestedRole ? `role:${c.suggestedRole}` : 'drop';
  if ('role' in d) return `role:${d.role}`;
  if ('merge' in d) return `merge:${d.merge}`;
  return 'drop';
};

function parseDecision(value: string): DocxClusterDecision {
  if (value.startsWith('role:')) return { role: value.slice(5) };
  if (value.startsWith('merge:')) return { merge: value.slice(6) };
  return { drop: true };
}

const SELECT = 'h-8 max-w-44 rounded-lg border border-input bg-background px-1 text-xs';

/**
 * 模版洗炼的四步。第 ② 步「开始分析」、第 ④ 步「生成模板」经服务端 spawn 工作空间的
 * `scripts/docx_template.py`（AGENTS.md 不变量 1 第九条）；载荷只有 docKey、模板名与决定，不带路径。
 * 第 ②③ 步的决定只在这个组件里，离开页面就丢（采集报告已经落盘，「继续」能接上）。
 */
export function RefineWizard({
  projectId,
  rawDocx,
  existing,
  init,
  tools,
  onGenerated,
}: {
  projectId: string;
  /** `input/raw/` 里的 .docx */
  rawDocx: FileItem[];
  /** 已有模板名 → 是否已生成 */
  existing: Map<string, boolean>;
  init: WizardInit;
  tools: Tools;
  /** 生成成功：刷新列表并选中它 */
  onGenerated: (name: string) => void;
}) {
  const fileManager = useFileManagerName();
  const [step, setStep] = useState(init.step);
  const [sourceKey, setSourceKey] = useState(init.sourceKey);
  const [sourcePath, setSourcePath] = useState(init.sourcePath);
  const [name, setName] = useState(init.name);
  const [regenerate, setRegenerate] = useState(init.regenerate);
  const [report, setReport] = useState<DocxCollectReport | null>(init.report ?? null);
  // 模板目录在这次向导里已经存在（继续做 / 刚采集过）：再点「开始分析」就是覆盖自己刚写的，不再要求勾选
  const [dirOwned, setDirOwned] = useState(Boolean(init.report));
  const [decisions, setDecisions] = useState<Record<string, DocxClusterDecision>>({});
  const [choices, setChoices] = useState<Record<string, PropValue>>({});
  // 第 ④ 步的前置区确认；报告里没有前置区（或旧脚本采的报告）时为 null，不出现这一块
  const [front, setFront] = useState<FrontPlan | null>(() => (init.report?.front ? initialFront(init.report.front) : null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorState>(null);
  const [built, setBuilt] = useState<{ result: DocxBuildResult; detail: DocxTemplateDetail | null } | null>(null);
  const [showSample, setShowSample] = useState(false);

  const taken = existing.has(name) && !dirOwned;
  const problem = nameProblem(name);
  const canLeaveStep0 = Boolean(sourceKey) && !problem && (!taken || regenerate);
  const plans = useMemo(() => (report ? planRoles(report, decisions, choices) : []), [report, decisions, choices]);
  const conflicts = plans.flatMap((p) => p.conflicts);
  const scriptsMissing = tools.scriptsMissing || error?.kind === 'no-script';
  const writeBlocked = tools.readOnlyReason
    || (scriptsMissing ? '这个工作空间还没有 docx 工具链，用「复制提示词」让工作空间 AI 补齐后再来' : '');

  const copyPrompt = async () => {
    const ok = await writeClipboard(refinePrompt({ sourcePath, name, scriptsMissing }));
    if (ok) toast.success('已复制提示词，粘给工作空间 AI 执行');
    else toast.error('复制失败：浏览器没给剪贴板权限');
  };

  const collect = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.docxCollect(projectId, name, { docKey: sourceKey, regenerate: regenerate || dirOwned });
      setDirOwned(true);
      const detail = await api.docxTemplate(projectId, name);
      if (!detail.report) throw new Error('采集完成了，但读不到采集报告。刷新后从左侧列表「继续」。');
      setReport(detail.report);
      setDecisions({});
      setChoices({});
      setFront(detail.report.front ? initialFront(detail.report.front) : null);
      setBuilt(null);
    } catch (err) {
      setError(describeError(err, '提炼'));
    } finally {
      setBusy(false);
    }
  };

  const build = async () => {
    setBusy(true);
    setError(null);
    setShowSample(false);
    try {
      // 只带用户真点过、而且当前确有冲突的选择：没点的交给脚本按段数取（profile 里记 extracted 而不是 decision），
      // 旧的键（簇已改映射）留着只会让脚本困惑
      const picked = Object.fromEntries(conflicts.filter((c) => c.key in choices).map((c) => [c.key, c.chosen]));
      const result = await api.docxBuild(projectId, name, {
        docKey: sourceKey,
        decisions: { schema: 1, clusters: decisions, choices: picked, ...(front ? { front: frontDecision(front) } : {}) },
        regenerate: regenerate || existing.get(name) === true,
      });
      const detail = await api.docxTemplate(projectId, name).catch(() => null);
      setBuilt({ result, detail });
      onGenerated(name);
    } catch (err) {
      setError(describeError(err, '生成模板'));
    } finally {
      setBusy(false);
    }
  };

  const setDecision = (id: string, value: string) => {
    setDecisions((prev) => ({ ...prev, [id]: parseDecision(value) }));
    setBuilt(null);
  };

  const errorLine = error ? (
    <div className="flex flex-col items-start gap-2">
      <p className="whitespace-pre-wrap text-xs text-destructive">{error.message}</p>
      {error.kind === 'no-script' ? (
        <Button variant="outline" size="sm" onClick={() => void copyPrompt()}>
          <ClipboardCopy className="size-3.5" />
          复制提示词
        </Button>
      ) : null}
    </div>
  ) : null;

  return (
    <div className="px-5 py-4">
      <ol className="mb-4 flex flex-wrap gap-2">
        {STEPS.map((label, index) => {
          const reachable = index === 0 || (canLeaveStep0 && (index === 1 || Boolean(report)));
          return (
            <li key={label}>
              <button
                type="button"
                disabled={!reachable || busy}
                onClick={() => setStep(index)}
                className={cn(
                  'rounded-md px-2 py-1 text-xs',
                  step === index ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-accent',
                  !reachable && 'cursor-not-allowed opacity-50 hover:bg-transparent',
                )}
              >
                {index + 1}. {label}
              </button>
            </li>
          );
        })}
      </ol>

      {step === 0 ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">来源：input/raw/ 里的客户旧 Word</p>
            {rawDocx.length ? (
              <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto">
                {rawDocx.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      disabled={!file.docKey || busy || dirOwned}
                      title={file.docKey ? file.path : '看板服务是旧版本，重启后可选'}
                      onClick={() => {
                        setSourceKey(file.docKey || '');
                        setSourcePath(file.path);
                        if (!name || name === sourcePath.split('/').pop()?.replace(/\.docx$/i, '')) {
                          setName(file.name.replace(/\.docx$/i, ''));
                        }
                      }}
                      className={cn(
                        'flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-xs',
                        sourceKey && sourceKey === file.docKey ? 'border-foreground bg-accent' : 'border-border hover:bg-accent/60',
                        (!file.docKey || dirOwned) && 'cursor-not-allowed opacity-60',
                      )}
                    >
                      <span className="truncate">{file.path.replace(/^input\/raw\//, '')}</span>
                      {!file.docKey ? <span className="shrink-0 text-muted-foreground">重启看板后可选</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border px-4 py-5 text-sm">
                <p>input/raw/ 里还没有 .docx。把客户旧 Word 放进 input/raw/ 再来。</p>
                <p className="text-xs text-muted-foreground">看板不提供上传：原件放在工作空间里，才能溯源、才能被重新提炼。</p>
                <Button variant="outline" size="sm" onClick={() => void api.reveal(projectId, 'input/raw')}>
                  <FolderOpen className="size-3.5" />
                  在{fileManager}中显示
                </Button>
              </div>
            )}
          </div>
          <label className="flex max-w-md flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">模板名</span>
            <Input value={name} disabled={dirOwned} onChange={(e) => setName(e.target.value)} placeholder="如：客户甲" />
            {name && problem ? <span className="text-xs text-destructive">{problem}</span> : null}
          </label>
          {taken && !problem ? (
            <label className="flex max-w-md items-start justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
              <span className="flex flex-col gap-0.5">
                <span>重新生成「{name}」</span>
                <span className="text-xs text-muted-foreground">
                  这个模板{existing.get(name) ? '已经生成过' : '采集过、还没生成'}。打开后会覆盖它目录下的采集报告和模板文件。
                </span>
              </span>
              <Switch aria-label="重新生成" checked={regenerate} onCheckedChange={setRegenerate} />
            </label>
          ) : null}
        </div>
      ) : null}

      {step === 1 ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy || Boolean(writeBlocked)} title={writeBlocked || undefined} onClick={() => void collect()}>
              {busy ? '正在分析…' : report ? '重新分析' : '开始分析'}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void copyPrompt()}>
              <ClipboardCopy className="size-3.5" />
              复制提示词
            </Button>
            <span className="truncate text-xs text-muted-foreground">{sourcePath}</span>
          </div>
          {writeBlocked && !error ? <p className="text-xs text-muted-foreground">{writeBlocked}。</p> : null}
          {errorLine}
          {report ? <ClusterTable report={report} decisions={decisions} onChange={setDecision} /> : (
            <p className="text-sm text-muted-foreground">
              点「开始分析」：逐段算出旧文档实际显示的格式并归成格式簇。报告只记编号前缀和字数，不含正文。
            </p>
          )}
        </div>
      ) : null}

      {step === 2 && report ? (
        <div className="flex flex-col gap-5">
          <OutlineTree report={report} decisions={decisions} onChange={setDecision} />
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">同一角色格式不一致的项（默认取段数多的）</p>
            {conflicts.length ? conflicts.map((c) => (
              <div key={c.key} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="w-40 shrink-0">{roleLabel(c.role)} · {PROP_LABEL[c.prop]}</span>
                <div role="radiogroup" aria-label={`${roleLabel(c.role)}的${PROP_LABEL[c.prop]}`} className="flex flex-wrap gap-1">
                  {c.options.map((o) => {
                    const on = o.value === c.chosen;
                    return (
                      <button
                        key={String(o.value)}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => {
                          setChoices((prev) => ({ ...prev, [c.key]: o.value }));
                          setBuilt(null);
                        }}
                        className={cn('rounded-md border px-2 py-1', on ? 'border-foreground bg-accent' : 'border-border hover:bg-accent/60')}
                      >
                        {formatValue(c.prop as PropKey, o.value)}（{o.count} 段）
                      </button>
                    );
                  })}
                </div>
              </div>
            )) : <p className="text-xs text-muted-foreground">没有格式不一致的角色。</p>}
          </div>
        </div>
      ) : null}

      {step === 3 && report ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy || Boolean(writeBlocked)} title={writeBlocked || undefined} onClick={() => void build()}>
              {busy ? '正在生成…' : built ? '重新生成' : '生成模板'}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void copyPrompt()}>
              <ClipboardCopy className="size-3.5" />
              复制提示词
            </Button>
            {built?.detail?.files?.sample?.exists ? (
              <Button variant="outline" size="sm" onClick={() => setShowSample((v) => !v)}>
                {showSample ? '收起样张' : '预览样张'}
              </Button>
            ) : null}
          </div>
          {writeBlocked && !error ? <p className="text-xs text-muted-foreground">{writeBlocked}。</p> : null}
          {errorLine}
          {report.front && front ? (
            <FrontSection
              projectId={projectId}
              sourcePath={sourcePath}
              report={report.front}
              plan={front}
              onChange={(next) => {
                setFront(next);
                setBuilt(null);
              }}
            />
          ) : null}
          {built ? (
            <div className="flex flex-col gap-2 text-xs">
              {(built.result.warnings ?? []).length ? (
                <ul className="flex flex-col gap-1">
                  {(built.result.warnings ?? []).map((w) => (
                    <li key={w} className="text-destructive">{w}</li>
                  ))}
                </ul>
              ) : (
                <p>已写出 {(built.result.written ?? []).length} 个文件；样张各角色格式与规范一致。</p>
              )}
            </div>
          ) : null}
          {showSample && built?.detail?.path ? (
            <DocxView
              projectId={projectId}
              path={`${built.detail.path}/sample.docx`}
              title={`${name} 样张`}
              size={0}
              mtime={built.detail.files?.sample?.mtime || ''}
            />
          ) : null}
          <Markdown>{built?.detail?.spec || previewSpec(name, plans, front)}</Markdown>
        </div>
      ) : null}

      <div className="mt-5 flex gap-2">
        {step > 0 ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setStep((n) => n - 1)}>
            上一步
          </Button>
        ) : null}
        {step < 3 ? (
          <Button
            size="sm"
            disabled={busy || (step === 0 ? !canLeaveStep0 : !report)}
            onClick={() => setStep((n) => n + 1)}
          >
            下一步
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function RoleSelect({
  cluster,
  report,
  value,
  onChange,
  roles,
}: {
  cluster: DocxCluster;
  report: DocxCollectReport;
  value: string;
  onChange: (value: string) => void;
  roles?: readonly string[];
}) {
  const list = roles ? ROLES.filter((r) => roles.includes(r.key)) : ROLES;
  return (
    <select aria-label={`${cluster.id} 的处理`} className={SELECT} value={value} onChange={(e) => onChange(e.target.value)}>
      {list.map((r) => (
        <option key={r.key} value={`role:${r.key}`}>
          {r.label}
        </option>
      ))}
      {/* 当前值不在精简列表里时也要能显示出来，不然下拉框会假装选了第一项 */}
      {roles && value.startsWith('role:') && !roles.includes(value.slice(5)) ? (
        <option value={value}>{roleLabel(value.slice(5))}</option>
      ) : null}
      <optgroup label="并入另一簇">
        {report.clusters.filter((c) => c.id !== cluster.id && c.zone === cluster.zone).map((c) => (
          <option key={c.id} value={`merge:${c.id}`}>
            并入 {c.id}（{c.count} 段）
          </option>
        ))}
      </optgroup>
      <option value="drop">丢弃</option>
    </select>
  );
}

function mismatchText(c: DocxCluster): string {
  if (!c.styleDefined || !c.mismatch.length) return '';
  const want = propValues(c.styleDefined);
  const got = propValues(c.fmt);
  // 字号、行距最能说明「样式定义不可信」，排在字体前面
  const priority: PropKey[] = ['size', 'line', 'bold', 'jc', 'firstLineChars', 'before', 'after', 'eastAsia', 'ascii'];
  const shown = priority
    .filter((k) => c.mismatch.includes(k))
    .slice(0, 2)
    .map((k) => `${PROP_LABEL[k]}样式写 ${formatValue(k, want[k])}、实际 ${formatValue(k, got[k])}`);
  return shown.length ? `样式定义与实际不一致（以实际为准）：${shown.join('；')}` : '';
}

const top = (m: Record<string, number>) => Object.keys(m)[0] || '';

function ClusterTable({
  report,
  decisions,
  onChange,
}: {
  report: DocxCollectReport;
  decisions: Record<string, DocxClusterDecision>;
  onChange: (id: string, value: string) => void;
}) {
  const s = report.styles;
  const p = report.paragraphs;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        {s ? `样式 ${s.total} 个，有效 ${s.effective} 个；` : ''}
        {p ? `非空段落 ${p.nonEmpty} 段，带手动格式的 ${p.directRpr} 段；` : ''}
        {report.clusters.length} 个格式簇。建议角色已预选，改成你认为对的；目录项、封面残留可以丢弃。
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] border-collapse text-xs">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="py-1 pr-2 font-medium">簇</th>
              <th className="py-1 pr-2 font-medium">段数</th>
              <th className="py-1 pr-2 font-medium">实际格式</th>
              <th className="py-1 pr-2 font-medium">大纲</th>
              <th className="py-1 pr-2 font-medium">样式 / 编号</th>
              <th className="py-1 pr-2 font-medium">示例</th>
              <th className="py-1 font-medium">映射</th>
            </tr>
          </thead>
          <tbody>
            {report.clusters.map((c) => {
              const warn = mismatchText(c);
              const auto = top(c.autoNum);
              const manual = top(c.manualNum);
              return (
                <tr key={c.id} className="border-b border-border align-top">
                  <td className="py-1.5 pr-2 font-mono">
                    {c.id}
                    <span className="block font-sans text-muted-foreground">{c.zone === 'table' ? '表格内' : '正文'}</span>
                  </td>
                  <td className="py-1.5 pr-2 tabular-nums">{c.count}</td>
                  <td className="py-1.5 pr-2">
                    {describeProps(propValues(c.fmt))}
                    {warn ? <span className="mt-0.5 block text-destructive">{warn}</span> : null}
                  </td>
                  <td className="py-1.5 pr-2">{c.fmt.outline ?? '正文'}{c.pseudoHeading ? '（无编号）' : ''}</td>
                  <td className="py-1.5 pr-2">
                    {top(c.styles)}
                    <span className="block text-muted-foreground">
                      {auto && auto !== '无' ? `自动 ${auto}` : manual && manual !== '无' ? `手写 ${manual}` : '无编号'}
                    </span>
                  </td>
                  <td className="py-1.5 pr-2 font-mono text-muted-foreground">{c.samples[0] || ''}</td>
                  <td className="py-1.5">
                    <RoleSelect
                      cluster={c}
                      report={report}
                      value={decisionValue(decisions[c.id], c)}
                      onChange={(v) => onChange(c.id, v)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OutlineTree({
  report,
  decisions,
  onChange,
}: {
  report: DocxCollectReport;
  decisions: Record<string, DocxClusterDecision>;
  onChange: (id: string, value: string) => void;
}) {
  const levels = report.outline ?? [];
  const byId = new Map(report.clusters.map((c) => [c.id, c]));
  if (!levels.length) {
    return <p className="text-sm text-muted-foreground">旧文档里没有识别出带大纲级别的标题。标题角色可以在第 ② 步直接指定。</p>;
  }
  const headingOptions = [...HEADING_ROLES, 'BodyText'] as const;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-medium text-muted-foreground">标题层级（同一层级共用一个样式；可以把相邻层级并成同一级）</p>
      <ul className="flex flex-col gap-3">
        {levels.map((lv) => {
          const auto = top(lv.autoNum);
          const manual = top(lv.manualNum);
          const clusters = lv.clusters.map((id) => byId.get(id)).filter((c): c is DocxCluster => Boolean(c));
          const numberedRoles = new Set(
            clusters.filter((c) => !c.pseudoHeading).map((c) => decisionValue(decisions[c.id], c)),
          );
          return (
            <li key={lv.level} className="flex flex-col gap-1.5" style={{ paddingLeft: `${(lv.level - 1) * 1.25}rem` }}>
              <p className="text-xs">
                <span className="font-medium">第 {lv.level} 级</span>
                <span className="text-muted-foreground">
                  {' '}· {lv.count} 段 · {auto ? `自动编号 ${auto}` : manual ? `手写编号 ${manual}` : '没有编号'}
                  {lv.numbered < lv.count ? `，其中 ${lv.count - lv.numbered} 段没有编号` : ''}
                </span>
              </p>
              {numberedRoles.size > 1 ? (
                <p className="text-xs text-destructive">这一级的有编号标题映射到了不同样式，同一层级应共用一个样式。</p>
              ) : null}
              {clusters.map((c) => (
                <div key={c.id} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="w-12 font-mono">{c.id}</span>
                  <span className="w-28 truncate font-mono text-muted-foreground">{c.samples[0]}</span>
                  <span className="w-14 tabular-nums text-muted-foreground">{c.count} 段</span>
                  <RoleSelect
                    cluster={c}
                    report={report}
                    value={decisionValue(decisions[c.id], c)}
                    onChange={(v) => onChange(c.id, v)}
                    roles={headingOptions}
                  />
                  {c.pseudoHeading ? (
                    <span className="text-muted-foreground">伪标题（有大纲级别、没有编号）：保留为无编号小标题，或并入某一级标题</span>
                  ) : null}
                </div>
              ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const JC_TEXT: Record<string, string> = { left: '左对齐', center: '居中', both: '两端对齐', right: '右对齐' };

/**
 * 第 ④ 步的「前置区」确认：左边是来源文档本身（它就在 input/raw/，看板本来就能预览），右边是报告里的结构。
 * 报告不含文字，所以字段只按「第几节第几段、几个字、多大字号」列出来，对照左边的原件认。
 */
function FrontSection({
  projectId,
  sourcePath,
  report,
  plan,
  onChange,
}: {
  projectId: string;
  sourcePath: string;
  report: DocxFrontReport;
  plan: FrontPlan;
  onChange: (plan: FrontPlan) => void;
}) {
  const [open, setOpen] = useState(true);
  const setField = (id: string, role: DocxFrontRole) => onChange({ ...plan, fields: { ...plan.fields, [id]: role } });
  const setTable = (id: string, rule: DocxTableRule) => onChange({ ...plan, tables: { ...plan.tables, [id]: rule } });
  const setName = (id: string, value: string) => onChange({ ...plan, sections: { ...plan.sections, [id]: value } });
  return (
    <section className="rounded-lg border border-border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2">
        <button type="button" className="text-sm font-medium" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          前置区 · {report.sections.length} 节{open ? '' : '（已收起）'}
        </button>
        <label className="flex items-center gap-2 text-xs">
          <span>不要前置区</span>
          <Switch aria-label="不要前置区" checked={plan.disabled} onCheckedChange={(v) => onChange({ ...plan, disabled: v })} />
        </label>
      </div>
      {plan.disabled ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">不写 front.docx：转出来的成品只有正文，与没有前置区的模板一样。</p>
      ) : open ? (
        <div className="grid gap-3 p-3 lg:grid-cols-2">
          {/* 纸张比这一栏宽：可滚动，别把封面右半边裁掉 */}
          <div className="max-h-[36rem] min-h-80 overflow-auto rounded-md border border-border">
            <DocxView projectId={projectId} path={sourcePath} title={sourcePath.split('/').pop() || sourcePath} size={0} mtime="" />
          </div>
          <div className="flex flex-col gap-4 text-xs">
            <p className="text-muted-foreground">
              对照左边的原件，把封面上的每一段标成对应的字段：转换时换成这份文档的信息，模板原文不留在模板包里。
              签署页、版本表只清空样例数据，目录保留为 Word 的目录域。
            </p>
            {report.sections.map((sec) => {
              const fields = report.fields.filter((f) => f.section === sec.index);
              const tables = report.tables.filter((t) => t.section === sec.index);
              return (
                <div key={sec.id} className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-muted-foreground">第 {sec.index + 1} 节</span>
                    <Input
                      aria-label={`第 ${sec.index + 1} 节的名称`}
                      className="h-7 w-32 text-xs"
                      maxLength={20}
                      value={plan.sections[sec.id] ?? ''}
                      onChange={(e) => setName(sec.id, e.target.value)}
                    />
                    <span className="text-muted-foreground">
                      {[sec.hasImage ? '有图片' : '', sec.hasToc ? '目录域' : ''].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  {fields.map((f) => {
                    const role = plan.fields[f.id] ?? 'keep';
                    return (
                      <div key={f.id} className="flex flex-wrap items-center gap-2 pl-3">
                        <span className="w-44 shrink-0">
                          第 {f.order} 段 · {f.chars} 字
                          <span className="block text-muted-foreground">
                            {[
                              f.size ? `${f.size}pt` : '',
                              f.bold ? '加粗' : '',
                              JC_TEXT[f.jc] || f.jc,
                              f.inTextbox ? `文本框${f.occurrences > 1 ? `（${f.occurrences} 份）` : ''}` : '',
                              f.labeled ? '带标签，只换冒号后面' : '',
                            ].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                        <select
                          aria-label={`第 ${sec.index + 1} 节第 ${f.order} 段的字段`}
                          className={SELECT}
                          value={role}
                          onChange={(e) => setField(f.id, e.target.value as DocxFrontRole)}
                        >
                          {FRONT_ROLES.map((r) => (
                            <option key={r} value={r}>{FRONT_ROLE_LABEL[r]}</option>
                          ))}
                        </select>
                        {role === 'keep' ? (
                          <span className="text-destructive">这段原文会出现在每一份成品里</span>
                        ) : null}
                      </div>
                    );
                  })}
                  {tables.map((t) => (
                    <div key={t.id} className="flex flex-wrap items-center gap-2 pl-3">
                      <span className="w-44 shrink-0">
                        表格 · {t.rows} 行 × {t.cols} 列
                        <span className="block text-muted-foreground">
                          {[t.labelColumn ? '首列像标签' : '', t.headerLike ? '首行像表头' : ''].filter(Boolean).join(' · ') || '看不出结构'}
                        </span>
                      </span>
                      <select
                        aria-label={`第 ${sec.index + 1} 节表格的清空规则`}
                        className={cn(SELECT, 'max-w-56')}
                        value={plan.tables[t.id] ?? t.defaultRule}
                        onChange={(e) => setTable(t.id, e.target.value as DocxTableRule)}
                      >
                        {TABLE_RULES.map((r) => (
                          <option key={r} value={r}>{TABLE_RULE_LABEL[r]}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                  {!fields.length && !tables.length ? (
                    <p className="pl-3 text-muted-foreground">{sec.hasToc ? '目录：保留域，清掉样例目录项，打开时更新。' : '没有可设置的内容，原样保留。'}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
