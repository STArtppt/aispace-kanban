import type { ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

/**
 * 纯 token 的 markdown 排版。不引 typography 插件，样式全部走语义色，
 * 避免出现设计规范之外的颜色。
 */
const components: ComponentProps<typeof ReactMarkdown>['components'] = {
  h1: ({ className, ...props }) => (
    <h1 className={cn('mt-8 mb-4 font-display text-2xl first:mt-0', className)} {...props} />
  ),
  h2: ({ className, ...props }) => (
    <h2 className={cn('mt-8 mb-3 border-b border-border pb-2 text-xl font-medium first:mt-0', className)} {...props} />
  ),
  h3: ({ className, ...props }) => (
    <h3 className={cn('mt-6 mb-2 text-base font-medium first:mt-0', className)} {...props} />
  ),
  h4: ({ className, ...props }) => (
    <h4 className={cn('mt-4 mb-2 text-sm font-medium first:mt-0', className)} {...props} />
  ),
  p: ({ className, ...props }) => <p className={cn('my-3 text-sm leading-7', className)} {...props} />,
  ul: ({ className, ...props }) => (
    <ul className={cn('my-3 list-disc space-y-1 pl-5 text-sm leading-7', className)} {...props} />
  ),
  ol: ({ className, ...props }) => (
    <ol className={cn('my-3 list-decimal space-y-1 pl-5 text-sm leading-7', className)} {...props} />
  ),
  li: ({ className, ...props }) => <li className={cn('pl-1', className)} {...props} />,
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn('my-4 border-l-2 border-border pl-4 text-sm text-muted-foreground', className)}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => <hr className={cn('my-8 border-border', className)} {...props} />,
  a: ({ className, ...props }) => (
    <a
      className={cn('underline underline-offset-4 decoration-border hover:decoration-foreground', className)}
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = String(className || '').includes('language-');
    if (isBlock) {
      return (
        <code className={cn('block font-mono text-xs leading-6', className)} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className={cn('rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]', className)} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ className, ...props }) => (
    <pre
      className={cn('my-4 overflow-x-auto rounded-lg border border-border bg-muted/50 p-4', className)}
      {...props}
    />
  ),
  table: ({ className, ...props }) => (
    <div className="my-4 overflow-x-auto rounded-lg border border-border">
      <table className={cn('w-full border-collapse text-sm', className)} {...props} />
    </div>
  ),
  thead: ({ className, ...props }) => <thead className={cn('bg-muted/60', className)} {...props} />,
  th: ({ className, ...props }) => (
    <th
      className={cn('border-b border-border px-3 py-2 text-left text-xs font-medium whitespace-nowrap', className)}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td className={cn('border-b border-border px-3 py-2 align-top last:border-r-0', className)} {...props} />
  ),
  img: ({ className, ...props }) => (
    <img className={cn('my-4 max-w-full rounded-lg border border-border', className)} {...props} />
  ),
};

export function Markdown({ children, urlTransform }: { children: string; urlTransform?: (url: string) => string }) {
  return (
    <div className="max-w-[76ch]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
