import { ArrowLeft, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DeaiPane } from '@/components/DeaiPane';
import { FeedbackPane } from '@/components/FeedbackPane';
import { QuestionsPane } from '@/components/QuestionsDialog';
import { RecordsPane } from '@/components/RecordsPane';
import { TemplateRefinePane } from '@/components/TemplateRefinePane';
import { WorkbenchHub, type HubModule } from '@/components/WorkbenchHub';
import { useDeaiRules } from '@/hooks/useDeaiRules';
import { useDocxTemplates } from '@/hooks/useDocxTemplates';
import { useGlobalHotkey } from '@/hooks/useGlobalHotkey';
import {
  type DocxTemplateItem,
  type FeedbackIndex,
  type FileItem,
  type OutputRecordIndex,
  type QuestionIndex,
} from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * ⌘K 工作台：先是模块浏览页，再进五个模块 ——
 * 问题单、记录单、反馈单、模版洗炼、去 AI 味。
 *
 * **这一层只管壳**：Dialog、标题栏、浏览页 / 模块切换、⌘K。
 * 各页内脏各自一份状态，彼此不共享。
 *
 * 五页都常挂（非当前页 `hidden` + `inert`）：切回来筛选、选中项和滚动位置还在。
 * 关掉再打开停在哪一页，由 App 级的 `page` 记住。
 */

export type WorkbenchPage = 'hub' | HubModule;

const MODULES: { key: HubModule; label: string }[] = [
  { key: 'questions', label: '问题单' },
  { key: 'records', label: '记录单' },
  { key: 'feedback', label: '反馈单' },
  { key: 'template', label: '模版洗炼' },
  { key: 'deai', label: '去 AI 味' },
];

function countOrNull(
  blocked: boolean,
  index: { items?: unknown[] } | null,
  count: (items: unknown[]) => number,
): number | null {
  if (blocked || !index || !Array.isArray(index.items)) return null;
  return count(index.items);
}

