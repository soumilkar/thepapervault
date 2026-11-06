import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const REMARK_PLUGINS = [remarkGfm];

function isSafeMarkdownUrl(url?: string): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  // Safe protocols: http, https, mailto, tel, or internal relative path (#, /)
  return /^(?:https?:|mailto:|tel:|\/|#)/i.test(trimmed);
}

function isSafeMarkdownImageSrc(url?: string): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  // Only allow HTTPS or same-origin relative images (never unencrypted http:// tracking pixels)
  return /^(?:https:\/\/|\/[^/])/i.test(trimmed);
}

const MARKDOWN_COMPONENTS: Components = {
  h1: ({ node: _node, ...p }) => (
    <h1 className="font-serif text-3xl text-primary mt-5 mb-2.5" {...p} />
  ),
  h2: ({ node: _node, ...p }) => (
    <h2 className="font-serif text-2xl text-primary mt-5 mb-2" {...p} />
  ),
  h3: ({ node: _node, ...p }) => (
    <h3 className="font-serif text-xl text-primary mt-4 mb-1.5" {...p} />
  ),
  p: ({ node: _node, ...p }) => <p className="leading-relaxed my-2.5" {...p} />,
  ul: ({ node: _node, ...p }) => <ul className="my-3 list-disc pl-5 space-y-1.5" {...p} />,
  ol: ({ node: _node, ...p }) => <ol className="my-3 list-decimal pl-5 space-y-1.5" {...p} />,
  li: ({ node: _node, ...p }) => <li className="leading-relaxed" {...p} />,
  a: ({ node: _node, href, children, ...p }) => {
    const isSafe = isSafeMarkdownUrl(href);
    return (
      <a
        className="text-accent underline underline-offset-2 hover:text-primary"
        target="_blank"
        rel="noreferrer noopener"
        href={isSafe ? href : undefined}
        {...p}
      >
        {children}
      </a>
    );
  },
  blockquote: ({ node: _node, ...p }) => (
    <blockquote className="my-3 border-l-2 border-accent/60 pl-3.5 italic text-sepia" {...p} />
  ),
  code: ({ node: _node, className, children, ...p }) => {
    const isBlock = (className || "").includes("language-");
    if (isBlock) {
      return (
        <pre className="my-3 overflow-x-auto rounded-md bg-secondary/60 p-3 text-sm">
          <code className={className} {...p}>
            {children}
          </code>
        </pre>
      );
    }
    return (
      <code className="rounded bg-secondary px-1 py-0.5 text-sm" {...p}>
        {children}
      </code>
    );
  },
  hr: () => <hr className="my-4 border-border" />,
  img: ({ node: _node, src, alt }) => {
    const safeSrc = typeof src === "string" && isSafeMarkdownImageSrc(src) ? src : undefined;
    if (!safeSrc) return null;
    return (
      <span className="my-4 block rounded-2xl border border-border bg-secondary/35 p-2.5 sm:p-3.5">
        <img
          src={safeSrc}
          alt={alt ?? ""}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="block max-h-[28rem] w-full rounded-xl border border-border/80 bg-card object-contain"
        />
      </span>
    );
  },
  strong: ({ node: _node, ...p }) => <strong className="font-semibold text-primary" {...p} />,
  table: ({ node: _node, ...p }) => (
    <div className="my-3 overflow-x-auto">
      <table className="min-w-full text-sm" {...p} />
    </div>
  ),
  th: ({ node: _node, ...p }) => (
    <th className="border-b border-border px-2 py-1 text-left font-semibold" {...p} />
  ),
  td: ({ node: _node, ...p }) => <td className="border-b border-border/60 px-2 py-1" {...p} />,
};

export const Markdown = memo(function Markdown({
  children,
  className = "",
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={`prose-paper ${className}`}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
