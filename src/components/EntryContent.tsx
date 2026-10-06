/** Entries retain their written layout; only inline image references are interpreted. */
export function EntryContent({ children, collapsed = false }: { children: string; collapsed?: boolean }) {
  const parts = children.split(/(!\[[^\]\n]*\]\(https?:\/\/[^\s]+\)|https?:\/\/[^\s<>]+\.(?:png|jpe?g|gif|webp)(?:\?[^\s<>]*)?)/gi);
  return (
    <div className={`relative min-w-0 ${collapsed ? "max-h-36 overflow-hidden" : ""}`}>
      <div className="whitespace-pre-wrap break-words leading-relaxed [overflow-wrap:anywhere]">
        {parts.map((part, index) => {
          const image = part.match(/^!\[([^\]\n]*)\]\((https?:\/\/[^\s]+)\)$/i);
          const src = image?.[2] ?? (/^https?:\/\/[^\s<>]+\.(png|jpe?g|gif|webp)(\?[^\s<>]*)?$/i.test(part) ? part : null);
          return src ? <img key={index} src={src} alt={image?.[1] || "Linked image"} loading="lazy" referrerPolicy="no-referrer" className="my-3 max-h-96 max-w-full rounded-md border border-border object-contain" /> : <span key={index}>{part}</span>;
        })}
      </div>
    </div>
  );
}