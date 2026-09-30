import { useEffect, useMemo, useState } from 'react';
import { DocxView } from '@/components/DocxView';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { RefineWizard, type WizardInit } from '@/components/templateRefine/RefineWizard';
import { useDocxTools } from '@/hooks/useDocxTools';
import { api, type DocxTemplateDetail, type DocxTemplateIndex, type DocxTemplateItem, type FileItem } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * 模版洗炼。左侧是 `output/docx-template/` 下的真实模板，右侧是选中模板的概要，或者新建的四步。
 * 写盘只经服务端 spawn 工作空间的 `scripts/docx_template.py`（AGENTS.md 不变量 1 第九条），看板自己不写。
 */

const PART_LABEL: { key: 'collect' | 'profile' | 'reference' | 'spec' | 'sample' | 'front'; label: string; note: string }[] = [
  { key: 'collect', label: 'collect/', note: '采集报告，不含正文' },
  { key: 'profile', label: 'profile.json', note: '相对通用规范的客户差异' },
  { key: 'reference', label: 'reference.docx', note: '清洗、重建样式后的参照模板（不是客户原件）' },
  { key: 'spec', label: 'spec.md', note: '写给写 md 的人看的文字规定' },
  { key: 'sample', label: 'sample.docx', note: '合成样张的转换效果' },
  { key: 'front', label: 'front.docx', note: '前置区骨架（封面 / 签署页 / 版本表 / 目录），可选' },
];

const isGenerated = (t: DocxTemplateItem) => t.generated ?? Boolean(t.files?.reference?.exists);
const isDocx = (f: FileItem) => (f.ext || '').toLowerCase() === '.docx' || f.name.toLowerCase().endsWith('.docx');

const NEW_WIZARD: WizardInit = { step: 0, name: '', sourceKey: '', sourcePath: '', regenerate: false };

export function TemplateRefinePane({
  projectId,
  templates,
  workspaceAvailable,
  rawFiles,
  active,
  focus,
}: {
  projectId: string;
  templates: {
    index: DocxTemplateIndex | null;
    loading: boolean;
    error: string;
    unsupported: boolean;
    reload: (silent?: boolean) => void;
  };
  workspaceAvailable: boolean;
  rawFiles: FileItem[];
  /** 这一页当前是否可见：可见时才去探工具链（Python / pandoc / 脚本） */
  active: boolean;
  focus?: { name: string; seq: number } | null;
}) {
  const tools = useDocxTools(projectId, active);
  const [selection, setSelection] = useState('');
  /** null = 看概要；否则是向导的初始状态（换 key 重挂，避免上一次的决定残留） */
  const [wizard, setWizard] = useState<{ init: WizardInit; key: number } | null>(null);

  const items = useMemo(() => templates.index?.items ?? [], [templates.index]);
  const existing = useMemo(() => new Map(items.filter((t) => t.name).map((t) => [t.name as string, isGenerated(t)])), [items]);
  const rawDocx = useMemo(() => rawFiles.filter(isDocx), [rawFiles]);

  const startWizard = (init: WizardInit) => setWizard((prev) => ({ init, key: (prev?.key ?? 0) + 1 }));

  useEffect(() => {
    setSelection('');
    setWizard(null);
  }, [projectId]);

  // 列表读完、一个模板都没有：右侧直接是新建第 ① 步
  const listEmpty = Boolean(templates.index) && !items.length;
  useEffect(() => {
    if (listEmpty && !wizard && workspaceAvailable) startWizard(NEW_WIZARD);
  }, [listEmpty, wizard, workspaceAvailable]);

  useEffect(() => {
    if (!focus) return;
    setSelection(focus.name);
    setWizard(null);
  }, [focus]);

  const selected = items.find((t) => t.name === selection);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[18rem] shrink-0 flex-col border-r border-border">
        <div className="flex h-11 shrink-0 items-center border-b border-border px-3">
          <Button
            variant={wizard && !wizard.init.name ? 'primary' : 'outline'}
            size="sm"
            disabled={!workspaceAvailable}
            onClick={() => {
              setSelection('');
              startWizard(NEW_WIZARD);
            }}
          >
            新建模板
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1" viewportClassName="py-1 focus-visible:ring-0">
          <TemplateList
            workspaceAvailable={workspaceAvailable}
            templates={templates}
            items={items}
            selected={wizard ? '' : selection}
            onSelect={(name) => {
              setSelection(name);
              setWizard(null);
            }}
          />
        </ScrollArea>
      </div>
      <ScrollArea className="min-h-0 flex-1" viewportClassName="focus-visible:ring-0">
        {wizard ? (
          <RefineWizard
            key={wizard.key}
            projectId={projectId}
            rawDocx={rawDocx}
            existing={existing}
            init={wizard.init}
            tools={tools}
            onGenerated={(name) => {
              templates.reload(true);
              setSelection(name);
            }}
          />
        ) : selected ? (
          <Detail
            projectId={projectId}
            item={selected}
            onContinue={(detail) =>
              startWizard({
                step: 1,
                name: selected.name || '',
                sourceKey: selected.sourceDocKey || '',
                sourcePath: selected.source || '',
                regenerate: false,
                report: detail.report,
              })
            }
            onRefine={() =>
              startWizard({
                step: 0,
                name: selected.name || '',
                sourceKey: selected.sourceDocKey || '',
                sourcePath: selected.source || '',
                regenerate: true,
              })
            }
          />
        ) : (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            {items.length ? '在左侧选一个模板，或者新建一个。' : '还没有模板：从一份客户旧 Word 提炼一个。'}
          </p>
        )}
      </ScrollArea>
    </div>
  );
}

