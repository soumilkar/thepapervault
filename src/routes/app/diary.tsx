import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { ImagePlus, Trash2, X, Download, Lock } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { downloadTextFile } from "@/lib/download";
import { useVault } from "@/lib/vault";
import { decryptBytes, decryptText, encryptBlob, encryptText } from "@/lib/crypto";


export const Route = createFileRoute("/app/diary")({
  component: DiaryPage,
});

type DiaryRowRaw = {
  id: string;
  title: string | null;
  content: string;
  mood: string | null;
  entry_date: string;
  image_path: string | null;
  iv: string | null;
};
type Decrypted = { id: string; title: string; content: string; mood: string; entry_date: string; image_url: string | null };

function DiaryPage() {
  const { user } = Route.useRouteContext();
  const { key } = useVault();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [mood, setMood] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!photo) { setPhotoPreview(null); return; }
    const url = URL.createObjectURL(photo);
    setPhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const entries = useQuery({
    enabled: !!key,
    queryKey: ["diary", user.id],
    queryFn: async (): Promise<Decrypted[]> => {
      const { data, error } = await supabase
        .from("diary_entries").select("id,title,content,mood,entry_date,image_path,iv" as never).eq("user_id", user.id)
        .order("entry_date", { ascending: false }).order("created_at", { ascending: false });
      if (error) throw error;
      const rows = (data ?? []) as unknown as DiaryRowRaw[];
      const out: Decrypted[] = [];
      for (const row of rows) {
        let title = row.title ?? "";
        let content = row.content;
        let mood = row.mood ?? "";
        if (row.iv && key) {
          try {
            const plain = await decryptText(key, row.content, row.iv);
            const obj = JSON.parse(plain) as { t?: string; c?: string; m?: string };
            title = obj.t ?? "";
            content = obj.c ?? "";
            mood = obj.m ?? "";
          } catch {
            content = "[Could not decrypt this entry]";
          }
        }
        let image_url: string | null = null;
        if (row.image_path) {
          image_url = await decryptImage(row.image_path, key);
        }
        out.push({ id: row.id, title, content, mood, entry_date: row.entry_date, image_url });
      }
      return out;
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!key) throw new Error("Vault is locked");
      let imagePath: string | null = null;
      if (photo) {
        const ALLOWED: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
        if (!ALLOWED[photo.type]) throw new Error("Only JPEG, PNG, WebP, or GIF images are allowed");
        if (photo.size > 5 * 1024 * 1024) throw new Error("Photo must be smaller than 5 MB");
        imagePath = `${user.id}/${crypto.randomUUID()}.bin`;
        const { blob, iv } = await encryptBlob(key, photo);
        const { error: upErr } = await supabase.storage.from("gallery").upload(imagePath, blob, { contentType: "application/octet-stream" });
        if (upErr) throw upErr;
        const captionPlain = title || (content.slice(0, 60) || "from my diary");
        const { ct: capCt, iv: capIv } = await encryptText(key, captionPlain);
        const { error: gErr } = await supabase.from("gallery_images").insert({
          user_id: user.id, storage_path: imagePath, caption: capCt,
          // @ts-expect-error generated types may lag the migration
          iv, caption_iv: capIv, mime: photo.type,
        });
        if (gErr) throw gErr;
      }
      const plaintext = JSON.stringify({ t: title, c: content, m: mood });
      const { ct, iv } = await encryptText(key, plaintext);
      const { error } = await supabase.from("diary_entries").insert({
        user_id: user.id, title: null, content: ct, mood: null, image_path: imagePath, visibility: "private",
        // @ts-expect-error generated types may lag the migration
        iv,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setTitle(""); setContent(""); setMood(""); setPhoto(null);
      toast.success("Entry saved (encrypted)");
      qc.invalidateQueries({ queryKey: ["diary"] });
      qc.invalidateQueries({ queryKey: ["gallery"] });
      qc.invalidateQueries({ queryKey: ["dashboard-counts"] });
      qc.invalidateQueries({ queryKey: ["recent-diary"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("diary_entries").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["diary"] }),
  });

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="font-hand text-2xl text-sepia">today's page</p>
          <h1 className="font-serif text-4xl text-primary">Diary</h1>
          <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><Lock className="size-3" /> End-to-end encrypted with your vault passphrase.</p>
        </div>
        <button
          type="button"
          onClick={() => {
            const rows = entries.data ?? [];
            if (!rows.length) { toast.error("No entries to export yet"); return; }
            const txt = rows.map((e) =>
              `${e.entry_date} — ${e.title || "Untitled"}${e.mood ? `  (feeling: ${e.mood})` : ""}\n${"-".repeat(60)}\n${e.content}\n`
            ).join("\n\n");
            downloadTextFile(`diary-${new Date().toISOString().slice(0, 10)}.txt`, txt);
          }}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm text-primary hover:bg-secondary"
        >
          <Download className="size-4" /> Export
        </button>
      </div>


      <form
        onSubmit={(e) => { e.preventDefault(); if (content.trim()) create.mutate(); }}
        className="paper-card space-y-3 p-6"
      >
        <input
          value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (optional)"
          className="w-full bg-transparent font-serif text-2xl outline-none placeholder:text-muted-foreground/60"
        />
        <input
          value={mood} onChange={(e) => setMood(e.target.value)}
          placeholder="How are you feeling? (e.g. peaceful, anxious, joyful)"
          className="w-full bg-transparent text-sm text-accent outline-none placeholder:text-muted-foreground/60"
        />
        <textarea
          value={content} onChange={(e) => setContent(e.target.value)}
          placeholder="Pour it out..."
          rows={6}
          className="w-full resize-none bg-transparent leading-relaxed outline-none placeholder:text-muted-foreground/60"
        />

        {photoPreview && (
          <div className="relative inline-block">
            <img src={photoPreview} alt="preview" className="max-h-56 rounded-md border border-border" />
            <button type="button" onClick={() => setPhoto(null)}
              className="absolute -right-2 -top-2 rounded-full bg-background p-1 shadow">
              <X className="size-4" />
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-accent hover:text-primary">
            <ImagePlus className="size-4" />
            <span>{photo ? "Change photo" : "Add a photo (also saved to gallery)"}</span>
            <input type="file" accept="image/*" className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  if (f.size > 5 * 1024 * 1024) { toast.error("Photo must be smaller than 5 MB"); }
                  else { setPhoto(f); }
                }
                e.currentTarget.value = "";
              }} />
          </label>

          <button
            type="submit" disabled={!content.trim() || create.isPending}
            className="rounded-md bg-primary px-5 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            {create.isPending ? "Encrypting..." : "Save entry"}
          </button>
        </div>
      </form>

      <div className="space-y-4">
        {entries.isLoading && <p className="font-hand text-sepia">decrypting your pages...</p>}
        {entries.data?.length === 0 && <p className="text-muted-foreground">Your diary is a blank page. Start above.</p>}
        {entries.data?.map((e) => (
          <DiaryCard key={e.id} entry={e} onDelete={() => remove.mutate(e.id)} />
        ))}
      </div>
    </div>
  );
}