export function Workbench({
  open,
  onOpenChange,
  page,
  onPageChange,
  projectId,
  projectName,
  version,
  questions,
  records,
  feedback,
  rawFiles,
  changeToken,
  workspaceAvailable = true,
  focusQuestion,
  focusTemplate,
  focusDeaiRule,
  outputDocs = [],
  onOpenDelivery,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  page: WorkbenchPage;
  onPageChange: (page: WorkbenchPage) => void;
  projectId: string;
  projectName: string;
  /** 看板版本，写进反馈邮件正文。旧服务没有时是空串 */
  version: string;
  questions: {
    index: QuestionIndex | null;
    loading: boolean;
    error: string;
    unsupported: boolean;
    reload: (silent?: boolean) => void;
  };
  records: {
    index: OutputRecordIndex | null;
    loading: boolean;
    error: string;
    unsupported: boolean;
    reload: (silent?: boolean) => void;
  };
  feedback: {
    index: FeedbackIndex | null;
    loading: boolean;
    error: string;
    unsupported: boolean;
    reload: (silent?: boolean) => void;
  };
  /** `input/raw/` 里的文件，模版洗炼第 ① 步用来挑 `.docx` */
  rawFiles: FileItem[];
  changeToken: number;
  workspaceAvailable?: boolean;
  focusQuestion?: { id: string; seq: number } | null;
  /** 从「转成 Word」弹窗跳进来时要选中的模板 */
  focusTemplate?: { name: string; seq: number } | null;
  /** 从批注回执的沉淀标签跳进来时要展开的规则 */
  focusDeaiRule?: { rule: string; seq: number } | null;
  /** 产出三组里的 .md（「给文档去 AI 味」从这里选） */
  outputDocs?: FileItem[];
  /** 跳到阅读器里原稿 source 的某一版交付稿（并打开批注清单） */
  onOpenDelivery?: (source: string, version: string) => void;
}) {
  useGlobalHotkey('k', () => onOpenChange(!open));
  // 模板清单在这一层取：浏览页的卡片计数和模版洗炼页共用一份
  const templates = useDocxTemplates(projectId, changeToken);
  // 规则库不在 SSE 监听范围里（.claude/skills/ 下）：每次打开工作台重拉一次
  const deai = useDeaiRules(projectId, changeToken, open);

  const questionCount = countOrNull(
    questions.unsupported || Boolean(questions.error),
    questions.index,
    (items) =>
      (items as QuestionIndex['items']).filter(
        (item) => !item.broken && (item.status === 'open' || item.status === 'pending_ai'),
      ).length,
  );
  const recordCount = countOrNull(
    records.unsupported || Boolean(records.error),
    records.index,
    (items) => items.length,
  );
  const feedbackPending = countOrNull(
    feedback.unsupported || Boolean(feedback.error),
    feedback.index,
    (items) =>
      (items as NonNullable<FeedbackIndex['items']>).filter(
        (item) => !item.broken && item.status === 'pending' && !item.sent_at,
      ).length,
  );

  const templateCount = countOrNull(
    templates.unsupported || Boolean(templates.error),
    templates.index,
    (items) =>
      (items as DocxTemplateItem[]).filter(
        (item) => item.generated ?? Boolean(item.files?.reference?.exists),
      ).length,
  );

  const deaiRules = deai.rules;
  const deaiLabel = deai.unsupported || deai.error || !deaiRules
    ? null
    : deaiRules.installed === false
      ? '未安装'
      : `v${deaiRules.version ?? '?'} · ${(deaiRules.rules ?? []).filter((r) => r.enabled).length} 条`;

  const onHub = page === 'hub';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 关掉弹窗不卸掉四页：选中项、筛选和滚动都留在这次会话里 */}
      <DialogPortal keepMounted>
        <DialogBackdrop />
        <DialogPopup className="h-[min(78vh,780px)] w-[min(1100px,94vw)] max-w-none gap-0 p-0 max-sm:max-w-none">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
            {onHub ? (
              <DialogTitle className="font-display text-base">工作台</DialogTitle>
            ) : (
              <>
                <DialogTitle className="sr-only">工作台</DialogTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onPageChange('hub')}
                  className="shrink-0 px-2"
                >
                  <ArrowLeft className="size-4" />
                  工作台
                </Button>
              </>
            )}
            {onHub ? null : (
              <Tabs
                value={page}
                onValueChange={(value) => {
                  if (MODULES.some(({ key }) => key === value)) onPageChange(value as HubModule);
                }}
                className="shrink-0"
              >
                <TabsList variant="segmented">
                  {MODULES.map(({ key, label }) => (
                    <TabsTrigger key={key} value={key}>
                      {label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            )}
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

          <div className={cn('flex min-h-0 flex-1 flex-col', !onHub && 'hidden')} inert={!onHub}>
            <WorkbenchHub
              questionCount={questionCount}
              recordCount={recordCount}
              feedbackPending={feedbackPending}
              templateCount={templateCount}
              deaiLabel={deaiLabel}
              onOpen={onPageChange}
            />
          </div>
          <div
            className={cn('flex min-h-0 flex-1 flex-col', page !== 'questions' && 'hidden')}
            inert={page !== 'questions'}
          >
            <QuestionsPane
              projectId={projectId}
              index={questions.index}
              loading={questions.loading}
              error={questions.error}
              unsupported={questions.unsupported}
              changeToken={changeToken}
              reload={questions.reload}
              workspaceAvailable={workspaceAvailable}
              active={page === 'questions'}
              focus={focusQuestion}
            />
          </div>
          <div
            className={cn('flex min-h-0 flex-1 flex-col', page !== 'records' && 'hidden')}
            inert={page !== 'records'}
          >
            <RecordsPane
              projectId={projectId}
              index={records.index}
              loading={records.loading}
              error={records.error}
              unsupported={records.unsupported}
              changeToken={changeToken}
              reload={records.reload}
              workspaceAvailable={workspaceAvailable}
            />
          </div>
          <div
            className={cn('relative flex min-h-0 flex-1 flex-col', page !== 'feedback' && 'hidden')}
            inert={page !== 'feedback'}
          >
            <FeedbackPane
              projectId={projectId}
              index={feedback.index}
              loading={feedback.loading}
              error={feedback.error}
              unsupported={feedback.unsupported}
              changeToken={changeToken}
              reload={feedback.reload}
              workspaceAvailable={workspaceAvailable}
              version={version}
            />
          </div>
          <div
            className={cn('flex min-h-0 flex-1 flex-col', page !== 'template' && 'hidden')}
            inert={page !== 'template'}
          >
            <TemplateRefinePane
              projectId={projectId}
              templates={templates}
              workspaceAvailable={workspaceAvailable}
              rawFiles={rawFiles}
              active={open && page === 'template'}
              focus={focusTemplate}
            />
          </div>
          <div
            className={cn('flex min-h-0 flex-1 flex-col', page !== 'deai' && 'hidden')}
            inert={page !== 'deai'}
          >
            <DeaiPane
              projectId={projectId}
              state={deai}
              outputDocs={outputDocs}
              focusRule={focusDeaiRule}
              onOpenDelivery={(source, version) => onOpenDelivery?.(source, version)}
            />
          </div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
