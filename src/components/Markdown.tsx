import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { TASK_LINE_REGEX } from "@/lib/rich-text";

const REMARK_PLUGINS = [remarkGfm];

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

function isSafeMarkdownUrl(url?: string): boolean {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed || hasControlChars(trimmed)) return false;
  // Internal anchor or strict single-slash relative path (never protocol-relative // or /\)
  if (/^(?:#|\/(?![/\\]))/.test(trimmed)) return true;
  if (/^(?:mailto:|tel:)/i.test(trimmed)) return true;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    if (parsed.username || parsed.password) return false;
    return true;
  } catch {
    return false;
  }
}

function isSafeMarkdownImageSrc(url?: string): boolean {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed || hasControlChars(trimmed)) return false;
  if (/^\/(?![/\\])/.test(trimmed)) return true;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    return true;
  } catch {
    return false;
  }
}

const BASE_MARKDOWN_COMPONENTS: Components = {
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
  ul: ({ node: _node, className, ...p }) => {
    const isTaskList = (className || "").includes("contains-task-list");
    return (
      <ul
        className={
          isTaskList
            ? `my-2.5 list-none pl-0.5 space-y-1.5 ${className ?? ""}`
            : `my-3 list-disc pl-5 space-y-1.5 ${className ?? ""}`
        }
        {...p}
      />
    );
  },
  ol: ({ node: _node, ...p }) => <ol className="my-3 list-decimal pl-5 space-y-1.5" {...p} />,
  li: ({ node: _node, className, ...p }) => {
    const isTaskItem = (className || "").includes("task-list-item");
    return (
      <li
        className={
          isTaskItem
            ? `flex items-start gap-2.5 leading-relaxed [&:has(input:checked)]:text-muted-foreground/75 [&:has(input:checked)]:line-through ${className ?? ""}`
            : `leading-relaxed ${className ?? ""}`
        }
        {...p}
      />
    );
  },
  a: ({ node: _node, href, children, ...p }) => {
    const isSafe = isSafeMarkdownUrl(href);
    return (
      <a
        className="text-accent underline underline-offset-2 hover:text-primary"
        target="_blank"
        rel="noreferrer noopener"
        href={isSafe ? href : undefined}
        onClick={(e) => e.stopPropagation()}
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
  onToggleTask,
}: {
  children: string;
  className?: string;
  onToggleTask?: (taskIndex: number) => void;
}) {
  const lineToTaskIndex = useMemo(() => {
    const map = new Map<number, number>();
    const lines = children.split("\n");
    let taskIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      if (TASK_LINE_REGEX.test(lines[i].replace(/\s+$/, ""))) {
        map.set(i + 1, taskIdx++);
      }
    }
    return map;
  }, [children]);

  const components = useMemo<Components>(() => {
    return {
      ...BASE_MARKDOWN_COMPONENTS,
      input: ({ node, type, checked, disabled, ...rest }) => {
        if (type === "checkbox") {
          const line = node?.position?.start?.line ?? -1;
          const taskIdx = lineToTaskIndex.get(line);
          const interactive = Boolean(onToggleTask && taskIdx !== undefined);
          return (
            <input
              type="checkbox"
              checked={Boolean(checked)}
              disabled={!interactive && Boolean(disabled)}
              readOnly={!interactive}
              onClick={(e) => {
                e.stopPropagation();
              }}
              onChange={(e) => {
                e.stopPropagation();
                if (interactive && taskIdx !== undefined) {
                  onToggleTask?.(taskIdx);
                }
              }}
              className={`mt-1 size-4 shrink-0 rounded border-border accent-primary transition ${
                interactive ? "cursor-pointer hover:scale-105" : "cursor-default"
              }`}
            />
          );
        }
        return <input type={type} checked={checked} disabled={disabled} {...rest} />;
      },
    };
  }, [lineToTaskIndex, onToggleTask]);

  return (
    <div className={`prose-paper ${className}`}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
