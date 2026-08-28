import type { ReactNode } from 'react';

import { CodeBlock } from '@/components/ui/code-block';
import { pickSourceAttrs } from '@/lib/sourceAnchor';

/**
 * Markdown 围栏代码块 → @startist/code-block 适配层。
 * 与 pentou 同构，保证文档预览与真源视觉一致。
 */
export function MarkdownCodeBlock({
  children,
  className,
  ...props
}: {
  children?: ReactNode;
  className?: string;
} & Record<string, unknown>) {
  const text = String(children ?? '').replace(/\n$/, '');
  const language = className?.replace(/language-/, '') || 'snippet';
  const a2 = pickSourceAttrs(props);

  return (
    <div className="my-4" {...a2}>
      <CodeBlock
        code={text}
        language={language === 'snippet' ? 'text' : language}
        filename={language}
      />
    </div>
  );
}
