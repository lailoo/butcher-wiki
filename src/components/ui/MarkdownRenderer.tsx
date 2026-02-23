'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        h1: ({ children }) => <h1 className="text-2xl font-bold mt-8 mb-4 text-[var(--text-primary)]">{children}</h1>,
        h2: ({ children }) => <h2 className="text-xl font-semibold mt-8 mb-3 text-[var(--text-primary)] border-b border-[var(--glass-border)] pb-2">{children}</h2>,
        h3: ({ children }) => <h3 className="text-lg font-medium mt-6 mb-2 text-[var(--text-primary)]">{children}</h3>,
        h4: ({ children }) => <h4 className="text-base font-medium mt-4 mb-2 text-[var(--text-secondary)]">{children}</h4>,
        p: ({ children }) => <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-3">{children}</p>,
        ul: ({ children }) => <ul className="list-disc list-inside space-y-1 mb-4 text-sm text-[var(--text-secondary)]">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside space-y-1 mb-4 text-sm text-[var(--text-secondary)]">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--accent-blue)] hover:underline">{children}</a>,
        code: ({ className, children, ...props }) => {
          const isBlock = className?.includes('language-');
          if (isBlock) {
            return <code className={`${className} text-xs`} {...props}>{children}</code>;
          }
          return <code className="bg-[var(--code-bg)] border border-[var(--glass-border)] rounded px-1.5 py-0.5 text-xs font-mono text-[var(--accent-blue)]" {...props}>{children}</code>;
        },
        pre: ({ children }) => <pre className="bg-[var(--bg-secondary)] border border-[var(--glass-border)] rounded-lg p-4 overflow-x-auto mb-4 text-xs leading-relaxed">{children}</pre>,
        table: ({ children }) => <div className="overflow-x-auto mb-4"><table className="w-full text-sm border-collapse">{children}</table></div>,
        thead: ({ children }) => <thead className="border-b border-[var(--glass-border)]">{children}</thead>,
        th: ({ children }) => <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-3 py-2">{children}</th>,
        td: ({ children }) => <td className="text-sm text-[var(--text-secondary)] px-3 py-2 border-b border-[var(--glass-border)]/50">{children}</td>,
        blockquote: ({ children }) => <blockquote className="border-l-2 border-[var(--accent-blue)]/40 pl-4 my-4 text-sm text-[var(--text-muted)] italic">{children}</blockquote>,
        hr: () => <hr className="border-[var(--glass-border)] my-8" />,
        strong: ({ children }) => <strong className="font-semibold text-[var(--text-primary)]">{children}</strong>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
