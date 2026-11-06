// Turns plain writing into markdown that keeps line breaks and shows pasted HTTPS image links inline.
const IMAGE_URL = /^(https:\/\/[^\s<>()]+?\.(?:png|jpe?g|gif|webp|avif|bmp)(?:\?[^\s<>()]*)?)$/i;

export function isImageUrl(s: string) {
  return IMAGE_URL.test(s.trim());
}

export function toRichMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (isImageUrl(t)) return `\n![](${t})\n`;
      return line;
    })
    .join("  \n");
}

export function hasImageLinks(text: string) {
  return text.split("\n").some((l) => isImageUrl(l));
}

// Cut a preview without breaking an image line in half.
export function previewText(text: string, max = 220) {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.slice(0, max);
  const lastNl = cut.lastIndexOf("\n");
  const lastLine = cut.slice(lastNl + 1);
  const safe = /https?:\/\//.test(lastLine) ? cut.slice(0, Math.max(0, lastNl)) : cut;
  return { text: safe.trimEnd() + "…", truncated: true };
}
