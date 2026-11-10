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

export const TASK_LINE_REGEX = /^(\s*[-*+]\s+\[)([ xX])(\]\s*.*)$/;

export function hasChecklistItems(text: string): boolean {
  return text.split("\n").some((line) => TASK_LINE_REGEX.test(line));
}

export function getChecklistStats(text: string): { total: number; checked: number } {
  let total = 0;
  let checked = 0;
  for (const line of text.split("\n")) {
    const match = TASK_LINE_REGEX.exec(line);
    if (match) {
      total += 1;
      if (match[2].toLowerCase() === "x") {
        checked += 1;
      }
    }
  }
  return { total, checked };
}

export function toggleTaskAtIndex(text: string, targetIndex: number): string {
  let currentIndex = 0;
  return text
    .split("\n")
    .map((line) => {
      const match = TASK_LINE_REGEX.exec(line);
      if (!match) return line;
      if (currentIndex === targetIndex) {
        currentIndex += 1;
        const isChecked = match[2].toLowerCase() === "x";
        return `${match[1]}${isChecked ? " " : "x"}${match[3]}`;
      }
      currentIndex += 1;
      return line;
    })
    .join("\n");
}

// Produces a clean single-line plain preview for the Apple Notes middle list pane.
export function noteListSnippet(text: string, max = 90): string {
  const lines = text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*[-*+]\s+\[[ xX]\]\s*/, "☐ ")
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^\s*>\s+/, "")
        .replace(/^\s*[-*+]\s+/, "• ")
        .replace(/!\[[^\]]*\]\([^)]+\)/g, "[Image]")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/(\*\*|__|\*|_|~~|`)/g, "")
        .trim(),
    )
    .filter((line) => line.length > 0 && !isImageUrl(line));

  if (lines.length === 0) return "No additional text";
  const joined = lines.slice(0, 2).join(" · ");
  if (joined.length <= max) return joined;
  return joined.slice(0, max).trimEnd() + "…";
}