function TemplateList({
  workspaceAvailable,
  templates,
  items,
  selected,
  onSelect,
}: {
  workspaceAvailable: boolean;
  templates: { index: DocxTemplateIndex | null; loading: boolean; error: string; unsupported: boolean };
  items: DocxTemplateItem[];
  selected: string;
  onSelect: (name: string) => void;
}) {
  const note = (text: string, danger = false) => (
    <p className={cn('px-3 py-2 text-xs', danger ? 'text-destructive' : 'text-muted-foreground')}>{text}</p>
  );
  if (!workspaceAvailable) return note('工作空间目录现在读不到，模板列表不可用。');
  if (templates.unsupported) return note('看板服务是旧版本，重启后可用。');
  if (templates.error) return note(templates.error, true);
  if (templates.loading && !items.length) return note('正在读取模板目录…');
  if (!items.length) return note('还没有模板：从一份客户旧 Word 提炼一个。');
  return (
    <>
      {items.map((item) =>
        item.name ? (
          <button
            key={item.name}
            type="button"
            onClick={() => onSelect(item.name || '')}
            aria-current={selected === item.name}
            className={cn(
              'flex w-full items-center gap-2 border-l-2 border-transparent py-2 pr-3 pl-3 text-left text-xs hover:bg-accent',
              selected === item.name && 'border-l-foreground bg-selected font-medium',
            )}
          >
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            <span className="shrink-0 text-muted-foreground">{isGenerated(item) ? '' : '未生成'}</span>
          </button>
        ) : null,
      )}
    </>
  );
}

