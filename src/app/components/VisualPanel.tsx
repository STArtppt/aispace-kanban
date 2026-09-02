import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PanelTitle } from '@/components/Primitives';
import { PrototypePanel } from '@/components/PrototypePanel';
import { ReferencePanel } from '@/components/ReferencePanel';
import { useCaptureJob } from '@/hooks/useCaptureJob';
import type { Scan } from '@/lib/api';

type VisualTab = 'reference' | 'prototype';

/** tab 的选中状态单独存，**不影响**「上次打开的视图」（那个还在 useBoardSession 里）。 */
const TAB_KEY = 'aispace-kanban:visual-tab';

function readTab(): VisualTab {
  try {
    // 刚接手一个项目时先有的是参考，所以首次默认落在这一边
    return localStorage.getItem(TAB_KEY) === 'prototype' ? 'prototype' : 'reference';
  } catch {
    return 'reference';
  }
}

/**
 * 「视觉呈现」视图的壳：参考 / 原型两个 tab。
 * 以后加视频、幻灯片就是在 visualization/ 下再开一个子目录、这里再开一个 tab。
 */
export function VisualPanel({ scan }: { scan: Scan }) {
  const [tab, setTab] = useState<VisualTab>(readTab);
  // 采集任务的状态提到这一层：服务端一个工作空间只允许一轮，
  // 两个 tab 各存一份的话第二处会撞 409 却显示成「没反应」
  const capture = useCaptureJob(scan.project.id);

  const select = (value: VisualTab) => {
    setTab(value);
    try {
      localStorage.setItem(TAB_KEY, value);
    } catch {
      // 存不进去（隐私模式等）就只在本次会话里生效，不影响使用
    }
  };

  const referenceCount = scan.references?.items.length;
  const prototypeCount = scan.prototypes.items.length;

  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex min-h-8 min-w-0 items-center">
        <PanelTitle>视觉内容</PanelTitle>
      </div>
      <Tabs
        value={tab}
        onValueChange={(value) => select(value === 'prototype' ? 'prototype' : 'reference')}
        className="gap-4"
      >
        <TabsList variant="line">
          <TabsTrigger value="reference" className="px-2">
            <span className="truncate">参考</span>
            {typeof referenceCount === 'number' && referenceCount > 0 ? (
              <span className="shrink-0 text-xs font-normal text-muted-foreground">
                {referenceCount}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="prototype" className="px-2">
            <span className="truncate">原型</span>
            {prototypeCount > 0 ? (
              <span className="shrink-0 text-xs font-normal text-muted-foreground">
                {prototypeCount}
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="reference">
          <ReferencePanel references={scan.references} capture={capture} />
        </TabsContent>
        <TabsContent value="prototype">
          <PrototypePanel prototypes={scan.prototypes} capture={capture} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
