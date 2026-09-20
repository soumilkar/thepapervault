import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div className={`prose-paper min-w-0 ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ node, ...p }) => <h1 className="font-serif text-2xl text-primary mt-4 mb-2" {...p} />,
          h2: ({ node, ...p }) => <h2 className="font-serif text-xl text-primary mt-4 mb-2" {...p} />,
          h3: ({ node, ...p }) => <h3 className="font-serif text-lg text-primary mt-3 mb-1.5" {...p} />,
          p: ({ node, ...p }) => <p className="mb-3 whitespace-pre-wrap leading-relaxed last:mb-0" {...p} />,
          ul: ({ node, ...p }) => <ul className="my-2 list-disc pl-5 space-y-1" {...p} />,
          ol: ({ node, ...p }) => <ol className="my-2 list-decimal pl-5 space-y-1" {...p} />,
          li: ({ node, ...p }) => <li className="leading-relaxed" {...p} />,
          a: ({ node, ...p }) => <a className="text-accent underline underline-offset-2 hover:text-primary" target="_blank" rel="noreferrer" {...p} />,
          blockquote: ({ node, ...p }) => <blockquote className="my-2 border-l-2 border-accent/60 pl-3 italic text-sepia" {...p} />,
          code: ({ node, className, children, ...p }) => {
            const isBlock = (className || "").includes("language-");
            if (isBlock) {
              return (
                <pre className="my-3 overflow-x-auto rounded-md bg-secondary/60 p-3 text-sm">
                  <code className={className} {...p}>{children}</code>
                </pre>
              );
            }
            return <code className="rounded bg-secondary px-1 py-0.5 text-sm" {...p}>{children}</code>;
          },
          hr: () => <hr className="my-4 border-border" />,
          strong: ({ node, ...p }) => <strong className="font-semibold text-primary" {...p} />,
          table: ({ node, ...p }) => <div className="my-3 overflow-x-auto"><table className="min-w-full text-sm" {...p} /></div>,
          th: ({ node, ...p }) => <th className="border-b border-border px-2 py-1 text-left font-semibold" {...p} />,
          td: ({ node, ...p }) => <td className="border-b border-border/60 px-2 py-1" {...p} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
