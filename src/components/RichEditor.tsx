import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { Bold, Italic, Quote, List, Link2, ImagePlus, X } from "lucide-react";
import { isImageUrl } from "@/lib/rich-text";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatInlineMarkdownToHtml(raw: string): string {
  let s = escapeHtml(raw);
  // Markdown links: [label](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
    return `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  // Bold: **text**
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italic: *text*
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  return s;
}

function buildImageBlockHtml(url: string): string {
  const safeUrl = escapeHtml(url.trim());
  return `<div contenteditable="false" data-md-image="${safeUrl}" class="my-3 rounded-2xl border border-border bg-secondary/35 p-2.5 sm:p-3.5 select-none"><img src="${safeUrl}" alt="" class="block max-h-[28rem] w-full rounded-xl border border-border/80 bg-card object-contain" /></div>`;
}

export function markdownToHtml(md: string): string {
  if (!md) return "<p><br></p>";
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Standalone image URL or ![](url)
    const mdImgMatch = /^!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)$/.exec(trimmed);
    const imgUrl = mdImgMatch ? mdImgMatch[1] : isImageUrl(trimmed) ? trimmed : null;
    if (imgUrl) {
      closeList();
      out.push(buildImageBlockHtml(imgUrl));
      continue;
    }

    // Unordered list item: - item or * item
    const ulMatch = /^[-*]\s+(.*)$/.exec(line);
    if (ulMatch) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      const itemHtml = formatInlineMarkdownToHtml(ulMatch[1]);
      out.push(`<li>${itemHtml || "<br>"}</li>`);
      continue;
    }

    closeList();

    // Headings
    if (line.startsWith("### ")) {
      const h = formatInlineMarkdownToHtml(line.slice(4));
      out.push(`<h3>${h || "<br>"}</h3>`);
      continue;
    }
    if (line.startsWith("## ")) {
      const h = formatInlineMarkdownToHtml(line.slice(3));
      out.push(`<h2>${h || "<br>"}</h2>`);
      continue;
    }
    if (line.startsWith("# ")) {
      const h = formatInlineMarkdownToHtml(line.slice(2));
      out.push(`<h1>${h || "<br>"}</h1>`);
      continue;
    }

    // Blockquote
    if (line.startsWith("> ") || line === ">") {
      const q = formatInlineMarkdownToHtml(line.replace(/^>\s?/, ""));
      out.push(`<blockquote>${q || "<br>"}</blockquote>`);
      continue;
    }

    // Normal paragraph line
    const p = formatInlineMarkdownToHtml(line);
    out.push(`<p>${p || "<br>"}</p>`);
  }

  closeList();
  return out.join("") || "<p><br></p>";
}

function serializeInline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").replace(/\u00A0/g, " ");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName.toUpperCase();

  if (el.hasAttribute("data-md-image")) {
    return el.getAttribute("data-md-image") ?? "";
  }
  if (tag === "BR") return "";
  if (tag === "IMG") {
    const src = el.getAttribute("src") ?? "";
    return src ? `\n${src}\n` : "";
  }

  const inner = Array.from(el.childNodes).map(serializeInline).join("");
  if (!inner) return "";

  if (tag === "STRONG" || tag === "B") {
    const trimmed = inner.trim();
    if (!trimmed) return inner;
    const lead = inner.startsWith(" ") ? " " : "";
    const trail = inner.endsWith(" ") ? " " : "";
    return `${lead}**${trimmed}**${trail}`;
  }
  if (tag === "EM" || tag === "I") {
    const trimmed = inner.trim();
    if (!trimmed) return inner;
    const lead = inner.startsWith(" ") ? " " : "";
    const trail = inner.endsWith(" ") ? " " : "";
    return `${lead}*${trimmed}*${trail}`;
  }
  if (tag === "A") {
    const href = el.getAttribute("href") ?? "";
    if (!href || inner === href) return inner;
    return `[${inner}](${href})`;
  }
  return inner;
}

export function htmlToMarkdown(root: HTMLElement): string {
  const lines: string[] = [];

  const processBlock = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const txt = (node.textContent ?? "").replace(/\u00A0/g, " ");
      if (txt.trim()) lines.push(txt);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toUpperCase();

    if (el.hasAttribute("data-md-image")) {
      const url = el.getAttribute("data-md-image") ?? "";
      if (url) lines.push(url);
      return;
    }

    if (tag === "H1") {
      const t = serializeInline(el).trim();
      if (t) lines.push(`# ${t}`);
      return;
    }
    if (tag === "H2") {
      const t = serializeInline(el).trim();
      if (t) lines.push(`## ${t}`);
      return;
    }
    if (tag === "H3") {
      const t = serializeInline(el).trim();
      if (t) lines.push(`### ${t}`);
      return;
    }
    if (tag === "BLOCKQUOTE") {
      const childBlocks = Array.from(el.childNodes);
      const hasNestedBlocks = childBlocks.some(
        (c) => c.nodeType === Node.ELEMENT_NODE && ["P", "DIV"].includes((c as HTMLElement).tagName.toUpperCase()),
      );
      if (hasNestedBlocks) {
        for (const c of childBlocks) {
          const t = serializeInline(c).trim();
          if (t) lines.push(`> ${t}`);
        }
      } else {
        const t = serializeInline(el).trim();
        if (t) lines.push(`> ${t}`);
      }
      return;
    }
    if (tag === "UL") {
      for (const li of Array.from(el.children)) {
        if (li.tagName.toUpperCase() === "LI") {
          const t = serializeInline(li).trim();
          if (t) lines.push(`- ${t}`);
        }
      }
      return;
    }
    if (tag === "OL") {
      Array.from(el.children).forEach((li, idx) => {
        if (li.tagName.toUpperCase() === "LI") {
          const t = serializeInline(li).trim();
          if (t) lines.push(`${idx + 1}. ${t}`);
        }
      });
      return;
    }
    if (tag === "P" || tag === "DIV") {
      // Check if div/p wraps block elements
      const hasBlockChild = Array.from(el.children).some((c) =>
        ["H1", "H2", "H3", "BLOCKQUOTE", "UL", "OL", "P", "DIV"].includes(c.tagName.toUpperCase()) ||
        c.hasAttribute("data-md-image"),
      );
      if (hasBlockChild) {
        Array.from(el.childNodes).forEach(processBlock);
        return;
      }
      lines.push(serializeInline(el));
      return;
    }

    const fallback = serializeInline(el);
    if (fallback) lines.push(fallback);
  };

  Array.from(root.childNodes).forEach(processBlock);

  // Trim trailing empty lines while preserving intentional internal blank lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines.join("\n");
}

