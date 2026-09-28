import { X } from 'lucide-react';
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
import { QuestionsPane } from '@/components/QuestionsDialog';
import { RecordsPane } from '@/components/RecordsPane';
import { useGlobalHotkey } from '@/hooks/useGlobalHotkey';
import { type OutputRecordIndex, type QuestionIndex } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * ⌘K 工作台：一个弹窗，两页 —— 问题单（未决问题）、记录单（产出物记录）。
 *
 * 为什么是同一个弹窗而不是两个入口：两者形状高度相似（清单 + 卡片 + 就地写入），
 * 分两个入口会让人记两个快捷键，而且将来第三类（待归档清单）又要再开一个。
 *
 * **这一层只管壳**：Dialog 容器、标题栏、两页切换、⌘K。
 * 两页的内脏各在自己的文件里，彼此**不共享状态** ——
 * 在记录单页做的筛选不影响问题单页，反之亦然。
 *
 * 两页都**常挂着**（只是非当前页 `hidden`）：切回来要保持原样（筛选、卡片位置都不重置），
 * 这是 spec 明写的要求。代价是被挡住的那页仍然活着，所以 `active` 要传下去 ——
 * 问题单页据此让出 document 上的方向键，不然人在这一页按方向键会悄悄翻动那一页。
 */

type Page = 'questions' | 'records';

const PAGES: { key: Page; label: string }[] = [
  { key: 'questions', label: '问题单' },
  { key: 'records', label: '记录单' },
];

export function Workbench({
  open,
  onOpenChange,
  page,
  onPageChange,
  projectId,
  projectName,
  questions,
  records,
  changeToken,
  workspaceAvailable = true,
  focusQuestion,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前停在哪一页。状态在 App 级，关掉再打开还在原来那一页 */
  page: Page;
  onPageChange: (page: Page) => void;
  projectId: string;
  projectName: string;
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
  changeToken: number;
  /** 工作空间目录还在不在（`scan.available`）。两页的降级文案都要用它 */
  workspaceAvailable?: boolean;
  /** 打开时要选中的问题（从文档链接点进来）。不给就照旧 */
  focusQuestion?: { id: string; seq: number } | null;
}) {
  // 本仓唯一的 App 级快捷键。⌘K / Ctrl+K 开关，Esc 由 Dialog 自己收（见 useGlobalHotkey）
  useGlobalHotkey('k', () => onOpenChange(!open));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup className="h-[min(78vh,780px)] w-[min(1100px,94vw)] max-w-none gap-0 p-0 max-sm:max-w-none">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
            <DialogTitle className="font-display text-base">工作台</DialogTitle>
            {/*
              两页切换。它是壳的一部分，所以放在标题栏里 ——
              放进内容区会让人以为这是某一页自己的筛选。
            */}
            <Tabs
              value={page}
              onValueChange={(value) => {
                if (PAGES.some(({ key }) => key === value)) onPageChange(value as Page);
              }}
              className="shrink-0"
            >
              <TabsList variant="segmented">
                {PAGES.map(({ key, label }) => (
                  <TabsTrigger key={key} value={key}>
                    {label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
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

          {/*
            非当前页用 `hidden` 藏起来而不是卸掉：卸掉就等于每次切页都把筛选、
            卡片位置、正文缓存全丢一遍。`inert` 让被藏起来的那页不吃 Tab 焦点。
          */}
          <div className={cn('flex min-h-0 flex-1 flex-col', page !== 'questions' && 'hidden')} inert={page !== 'questions'}>
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
          <div className={cn('flex min-h-0 flex-1 flex-col', page !== 'records' && 'hidden')} inert={page !== 'records'}>
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
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
