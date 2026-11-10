import { memo, useMemo } from "react";
import { Markdown } from "@/components/Markdown";
import { toRichMarkdown } from "@/lib/rich-text";

// Same rendering for previews and expanded views: line breaks kept, image links shown inline in order.
export const RichText = memo(function RichText({
  children,
  className = "",
  onToggleTask,
}: {
  children: string;
  className?: string;
  onToggleTask?: (taskIndex: number) => void;
}) {
  const transformed = useMemo(() => toRichMarkdown(children), [children]);
  return (
    <Markdown className={className} onToggleTask={onToggleTask}>
      {transformed}
    </Markdown>
  );
});
