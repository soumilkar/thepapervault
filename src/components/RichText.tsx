import { Markdown } from "@/components/Markdown";
import { toRichMarkdown } from "@/lib/rich-text";

// Same rendering for previews and expanded views: line breaks kept, image links shown inline in order.
export function RichText({ children, className = "" }: { children: string; className?: string }) {
  return <Markdown className={className}>{toRichMarkdown(children)}</Markdown>;
}
