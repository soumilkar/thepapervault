import { useState } from "react";
import { ImagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function ImageLinkButton({ onInsert }: { onInsert: (image: string) => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [alt, setAlt] = useState("");
  const [error, setError] = useState("");
  const insert = () => {
    try {
      const parsed = new URL(url.trim());
      if (!["https:", "http:"].includes(parsed.protocol)) throw new Error();
      const safeUrl = parsed.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
      onInsert(`![${alt.replace(/[\[\]\n]/g, " ").trim()}](${safeUrl})`);
      setUrl(""); setAlt(""); setError(""); setOpen(false);
    } catch { setError("Enter a valid http or https image URL."); }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" title="Insert image link" aria-label="Insert image link"><ImagePlus className="size-4" /> Image link</Button></PopoverTrigger>
      <PopoverContent className="w-80 max-w-[calc(100vw-2rem)] space-y-3" align="start">
        <p className="text-sm font-medium">Insert image link</p>
        <Input aria-label="Image URL" placeholder="https://…" value={url} onChange={(e) => { setUrl(e.target.value); setError(""); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); insert(); } }} />
        <Input aria-label="Image description" placeholder="Description (optional)" value={alt} onChange={(e) => setAlt(e.target.value)} />
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <Button type="button" size="sm" disabled={!url.trim()} onClick={insert}>Insert</Button>
      </PopoverContent>
    </Popover>
  );
}