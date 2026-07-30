import { CircleHelp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { SectionTitle } from '@/components/Primitives';
import type { ProjectMeta } from '@/lib/api';

/** 点号路径里的英文分组名 → 中文，其余段原样保留（元信息字段本来就是中文的）。 */
const SECTION_LABEL: Record<string, string> = {
  workspace: '工作空间',
  identity: '基本信息',
  background: '背景与目标',
  scope: '范围',
  stakeholders: '干系人',
  milestones: '里程碑',
  deliverables: '成果要求',
  constraints: '约束',
  systems: '既有系统',
  acceptance: '验收',
  documents: '来源资料',
};

function labelOf(dotted: string): string {
  const [head, ...rest] = dotted.split('.');
  const section = SECTION_LABEL[head.replace(/\[\d+\]$/, '')] || head;
  const index = /\[(\d+)\]$/.exec(head);
  const prefix = index ? `${section} ${Number(index[1]) + 1}` : section;
  return rest.length ? `${prefix} · ${rest.join(' · ')}` : prefix;
}

function Value({
  value,
  path,
  meta,
}: {
  value: unknown;
  path: string;
  meta: ProjectMeta;
}) {
  const level = meta.confidence[path];
  if (value === null || value === undefined || value === '') {
    return <span className="text-muted-foreground/60">待补充</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5" title={meta.provenance[path] || ''}>
      <span>{String(value)}</span>
      {level ? (
        <Badge variant="outline" className="text-muted-foreground">
          {level}
        </Badge>
      ) : null}
    </span>
  );
}

function FactGrid({ meta }: { meta: ProjectMeta }) {
  const identity = (meta.data?.identity || {}) as Record<string, any>;
  const period = identity.建设周期 || {};
  const facts: [string, unknown, string][] = [
    ['甲方', identity.甲方, 'identity.甲方'],
    ['承建方', identity.承建方, 'identity.承建方'],
    ['项目类型', identity.项目类型, 'identity.项目类型'],
    ['合同编号', identity.合同编号, 'identity.合同编号'],
    [
      '建设周期',
      period.开始 || period.结束 ? `${period.开始 || '?'} → ${period.结束 || '?'}` : null,
      'identity.建设周期.开始',
    ],
    ['质保期', identity.质保期, 'identity.质保期'],
    ['覆盖范围', identity.覆盖范围, 'identity.覆盖范围'],
    ['当前阶段', meta.data?.workspace?.stage, 'workspace.stage'],
  ];
  return (
    <dl className="grid grid-cols-1 gap-x-8 gap-y-3 rounded-lg border border-border bg-card px-5 py-4 sm:grid-cols-2">
      {facts.map(([label, value, path]) => (
        <div key={label} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="text-sm break-words">
            <Value value={value} path={path} meta={meta} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function BulletList({ items, title }: { items: unknown[]; title: string }) {
  if (!items?.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle count={items.length}>{title}</SectionTitle>
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-6">
        {items.map((item, i) => (
          <li key={i}>
            {typeof item === 'object' && item
              ? Object.values(item as Record<string, unknown>)
                  .filter((v) => v !== null && v !== '')
                  .join(' —— ')
              : String(item)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ObjectTable({ rows, title }: { rows: Record<string, any>[]; title: string }) {
  if (!rows?.length) return null;
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle count={rows.length}>{title}</SectionTitle>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-muted/60">
            <tr>
              {columns.map((col) => (
                <th key={col} className="border-b border-border px-3 py-2 text-left text-xs font-medium whitespace-nowrap">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {columns.map((col) => (
                  <td key={col} className="border-b border-border px-3 py-2 align-top">
                    {row[col] === null || row[col] === undefined || row[col] === '' ? (
                      <span className="text-muted-foreground/60">待补充</span>
                    ) : (
                      String(row[col])
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function KeyValueBlock({ data, title }: { data: Record<string, any>; title: string }) {
  const entries = Object.entries(data || {}).filter(([, v]) => v !== null && v !== '' && (!Array.isArray(v) || v.length));
  if (!entries.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>{title}</SectionTitle>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-2 rounded-lg border border-border bg-card px-5 py-4 sm:grid-cols-2">
        {entries.map(([key, value]) => (
          <div key={key} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">{key}</dt>
            <dd className="text-sm break-words">{Array.isArray(value) ? value.join('、') : String(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function MissingList({ meta }: { meta: ProjectMeta }) {
  if (!meta.missing.length) {
    return (
      <div className="rounded-lg border border-border bg-card px-5 py-4 text-sm text-muted-foreground">
        元信息已填满，没有待补充项。
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <SectionTitle count={meta.missing.length}>待补充</SectionTitle>
        <span className="text-xs text-muted-foreground">
          这些是资料里还没有答案的字段——它们就是该向对方团队确认的问题
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {meta.missing.map((path) => (
          <span
            key={path}
            className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground"
          >
            <CircleHelp className="size-3" />
            {labelOf(path)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Completeness({ meta }: { meta: ProjectMeta }) {
  const stats = meta.stats;
  if (!stats) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-muted-foreground">元信息完整度</span>
        <span className="font-display text-2xl leading-none">{stats.completeness}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-foreground" style={{ width: `${stats.completeness}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">
        已填 {stats.filled} 项 · 待补充 {stats.missing} 项
      </span>
    </div>
  );
}

export function MetaView({ meta }: { meta: ProjectMeta }) {
  const data = meta.data || {};
  const background = data.background || {};
  const scope = data.scope || {};
  const constraints = data.constraints || {};

  return (
    <div className="flex flex-col gap-6">
      <FactGrid meta={meta} />

      <BulletList items={background.目标 || []} title="项目目标" />
      <ObjectTable rows={background.量化指标 || []} title="量化指标" />
      <BulletList items={background.痛点 || []} title="痛点" />
      <ObjectTable rows={scope.建设内容 || []} title="建设内容" />

      {scope.明确不做?.length ? (
        <BulletList items={scope.明确不做} title="明确不做（范围边界）" />
      ) : (
        <div className="flex flex-col gap-2">
          <SectionTitle>明确不做（范围边界）</SectionTitle>
          <p className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-muted-foreground">
            资料里没有明确的排除项。这不等于「什么都要做」——范围边界没写清是后期扯皮的主要来源，
            建议列进要确认的问题。
          </p>
        </div>
      )}

      <ObjectTable rows={data.milestones || []} title="里程碑" />
      <ObjectTable rows={data.stakeholders || []} title="干系人" />
      <ObjectTable rows={data.deliverables || []} title="成果要求" />
      <KeyValueBlock data={constraints.技术要求 || {}} title="技术要求" />
      <KeyValueBlock data={constraints.性能指标 || {}} title="性能指标" />
      <KeyValueBlock data={constraints.团队与服务 || {}} title="团队与服务要求" />
      <BulletList items={constraints.合规 || []} title="合规约束" />
      <ObjectTable rows={data.systems || []} title="既有系统（数据来源）" />
      <BulletList items={data.acceptance?.流程 || []} title="验收流程" />

      <MissingList meta={meta} />

      {data.documents?.length ? (
        <div className="flex flex-col gap-2">
          <SectionTitle count={data.documents.length}>元信息来源</SectionTitle>
          <div className="flex flex-col gap-1.5">
            {data.documents.map((doc: Record<string, any>, i: number) => (
              <div key={i} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="muted">{doc.角色 || '资料'}</Badge>
                <span className="font-mono">{doc.path}</span>
                {doc.提取于 ? <span>提取于 {doc.提取于}</span> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
