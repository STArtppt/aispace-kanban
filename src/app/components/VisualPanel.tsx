import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PrototypePanel } from '@/components/PrototypePanel';
import { ReferencePanel } from '@/components/ReferencePanel';
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

  const select = (value: VisualTab) => {
    setTab(value);
    try {
      localStorage.setItem(TAB_KEY, value);
    } catch {
      // 存不进去（隐私模式等）就只在本次会话里生效，不影响使用
    }
  };

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => select(value === 'prototype' ? 'prototype' : 'reference')}
      className="gap-4"
    >
      <TabsList variant="line">
        <TabsTrigger value="reference">参考</TabsTrigger>
        <TabsTrigger value="prototype">原型</TabsTrigger>
      </TabsList>
      <TabsContent value="reference">
        <ReferencePanel references={scan.references} />
      </TabsContent>
      <TabsContent value="prototype">
        <PrototypePanel prototypes={scan.prototypes} />
      </TabsContent>
    </Tabs>
  );
}
