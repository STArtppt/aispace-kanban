import type { ReactNode } from 'react';
import { CircleHelp, Eraser, Files, Mail, Wand2 } from 'lucide-react';
import { FeatureCard, FeatureCardGrid } from '@/components/ui/feature-card';
import { cn } from '@/lib/utils';

export type HubModule = 'questions' | 'records' | 'feedback' | 'template' | 'deai';

/**
 * 工作台的模块浏览页。卡片形态来自 `@startist/feature-card`
 * （发丝线、角标、cursor-pointer 都在真源里），这里只填五个模块的文案和计数。
 * 计数取不到（还在加载、出错、旧服务没有接口）就不显示，不拿 0 或 NaN 充数。
 * orange 只给「待发送反馈数 > 0」；模板数、规则库版本（「v3 · 18 条」「未安装」）是中性灰。
 */
export function WorkbenchHub({
  questionCount,
  recordCount,
  feedbackPending,
  templateCount,
  deaiLabel,
  onOpen,
}: {
  /** `null` = 这份索引现在给不出数 */
  questionCount: number | null;
  recordCount: number | null;
  feedbackPending: number | null;
  /** 已生成的模板数（有 reference.docx 的），只采集没生成的不算 */
  templateCount: number | null;
  /** 规则库「v3 · 18 条」或「未安装」；`null` = 给不出（加载中、出错、旧服务） */
  deaiLabel: string | null;
  onOpen: (module: HubModule) => void;
}) {
  const cards: {
    key: HubModule;
    title: string;
    description: string;
    icon: ReactNode;
    count: number | string | null;
    attention: boolean;
  }[] = [
    {
      key: 'questions',
      title: '问题单',
      description: '还没消解的问题，按阻塞的交付物分组。',
      icon: <CircleHelp />,
      count: questionCount,
      attention: false,
    },
    {
      key: 'records',
      title: '记录单',
      description: '产出物的状态。改状态只动记录，不动产出物本身。',
      icon: <Files />,
      count: recordCount,
      attention: false,
    },
    {
      key: 'feedback',
      title: '反馈单',
      description: '工作空间智能体写给看板的缺陷单，从这里发邮件。',
      icon: <Mail />,
      count: feedbackPending,
      attention: true,
    },
    {
      key: 'template',
      title: '模版洗炼',
      description: '从客户旧 Word 提炼模板，产出文档按它转成 Word。',
      icon: <Wand2 />,
      count: templateCount,
      attention: false,
    },
    {
      key: 'deai',
      title: '去 AI 味',
      description: '带版本的规则库；原稿改写成交付稿，批注改出下一版并沉淀规则。',
      icon: <Eraser />,
      count: deaiLabel,
      attention: false,
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-8 md:px-8">
      <div className="mx-auto w-full max-w-5xl">
        <div className="mx-auto mb-8 max-w-2xl space-y-2 text-center">
          <h2 className="font-display text-2xl tracking-tight md:text-3xl">工作台</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            问题、记录、反馈、模板和去 AI 味。点一张卡片进去，标题栏可以回到这里。
          </p>
        </div>
        <FeatureCardGrid className="sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => {
            const showCount = typeof card.count === 'string'
              ? card.count.length > 0
              : typeof card.count === 'number' && Number.isFinite(card.count);
            const attention = card.attention && typeof card.count === 'number' && showCount && card.count > 0;
            return (
              <FeatureCard
                key={card.key}
                icon={card.icon}
                title={card.title}
                description={card.description}
                meta={
                  showCount ? (
                    <span
                      className={cn(
                        typeof card.count === 'string' ? 'font-mono text-sm' : 'font-mono text-lg tabular-nums',
                        attention ? 'text-destructive' : 'text-muted-foreground',
                      )}
                    >
                      {card.count}
                    </span>
                  ) : undefined
                }
                onClick={() => onOpen(card.key)}
              />
            );
          })}
        </FeatureCardGrid>
      </div>
    </div>
  );
}
