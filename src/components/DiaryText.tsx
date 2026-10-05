export function DiaryText({ content, expanded = true, limit = 220 }: { content: string; expanded?: boolean; limit?: number }) {
  const text = !expanded && content.length > limit ? `${content.slice(0, limit).trimEnd()}…` : content;
  return <p className="mt-3 whitespace-pre-wrap break-words leading-relaxed text-foreground/90">{text}</p>;
}