function getClosestBlockTag(editor: HTMLElement): string | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  let node: Node | null = sel.anchorNode;
  while (node && node !== editor) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = (node as HTMLElement).tagName.toUpperCase();
      if (["H1", "H2", "H3", "BLOCKQUOTE", "LI", "P", "DIV"].includes(tag)) {
        return tag;
      }
    }
    node = node.parentNode;
  }
  return null;
}

export type RichEditorProps = {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  minHeightClass?: string;
  onPhotoClick?: () => void;
  photoLabel?: string;
  toolbarRightSlot?: ReactNode;
  toolbarClassName?: string;
  bodyClassName?: string;
  headerSlot?: ReactNode;
  footerSlot?: ReactNode;
  autoFocus?: boolean;
};

export function RichEditor({
  value,
  onChange,
  placeholder = "Jot something down...",
  minHeightClass = "min-h-[240px]",
  onPhotoClick,
  photoLabel = "Photo",
  toolbarRightSlot,
  toolbarClassName = "border-b border-border/80 px-4 py-3 sm:px-6",
  bodyClassName = "space-y-4 px-6 py-8 sm:px-12 sm:py-10",
  headerSlot,
  footerSlot,
  autoFocus = false,
}: RichEditorProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const lastEmittedMdRef = useRef<string>(value);
  const savedRangeRef = useRef<Range | null>(null);

  const [activeFormats, setActiveFormats] = useState({
    h2: false,
    bold: false,
    italic: false,
    quote: false,
    list: false,
  });
  const [linkPromptOpen, setLinkPromptOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkText, setLinkText] = useState("");

  const syncFormats = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return;
    savedRangeRef.current = sel.getRangeAt(0).cloneRange();

    const blockTag = getClosestBlockTag(el);
    let inQuote = false;
    let inList = false;
    let node: Node | null = sel.anchorNode;
    while (node && node !== el) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const t = (node as HTMLElement).tagName.toUpperCase();
        if (t === "BLOCKQUOTE") inQuote = true;
        if (t === "UL" || t === "LI") inList = true;
      }
      node = node.parentNode;
    }

    setActiveFormats({
      h2: blockTag === "H2",
      bold: document.queryCommandState("bold"),
      italic: document.queryCommandState("italic"),
      quote: inQuote,
      list: inList,
    });
  }, []);

  // Initialize & sync external value changes without disrupting cursor during typing
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (value !== lastEmittedMdRef.current || el.innerHTML === "") {
      lastEmittedMdRef.current = value;
      el.innerHTML = markdownToHtml(value);
    }
  }, [value]);

  useEffect(() => {
    if (autoFocus && editorRef.current) {
      editorRef.current.focus();
    }
  }, [autoFocus]);

  const emitChange = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const md = htmlToMarkdown(el);
    lastEmittedMdRef.current = md;
    onChange(md);
    syncFormats();
  }, [onChange, syncFormats]);

  const restoreSelection = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (!sel) return;
    if (savedRangeRef.current && el.contains(savedRangeRef.current.startContainer)) {
      sel.removeAllRanges();
      sel.addRange(savedRangeRef.current);
      return;
    }
    if (!el.firstChild) {
      el.innerHTML = "<p><br></p>";
    }
    const target = el.firstChild ?? el;
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    savedRangeRef.current = range.cloneRange();
  }, []);

  const handleToolbarAction = useCallback(
    (kind: "h2" | "bold" | "italic" | "quote" | "list") => {
      const el = editorRef.current;
      if (!el) return;
      restoreSelection();

      if (kind === "bold") {
        document.execCommand("bold", false);
      } else if (kind === "italic") {
        document.execCommand("italic", false);
      } else if (kind === "list") {
        document.execCommand("insertUnorderedList", false);
      } else if (kind === "h2") {
        const currentTag = getClosestBlockTag(el);
        if (currentTag === "H2") {
          document.execCommand("formatBlock", false, "p");
        } else {
          document.execCommand("formatBlock", false, "h2");
        }
      } else if (kind === "quote") {
        let inQuote = false;
        const sel = window.getSelection();
        let node: Node | null = sel?.anchorNode ?? null;
        while (node && node !== el) {
          if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName.toUpperCase() === "BLOCKQUOTE") {
            inQuote = true;
            break;
          }
          node = node.parentNode;
        }
        if (inQuote) {
          document.execCommand("formatBlock", false, "p");
        } else {
          document.execCommand("formatBlock", false, "blockquote");
        }
      }

      emitChange();
    },
    [restoreSelection, emitChange],
  );

  const handleInsertLink = useCallback(() => {
    const rawUrl = linkUrl.trim();
    if (!rawUrl) return;
    const el = editorRef.current;
    if (!el) return;
    restoreSelection();

    if (isImageUrl(rawUrl)) {
      document.execCommand("insertHTML", false, `${buildImageBlockHtml(rawUrl)}<p><br></p>`);
    } else {
      const label = escapeHtml(linkText.trim() || rawUrl);
      const safeHref = escapeHtml(rawUrl);
      document.execCommand(
        "insertHTML",
        false,
        `<a href="${safeHref}" target="_blank" rel="noreferrer">${label}</a>&nbsp;`,
      );
    }

    setLinkUrl("");
    setLinkText("");
    setLinkPromptOpen(false);
    emitChange();
  }, [linkUrl, linkText, restoreSelection, emitChange]);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = editorRef.current;
    if (!el) return;

    // Exit H2 or BLOCKQUOTE cleanly on Enter into a fresh paragraph
    if (e.key === "Enter" && !e.shiftKey) {
      const blockTag = getClosestBlockTag(el);
      if (blockTag === "H2" || blockTag === "H1" || blockTag === "H3" || blockTag === "BLOCKQUOTE") {
        e.preventDefault();
        document.execCommand("insertParagraph", false);
        document.execCommand("formatBlock", false, "p");
        emitChange();
        return;
      }
    }

    // Live markdown prefix conversion on Space (e.g. typing "## ", "> ", "- ")
    if (e.key === " ") {
      const sel = window.getSelection();
      if (sel && sel.isCollapsed && sel.anchorNode?.nodeType === Node.TEXT_NODE) {
        const textNode = sel.anchorNode as Text;
        const textBefore = textNode.textContent?.slice(0, sel.anchorOffset) ?? "";
        if (textBefore === "##" || textBefore === "#") {
          e.preventDefault();
          textNode.textContent = textNode.textContent?.slice(sel.anchorOffset) ?? "";
          document.execCommand("formatBlock", false, textBefore === "##" ? "h2" : "h1");
          emitChange();
          return;
        }
        if (textBefore === ">") {
          e.preventDefault();
          textNode.textContent = textNode.textContent?.slice(sel.anchorOffset) ?? "";
          document.execCommand("formatBlock", false, "blockquote");
          emitChange();
          return;
        }
        if (textBefore === "-" || textBefore === "*") {
          e.preventDefault();
          textNode.textContent = textNode.textContent?.slice(sel.anchorOffset) ?? "";
          document.execCommand("insertUnorderedList", false);
          emitChange();
          return;
        }
      }
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const pastedText = e.clipboardData.getData("text/plain").trim();
    if (pastedText && isImageUrl(pastedText)) {
      e.preventDefault();
      document.execCommand("insertHTML", false, `${buildImageBlockHtml(pastedText)}<p><br></p>`);
      emitChange();
    }
  };

  const isEmpty = !value.trim();

  return (
    <div>
      {/* Formatting & Media Toolbar */}
      <div className={`flex flex-wrap items-center justify-between gap-2 ${toolbarClassName}`}>
        <div className="flex items-center gap-1 sm:gap-2">
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              handleToolbarAction("h2");
            }}
            title="Subheading (H2)"
            className={`rounded-md px-2 py-1.5 text-xs font-bold tracking-tight transition ${
              activeFormats.h2
                ? "bg-secondary text-primary shadow-2xs"
                : "text-foreground/80 hover:bg-secondary hover:text-primary"
            }`}
          >
            H<sub className="text-[10px]">2</sub>
          </button>
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              handleToolbarAction("bold");
            }}
            title="Bold"
            className={`rounded-md p-1.5 transition ${
              activeFormats.bold
                ? "bg-secondary text-primary shadow-2xs"
                : "text-foreground/80 hover:bg-secondary hover:text-primary"
            }`}
          >
            <Bold className="size-4" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              handleToolbarAction("italic");
            }}
            title="Italic"
            className={`rounded-md p-1.5 transition ${
              activeFormats.italic
                ? "bg-secondary text-primary shadow-2xs"
                : "text-foreground/80 hover:bg-secondary hover:text-primary"
            }`}
          >
            <Italic className="size-4" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              handleToolbarAction("quote");
            }}
            title="Quote"
            className={`rounded-md p-1.5 transition ${
              activeFormats.quote
                ? "bg-secondary text-primary shadow-2xs"
                : "text-foreground/80 hover:bg-secondary hover:text-primary"
            }`}
          >
            <Quote className="size-4" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              handleToolbarAction("list");
            }}
            title="Bullet list"
            className={`rounded-md p-1.5 transition ${
              activeFormats.list
                ? "bg-secondary text-primary shadow-2xs"
                : "text-foreground/80 hover:bg-secondary hover:text-primary"
            }`}
          >
            <List className="size-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          {onPhotoClick && (
            <button
              type="button"
              onClick={onPhotoClick}
              className="inline-flex items-center gap-1.5 text-sm text-foreground/80 transition hover:text-primary"
            >
              <ImagePlus className="size-4 text-sepia" />
              <span>{photoLabel}</span>
            </button>
          )}

          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              syncFormats();
              setLinkPromptOpen((o) => !o);
            }}
            className="inline-flex items-center gap-1.5 text-sm text-foreground/80 transition hover:text-primary"
          >
            <Link2 className="size-4 text-sepia" />
            <span>Link</span>
          </button>

          {toolbarRightSlot}
        </div>
      </div>

      {/* Optional Link / Inline Image URL Insertion Bar */}
      {linkPromptOpen && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border/70 bg-secondary/25 px-4 py-2.5 text-sm sm:px-6">
          <input
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="Paste image link (.jpg, .png, .webp, .svg) or URL..."
            className="min-w-[220px] flex-1 rounded-md border border-input bg-card px-2.5 py-1 text-sm outline-none"
          />
          <input
            value={linkText}
            onChange={(e) => setLinkText(e.target.value)}
            placeholder="Link label (for non-image URLs)"
            className="w-48 rounded-md border border-input bg-card px-2.5 py-1 text-sm outline-none"
          />
          <button
            type="button"
            onClick={handleInsertLink}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
          >
            Insert
          </button>
          <button
            type="button"
            onClick={() => setLinkPromptOpen(false)}
            className="rounded-md p-1 text-muted-foreground hover:text-primary"
            aria-label="Close link helper"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      {/* Body Content Area */}
      <div className={bodyClassName}>
        {headerSlot}

        {/* WYSIWYG Editable Surface */}
        <div className="relative">
          {isEmpty && !activeFormats.list && !activeFormats.quote && (
            <div
              className={`pointer-events-none absolute left-0 top-0 select-none text-muted-foreground/50 ${
                activeFormats.h2 ? "mt-4 font-serif text-2xl leading-tight" : "text-base leading-relaxed"
              }`}
            >
              {placeholder}
            </div>
          )}
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            onInput={emitChange}
            onKeyUp={syncFormats}
            onMouseUp={syncFormats}
            onFocus={syncFormats}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            className={`${minHeightClass} w-full bg-transparent text-base leading-relaxed text-foreground/90 outline-none [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 [&_b]:font-semibold [&_b]:text-primary [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-accent/60 [&_blockquote]:pl-3.5 [&_blockquote]:italic [&_blockquote]:text-sepia [&_em]:italic [&_h1]:mt-5 [&_h1]:mb-2.5 [&_h1]:font-serif [&_h1]:text-3xl [&_h1]:text-primary [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:font-serif [&_h2]:text-2xl [&_h2]:text-primary [&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:font-serif [&_h3]:text-xl [&_h3]:text-primary [&_i]:italic [&_li]:leading-relaxed [&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_p]:my-1.5 [&_strong]:font-semibold [&_strong]:text-primary [&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5`}
          />
        </div>

        {footerSlot}
      </div>
    </div>
  );
}