async function decryptImage(path: string, key: CryptoKey | null): Promise<string | null> {
  const { data: signed } = await supabase.storage.from("gallery").createSignedUrl(path, 60 * 60);
  if (!signed?.signedUrl) return null;
  // Try to fetch metadata to discover IV+MIME
  const { data: meta } = await supabase
    .from("gallery_images").select("iv,mime" as never).eq("storage_path", path).maybeSingle();
  const row = meta as unknown as { iv: string | null; mime: string | null } | null;
  if (!row?.iv || !key) {
    // Plaintext (pre-migration) — return signed URL directly.
    return signed.signedUrl;
  }
  try {
    const res = await fetch(signed.signedUrl);
    const ct = await res.arrayBuffer();
    const pt = await decryptBytes(key, ct, row.iv);
    const blob = new Blob([pt], { type: row.mime || "image/jpeg" });
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

function DiaryCard({ entry: e, onDelete }: { entry: Decrypted; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const long = e.content.length > 220 || !!e.image_url;
  const preview = e.content.length > 220 ? e.content.slice(0, 220).trimEnd() + "…" : e.content;
  return (
    <article className="paper-card p-6">
      <header className="flex items-baseline justify-between">
        <button onClick={() => setOpen((o) => !o)} className="text-left font-serif text-xl text-primary hover:underline underline-offset-4">
          {e.title || "Untitled"}
        </button>
        <div className="flex items-center gap-3">
          <span className="font-hand text-sepia">{new Date(e.entry_date).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}</span>
          <button onClick={onDelete} className="text-muted-foreground hover:text-destructive">
            <Trash2 className="size-4" />
          </button>
        </div>
      </header>
      {e.mood && <p className="mt-1 text-sm text-accent">Feeling: {e.mood}</p>}
      {open ? <Markdown>{e.content}</Markdown> : <p className="mt-3 whitespace-pre-wrap leading-relaxed">{preview}</p>}
      {open && e.image_url && (
        <img src={e.image_url} alt="" className="mt-4 max-h-96 rounded-md border border-border" loading="lazy" />
      )}
      {long && (
        <button onClick={() => setOpen((o) => !o)} className="mt-2 text-sm text-accent hover:text-primary">
          {open ? "Show less" : "Read more"}
        </button>
      )}
    </article>
  );
}
