import { Fragment } from "react";

export function mediaUrl(raw: string): { kind: "image" | "video" | "embed"; url: string } | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (/\.(png|jpe?g|gif|webp|avif)(?:$)/i.test(url.pathname)) return { kind: "image", url: url.href };
    if (/\.(mp4|webm|ogg|mov)$/i.test(url.pathname)) return { kind: "video", url: url.href };
    const host = url.hostname.replace(/^www\./, "");
    const id = host === "youtu.be" ? url.pathname.slice(1) : host === "youtube.com" ? (url.searchParams.get("v") || url.pathname.match(/^\/(?:shorts|embed)\/([^/]+)/)?.[1]) : null;
    if (id && /^[\w-]{11}$/.test(id)) return { kind: "embed", url: `https://www.youtube-nocookie.com/embed/${id}` };
    if (host === "vimeo.com" && /^\/\d+$/.test(url.pathname)) return { kind: "embed", url: `https://player.vimeo.com/video${url.pathname}` };
  } catch { /* Ordinary text stays ordinary text. */ }
  return null;
}

export function InlineMedia({ url }: { url: string }) {
  const media = mediaUrl(url);
  if (!media) return <a href={url} target="_blank" rel="noreferrer" className="text-accent underline break-all">{url}</a>;
  if (media.kind === "image") return <img src={media.url} alt="Linked image" loading="lazy" referrerPolicy="no-referrer" className="my-3 block max-h-96 max-w-full rounded-md object-contain" />;
  if (media.kind === "video") return <video src={media.url} controls preload="metadata" className="my-3 block max-h-96 w-full rounded-md" />;
  return <iframe src={media.url} title="Linked video" loading="lazy" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-presentation" allow="fullscreen; picture-in-picture" allowFullScreen className="my-3 aspect-video w-full rounded-md border-0" />;
}

export function WrittenText({ children, className = "" }: { children: string; className?: string }) {
  const parts = children.split(/(https?:\/\/[^\s<>]+)/g);
  return <div className={`whitespace-pre-wrap break-words leading-relaxed [overflow-wrap:anywhere] ${className}`}>
    {parts.map((part, i) => {
      if (!/^https?:\/\//.test(part)) return <Fragment key={i}>{part}</Fragment>;
      const url = part.replace(/[.,;!?\)\]]+$/, "");
      return <Fragment key={i}><InlineMedia url={url} />{part.slice(url.length)}</Fragment>;
    })}
  </div>;
}