import type { ReactNode } from 'react';

import { CodeBlock } from '@/components/ui/code-block';

/**
 * Markdown 围栏代码块 → @startist/code-block 适配层。
 * 与 pentou 同构，保证文档预览与真源视觉一致。
 */
export function MarkdownCodeBlock({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  const text = String(children ?? '').replace(/\n$/, '');
  const language = className?.replace(/language-/, '') || 'snippet';

  return (
    <CodeBlock
      code={text}
      language={language === 'snippet' ? 'text' : language}
      filename={language}
      className="my-4"
    />
  );
}