function Detail({
  projectId,
  item,
  onContinue,
  onRefine,
}: {
  projectId: string;
  item: DocxTemplateItem;
  onContinue: (detail: DocxTemplateDetail) => void;
  onRefine: () => void;
}) {
  const [detail, setDetail] = useState<DocxTemplateDetail | null>(null);
  const [error, setError] = useState('');
  const [showSample, setShowSample] = useState(false);
  const name = item.name || '';

  useEffect(() => {
    let alive = true;
    setShowSample(false);
    api
      .docxTemplate(projectId, name)
      .then((data) => {
        if (!alive) return;
        setDetail(data);
        setError('');
      })
      .catch((err: Error) => {
        if (!alive) return;
        setDetail(null);
        setError(err.message);
      });
    return () => {
      alive = false;
    };
    // mtime 变了（重新生成）就重读
  }, [projectId, name, item.mtime, item.files?.reference?.mtime]);

  if (error) return <p className="px-5 py-6 text-sm text-destructive">{error}</p>;
  if (!detail) return <p className="px-5 py-6 text-sm text-muted-foreground">正在读取这个模板…</p>;
  const generated = isGenerated(detail);
  const sourceGone = !item.sourceDocKey;

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium">{detail.name}</h3>
        <p className="text-xs text-muted-foreground">
          {generated ? '已生成' : '只采集、还没生成'}
          {detail.source ? ` · 来源 ${detail.source}` : ''}
          {detail.mtime ? ` · ${formatRelative(detail.mtime)}` : ''}
        </p>
        {generated && detail.files?.front ? <FrontLine detail={detail} /> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {generated ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={!detail.files?.sample?.exists}
              title={detail.files?.sample?.exists ? undefined : '生成时本机没有 pandoc，没有样张；装好 pandoc 后重新提炼'}
              onClick={() => setShowSample((v) => !v)}
            >
              {showSample ? '收起样张' : '预览样张'}
            </Button>
            <Button variant="ghost" size="sm" disabled={sourceGone} onClick={onRefine}>
              重新提炼
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={sourceGone || !detail.report} onClick={() => onContinue(detail)}>
            继续
          </Button>
        )}
      </div>
      {sourceGone ? (
        <p className="text-xs text-muted-foreground">
          来源文档已经不在 input/raw/ 里（或看板服务是旧版本），不能{generated ? '重新提炼' : '继续'}。把它放回去，或用「新建模板」重新选来源。
        </p>
      ) : null}
      {showSample && detail.path ? (
        <DocxView
          projectId={projectId}
          path={`${detail.path}/sample.docx`}
          title={`${detail.name} 样张`}
          size={0}
          mtime={detail.files?.sample?.mtime || ''}
        />
      ) : null}
      <ul className="flex flex-col gap-1 text-xs">
        {PART_LABEL.map(({ key, label, note }) => {
          const part = detail.files?.[key];
          // 旧服务不报 front.docx：整行不显示，免得把「服务不认识」说成「缺」
          if (key === 'front' && !part) return null;
          return (
            <li key={key} className="flex gap-3">
              <span className="w-32 shrink-0 font-mono">{label}</span>
              <span className={cn('w-8 shrink-0', part?.exists ? 'text-foreground' : 'text-muted-foreground')}>
                {part?.exists ? '在' : '缺'}
              </span>
              <span className="text-muted-foreground">{note}</span>
            </li>
          );
        })}
      </ul>
      {generated ? (
        detail.spec ? <Markdown>{detail.spec}</Markdown> : <p className="text-xs text-muted-foreground">没有 spec.md。</p>
      ) : null}
    </div>
  );
}

/** 概要里的「前置区」一行：有没有、几个字段写成了占位符 */
function FrontLine({ detail }: { detail: DocxTemplateItem }) {
  if (!detail.files?.front?.exists) {
    return <p className="text-xs text-muted-foreground">前置区：无（成品只有正文）</p>;
  }
  const roles = Object.values(detail.front?.fields ?? {});
  const mapped = roles.filter((r) => r !== 'keep').length;
  const sections = Object.values(detail.front?.sections ?? {});
  return (
    <p className="text-xs text-muted-foreground">
      前置区：有{sections.length ? `（${sections.join('、')}）` : ''}
      {detail.front ? ` · ${mapped} 个字段转换时填值` : ''}
      {roles.length - mapped > 0 ? `，${roles.length - mapped} 段保持原样` : ''}
    </p>
  );
}
