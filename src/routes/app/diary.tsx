import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { ImagePlus, Trash2, X, Download, Pencil, Check, Globe, Lock, FolderPlus, Folder, FileText, Plus } from "lucide-react";
import { DiaryText } from "@/components/DiaryText";
import { Button } from "@/components/ui/button";
import { downloadTextFile } from "@/lib/download";
import { useVault } from "@/lib/vault";
import { decryptBytes, decryptText, encryptBlob, encryptText } from "@/lib/crypto";
import { MusicSearch, MusicPlayer, type SelectedTrack } from "@/components/MusicSearch";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { moodScore } from "@/lib/mood-sentiment";
import { estimateMoodScores } from "@/lib/mood-estimate.functions";
import { transcribeHandwriting } from "@/lib/handwriting.functions";
import { AppSelect } from "@/components/AppSelect";
import { useBrowserDraft } from "@/lib/browser-drafts";

const NONE = "__none__";

function countWords(s: string) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

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
  is_public: boolean;
  folder_id: string | null;
  music_track_id: string | null;
  music_track_name: string | null;
  music_artist: string | null;
  music_preview_url: string | null;
  music_artwork_url: string | null;
  word_count: number | null;
  mood_score: number | null;
  created_at: string;
};
type Entry = {
  id: string; title: string; content: string; mood: string; entry_date: string;
  image_url: string | null; is_public: boolean; folder_id: string | null;
  music: SelectedTrack | null; created_at: string;
};
type Sort = "newest" | "oldest" | "title";

function DiaryPage() {
  const { user } = Route.useRouteContext();
  const { key } = useVault();
  const qc = useQueryClient();
  type DiaryDraft = {
    title: string;
    content: string;
    mood: string;
    isPublic: boolean;
    folderId: string | null;
    music: SelectedTrack | null;
  };
  const [draft, setDraft, clearDraft] = useBrowserDraft<DiaryDraft>(`papervault:diary-draft:${user.id}`, {
    title: "", content: "", mood: "", isPublic: false, folderId: null, music: null,
  });
  const { title, content, mood, isPublic, folderId, music } = draft;
  const setTitle = (value: string) => setDraft((current) => ({ ...current, title: value }));
  const setContent = (value: string) => setDraft((current) => ({ ...current, content: value }));
  const setMood = (value: string) => setDraft((current) => ({ ...current, mood: value }));
  const setIsPublic = (value: boolean) => setDraft((current) => ({ ...current, isPublic: value }));
  const setFolderId = (value: string | null) => setDraft((current) => ({ ...current, folderId: value }));
  const setMusic = (value: SelectedTrack | null) => setDraft((current) => ({ ...current, music: value }));
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  type HandwritingPage = { id: string; file: File; url: string; status: "pending" | "converting" | "done" | "error" };
  const [handwritingPages, setHandwritingPages] = useState<HandwritingPage[]>([]);
  const [filterFolder, setFilterFolder] = useState<string | "all">("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [newFolder, setNewFolder] = useState("");

  useEffect(() => {
    if (!photo) { setPhotoPreview(null); return; }
    const url = URL.createObjectURL(photo);
    setPhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const readAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read that image"));
    reader.onerror = () => reject(new Error("Could not read that image"));
    reader.readAsDataURL(file);
  });

  const setPageStatus = (id: string, status: HandwritingPage["status"]) =>
    setHandwritingPages((pages) => pages.map((p) => (p.id === id ? { ...p, status } : p)));

  const handwriting = useMutation({
    mutationFn: async (pages: HandwritingPage[]) => {
      let converted = 0;
      for (const page of pages) {
        setPageStatus(page.id, "converting");
        try {
          const imageDataUrl = await readAsDataUrl(page.file);
          const { text } = await transcribeHandwriting({ data: { imageDataUrl, mimeType: page.file.type as "image/jpeg" | "image/png" | "image/webp" } });
          if (!text) throw new Error("No handwriting was detected in one of the images. Try a clearer photo.");
           setDraft((current) => ({ ...current, content: current.content.trim() ? `${current.content.trim()}\n\n${text}` : text }));
          setPageStatus(page.id, "done");
          converted += 1;
        } catch (err) {
          setPageStatus(page.id, "error");
          throw err;
        }
      }
      return converted;
    },
    onSuccess: (converted) => {
      toast.success(converted > 1 ? `${converted} pages converted. Review the text before saving.` : "Handwriting converted. Review the text before saving.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const addHandwritingFiles = (files: File[]) => {
    const accepted: HandwritingPage[] = [];
    for (const f of files) {
      if (f.size >= 5 * 1024 * 1024) { toast.error(`"${f.name}" must be smaller than 5 MB`); continue; }
      accepted.push({ id: crypto.randomUUID(), file: f, url: URL.createObjectURL(f), status: "pending" });
    }
    if (!accepted.length) return;
    setHandwritingPages((pages) => [...pages, ...accepted]);
    handwriting.mutate(accepted);
  };

  const removeHandwritingPage = (id: string) =>
    setHandwritingPages((pages) => {
      const page = pages.find((p) => p.id === id);
      if (page) URL.revokeObjectURL(page.url);
      return pages.filter((p) => p.id !== id);
    });

  const folders = useQuery({
    queryKey: ["diary-folders", user.id],
    queryFn: async () => {
      const { data, error } = await supabase.from("diary_folders").select("*").eq("user_id", user.id).order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const entries = useQuery({
    enabled: !!key,
    queryKey: ["diary", user.id],
    queryFn: async (): Promise<Entry[]> => {
      const { data, error } = await supabase.from("diary_entries")
        .select("*")
        .eq("user_id", user.id)
        .order("entry_date", { ascending: false }).order("created_at", { ascending: false });
      if (error) throw error;
      const rows = (data ?? []) as unknown as DiaryRowRaw[];
      const out: Entry[] = [];
      const needsAiMood: { id: string; text: string }[] = [];
      for (const row of rows) {
        let t = row.title ?? "", c = row.content, m = row.mood ?? "";
        let decrypted = false;
        if (row.iv && key) {
          try {
            const plain = await decryptText(key, row.content, row.iv);
            const obj = JSON.parse(plain) as { t?: string; c?: string; m?: string };
            t = obj.t ?? ""; c = obj.c ?? ""; m = obj.m ?? "";
            decrypted = true;
          } catch { c = "[Could not decrypt this entry]"; }
        }
        // Backfill insight metadata for legacy entries so charts don't need to decrypt.
        const isReadable = decrypted || !row.iv;
        if (isReadable && (row.word_count == null || row.word_count === 0) && c) {
          const wc = countWords(c);
          const ms = m ? moodScore(m) : null;
          await supabase.from("diary_entries").update({ word_count: wc, mood_score: ms } as never).eq("id", row.id);
        }
        // Queue for AI mood estimation when no mood text was written.
        if (isReadable && row.mood_score == null && !m && c && c.trim().length > 20 && c !== "[Could not decrypt this entry]") {
          needsAiMood.push({ id: row.id, text: c });
        }
        const image_url = row.image_path ? await loadImage(row.image_path, row.iv ? key : null) : null;
        out.push({
          id: row.id, title: t, content: c, mood: m,
          entry_date: row.entry_date, image_url,
          is_public: row.is_public, folder_id: row.folder_id,
          music: row.music_preview_url ? {
            music_track_id: row.music_track_id ?? "",
            music_track_name: row.music_track_name ?? "",
            music_artist: row.music_artist ?? "",
            music_preview_url: row.music_preview_url,
            music_artwork_url: row.music_artwork_url ?? "",
          } : null,
          created_at: row.created_at,
        });
      }
      // Fire-and-forget AI mood estimation for entries missing a score.
      if (needsAiMood.length > 0) {
        (async () => {
          try {
            for (let i = 0; i < needsAiMood.length; i += 10) {
              const batch = needsAiMood.slice(i, i + 10);
              const { scores } = await estimateMoodScores({ data: { items: batch } });
              await Promise.all(
                scores.map((s) =>
                  supabase.from("diary_entries").update({ mood_score: s.score } as never).eq("id", s.id)
                )
              );
            }
            qc.invalidateQueries({ queryKey: ["mood-timeline"] });
          } catch {
            // silent — mood estimation is best-effort
          }
        })();
      }
      return out;
    },
  });

  const filteredSorted = useMemo(() => {
    let rows = entries.data ?? [];
    if (filterFolder !== "all") rows = rows.filter((e) => (filterFolder === "none" ? !e.folder_id : e.folder_id === filterFolder));
    rows = [...rows].sort((a, b) => {
      if (sort === "title") return (a.title || "").localeCompare(b.title || "");
      const cmp = new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime();
      return sort === "newest" ? -cmp : cmp;
    });
    return rows;
  }, [entries.data, filterFolder, sort]);

  const create = useMutation({
    mutationFn: async () => {
      const musicPatch = {
        music_track_id: music?.music_track_id ?? null,
        music_track_name: music?.music_track_name ?? null,
        music_artist: music?.music_artist ?? null,
        music_preview_url: music?.music_preview_url ?? null,
        music_artwork_url: music?.music_artwork_url ?? null,
      };
      if (isPublic) {
        const { error } = await supabase.from("diary_entries").insert({
          user_id: user.id, title: title || null, content, mood: mood || null,
          is_public: true, folder_id: folderId, visibility: "public_anon",
          word_count: countWords(content), mood_score: mood ? moodScore(mood) : null,
          ...musicPatch,
        } as never);
        if (error) throw error;
        return;
      }
      if (!key) throw new Error("Vault is locked");
      let imagePath: string | null = null;
      if (photo) {
        const ALLOWED: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
        if (!ALLOWED[photo.type]) throw new Error("Only JPEG, PNG, WebP, or GIF images are allowed");
        if (photo.size > 5 * 1024 * 1024) throw new Error("Photo must be smaller than 5 MB");
        imagePath = `${user.id}/${crypto.randomUUID()}.bin`;
        const { blob, iv: imgIv } = await encryptBlob(key, photo);
        const { error: upErr } = await supabase.storage.from("gallery").upload(imagePath, blob, { contentType: "application/octet-stream" });
        if (upErr) throw upErr;
        const captionPlain = title || (content.slice(0, 60) || "from my diary");
        const { ct: capCt, iv: capIv } = await encryptText(key, captionPlain);
        await supabase.from("gallery_images").insert({
          user_id: user.id, storage_path: imagePath, caption: capCt,
          iv: imgIv, caption_iv: capIv, mime: photo.type,
        });
      }
      const plaintext = JSON.stringify({ t: title, c: content, m: mood });
      const { ct, iv } = await encryptText(key, plaintext);
      const { error } = await supabase.from("diary_entries").insert({
        user_id: user.id, title: null, content: ct, mood: null, image_path: imagePath,
        visibility: "private", is_public: false, folder_id: folderId, iv,
        word_count: countWords(content), mood_score: mood ? moodScore(mood) : null,
        ...musicPatch,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
       clearDraft(); setPhoto(null); setHandwritingPages((pages) => { pages.forEach((p) => URL.revokeObjectURL(p.url)); return []; });
      toast.success("Entry saved");
      qc.invalidateQueries({ queryKey: ["diary"] });
      qc.invalidateQueries({ queryKey: ["gallery"] });
      qc.invalidateQueries({ queryKey: ["public-diary-feed"] });
      qc.invalidateQueries({ queryKey: ["dashboard-counts"] });
      qc.invalidateQueries({ queryKey: ["recent-diary"] });
      qc.invalidateQueries({ queryKey: ["streak-diary"] });
      qc.invalidateQueries({ queryKey: ["mood-timeline"] });
      qc.invalidateQueries({ queryKey: ["heatmap-diary"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: async (vars: { id: string; title: string; content: string; mood: string; folder_id: string | null; music: SelectedTrack | null; wasPrivate: boolean }) => {
      const musicPatch = {
        music_track_id: vars.music?.music_track_id ?? null,
        music_track_name: vars.music?.music_track_name ?? null,
        music_artist: vars.music?.music_artist ?? null,
        music_preview_url: vars.music?.music_preview_url ?? null,
        music_artwork_url: vars.music?.music_artwork_url ?? null,
      };
      if (vars.wasPrivate) {
        if (!key) throw new Error("Vault is locked");
        const plaintext = JSON.stringify({ t: vars.title, c: vars.content, m: vars.mood });
        const { ct, iv } = await encryptText(key, plaintext);
        const { error } = await supabase.from("diary_entries").update({
          content: ct, iv, folder_id: vars.folder_id,
          word_count: countWords(vars.content), mood_score: vars.mood ? moodScore(vars.mood) : null,
          ...musicPatch,
        } as never).eq("id", vars.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("diary_entries").update({
          title: vars.title || null, content: vars.content, mood: vars.mood || null,
          folder_id: vars.folder_id,
          word_count: countWords(vars.content), mood_score: vars.mood ? moodScore(vars.mood) : null,
          ...musicPatch,
        } as never).eq("id", vars.id);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success("Entry updated");
      qc.invalidateQueries({ queryKey: ["diary"] });
      qc.invalidateQueries({ queryKey: ["public-diary-feed"] });
      qc.invalidateQueries({ queryKey: ["streak-diary"] });
      qc.invalidateQueries({ queryKey: ["mood-timeline"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("diary_entries").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["diary"] });
      qc.invalidateQueries({ queryKey: ["public-diary-feed"] });
      qc.invalidateQueries({ queryKey: ["dashboard-counts"] });
    },
  });

  const createFolder = useMutation({
    mutationFn: async (name: string) => {
      const { error } = await supabase.from("diary_folders").insert({ user_id: user.id, name });
      if (error) throw error;
    },
    onSuccess: () => { setNewFolder(""); qc.invalidateQueries({ queryKey: ["diary-folders"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-hand text-2xl text-sepia">today's page</p>
          <h1 className="font-serif text-4xl text-primary">Diary</h1>
        </div>
        <button
          type="button"
          onClick={() => {
            const rows = entries.data ?? [];
            if (!rows.length) { toast.error("No entries to export yet"); return; }
            const txt = rows.map((e) =>
              `${e.entry_date} — ${e.title || "Untitled"}${e.mood ? `  (feeling: ${e.mood})` : ""}${e.is_public ? "  [public]" : ""}\n${"-".repeat(60)}\n${e.content}\n`
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
        id="diary-composer" className="paper-card space-y-3 p-5 sm:p-6"
      >
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)"
          className="w-full bg-transparent font-serif text-2xl outline-none placeholder:text-muted-foreground/60" />
        <input value={mood} onChange={(e) => setMood(e.target.value)}
          placeholder="How are you feeling? (e.g. peaceful, anxious, joyful)"
          className="w-full bg-transparent text-sm text-accent outline-none placeholder:text-muted-foreground/60" />
        <textarea value={content} onChange={(e) => setContent(e.target.value)}
          placeholder="Pour it out..." rows={6}
          className="w-full resize-none bg-transparent leading-relaxed outline-none placeholder:text-muted-foreground/60" />

        {handwritingPages.length > 0 && (
          <div className="space-y-2 rounded-md border border-border bg-secondary/50 p-3">
            <p className="text-xs text-muted-foreground">Converted text is added to the box above, one page after another. Please review it before saving.</p>
            {handwritingPages.map((page, i) => (
              <div key={page.id} className="flex items-center gap-3">
                <img src={page.url} alt={`Handwritten page ${i + 1}`} className="h-16 w-12 rounded border border-border object-cover" />
                <div className="min-w-0 flex-1 text-sm">
                  <p className="truncate font-medium text-primary">{page.file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {page.status === "pending" && "Waiting..."}
                    {page.status === "converting" && "Converting..."}
                    {page.status === "done" && "Converted"}
                    {page.status === "error" && "Could not convert"}
                  </p>
                </div>
                <button type="button" onClick={() => removeHandwritingPage(page.id)} disabled={page.status === "converting"} className="text-muted-foreground hover:text-primary disabled:opacity-40" aria-label={`Remove ${page.file.name}`}>
                  <X className="size-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {photoPreview && !isPublic && (
          <div className="relative inline-block">
            <img src={photoPreview} alt="preview" className="max-h-56 rounded-md border border-border" />
            <button type="button" onClick={() => setPhoto(null)}
              className="absolute -right-2 -top-2 rounded-full bg-background p-1 shadow">
              <X className="size-4" />
            </button>
          </div>
        )}

        <MusicSearch selected={music} onChange={setMusic} />

        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">Visibility</span>
            <AppSelect
              value={isPublic ? "public" : "private"}
              onValueChange={(v) => setIsPublic(v === "public")}
              options={[
                { value: "private", label: "Private" },
                { value: "public", label: "Public · anonymous" },
              ]}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">Folder</span>
            <AppSelect
              value={folderId ?? NONE}
              onValueChange={(v) => setFolderId(v === NONE ? null : v)}
              options={[
                { value: NONE, label: "— none —" },
                ...(folders.data ?? []).map((f) => ({ value: f.id, label: f.name })),
              ]}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            {!isPublic && (
              <label className="flex cursor-pointer items-center gap-2 text-sm text-accent hover:text-primary">
                <ImagePlus className="size-4" />
                <span>{photo ? "Change photo" : "Add a photo (also saved to gallery)"}</span>
                <input type="file" accept="image/*" className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      if (f.size >= 5 * 1024 * 1024) toast.error("Photo must be smaller than 5 MB");
                      else setPhoto(f);
                    }
                    e.currentTarget.value = "";
                  }} />
              </label>
            )}
            <label className="flex cursor-pointer items-center gap-2 text-sm text-accent hover:text-primary">
              <FileText className="size-4" />
              <span>{handwriting.isPending ? "Converting..." : "Convert handwritten pages"}</span>
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple className="hidden" disabled={handwriting.isPending}
                onChange={(e) => {
                  addHandwritingFiles(Array.from(e.target.files ?? []));
                  e.currentTarget.value = "";
                }} />
            </label>
          </div>
          {isPublic && <span className="text-xs text-muted-foreground">Public entries appear anonymously in the community Feed.</span>}
          <button type="submit" disabled={!content.trim() || create.isPending}
            className="rounded-md bg-primary px-5 py-2 text-sm text-primary-foreground disabled:opacity-50">
            {create.isPending ? "Saving..." : "Save entry"}
          </button>
        </div>
      </form>

      <div className="paper-card flex flex-wrap items-center gap-3 p-3 text-sm">
        <label className="flex items-center gap-2">
          <Folder className="size-4 text-muted-foreground" />
          <AppSelect
            value={filterFolder}
            onValueChange={(v) => setFilterFolder(v as typeof filterFolder)}
            options={[
              { value: "all", label: "All entries" },
              { value: "none", label: "No folder" },
              ...(folders.data ?? []).map((f) => ({ value: f.id, label: f.name })),
            ]}
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Sort</span>
          <AppSelect
            value={sort}
            onValueChange={(v) => setSort(v as Sort)}
            options={[
              { value: "newest", label: "Newest first" },
              { value: "oldest", label: "Oldest first" },
              { value: "title", label: "Title A–Z" },
            ]}
          />
        </label>
        <form
          onSubmit={(e) => { e.preventDefault(); if (newFolder.trim()) createFolder.mutate(newFolder.trim()); }}
          className="ml-auto flex items-center gap-1"
        >
          <input value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="New folder"
            className="rounded-md border border-input bg-card px-2 py-1" />
          <button type="submit" className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground">
            <FolderPlus className="size-3.5" /> Add
          </button>
        </form>
      </div>

      <div className="space-y-4">
        {entries.isLoading && <p className="font-hand text-sepia">opening your pages...</p>}
        {entries.data?.length === 0 && <p className="text-muted-foreground">Your diary is a blank page. Start above.</p>}
        {filteredSorted.map((e) => (
          <DiaryCard key={e.id} entry={e} folders={folders.data ?? []}
            onDelete={() => remove.mutate(e.id)}
            onSave={(v) => update.mutate({ id: e.id, ...v, wasPrivate: !e.is_public })}
          />
        ))}
      </div>
      <Button className="fixed bottom-6 right-6 z-20 rounded-full shadow-lg" onClick={() => { document.getElementById("diary-composer")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" }); document.querySelector<HTMLInputElement>("#diary-composer input")?.focus({ preventScroll: true }); }}><Plus /> New Entry</Button>
    </div>
  );
}

async function loadImage(path: string, key: CryptoKey | null): Promise<string | null> {
  const { data: signed } = await supabase.storage.from("gallery").createSignedUrl(path, 60 * 60);
  if (!signed?.signedUrl) return null;
  const { data: meta } = await supabase.from("gallery_images").select("iv,mime" as never).eq("storage_path", path).maybeSingle();
  const row = meta as unknown as { iv: string | null; mime: string | null } | null;
  if (!row?.iv || !key) return signed.signedUrl;
  try {
    const res = await fetch(signed.signedUrl);
    const ct = await res.arrayBuffer();
    const pt = await decryptBytes(key, ct, row.iv);
    const blob = new Blob([pt], { type: row.mime || "image/jpeg" });
    return URL.createObjectURL(blob);
  } catch { return null; }
}

function DiaryCard({
  entry: e, folders, onDelete, onSave,
}: {
  entry: Entry;
  folders: { id: string; name: string }[];
  onDelete: () => void;
  onSave: (v: { title: string; content: string; mood: string; folder_id: string | null; music: SelectedTrack | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [eTitle, setETitle] = useState(e.title);
  const [eContent, setEContent] = useState(e.content);
  const [eMood, setEMood] = useState(e.mood);
  const [eFolder, setEFolder] = useState<string | null>(e.folder_id);
  const [eMusic, setEMusic] = useState<SelectedTrack | null>(e.music);
  const [confirmDel, setConfirmDel] = useState(false);
  const long = e.content.length > 220 || !!e.image_url;

  if (editing) {
    return (
      <article className="paper-card space-y-3 p-6">
        <input value={eTitle} onChange={(ev) => setETitle(ev.target.value)} placeholder="Title"
          className="w-full bg-transparent font-serif text-2xl outline-none" />
        <input value={eMood} onChange={(ev) => setEMood(ev.target.value)} placeholder="Feeling"
          className="w-full bg-transparent text-sm text-accent outline-none" />
        <textarea value={eContent} onChange={(ev) => setEContent(ev.target.value)} rows={8}
          className="w-full resize-none bg-transparent leading-relaxed outline-none" />
        <MusicSearch selected={eMusic} onChange={setEMusic} />
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Folder</span>
          <AppSelect
            value={eFolder ?? NONE}
            onValueChange={(v) => setEFolder(v === NONE ? null : v)}
            options={[
              { value: NONE, label: "— none —" },
              ...folders.map((f) => ({ value: f.id, label: f.name })),
            ]}
          />
        </label>
        <div className="flex justify-end gap-2">
          <button onClick={() => setEditing(false)} className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm">
            <X className="size-4" /> Cancel
          </button>
          <button
            onClick={() => { onSave({ title: eTitle, content: eContent, mood: eMood, folder_id: eFolder, music: eMusic }); setEditing(false); }}
            className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
          >
            <Check className="size-4" /> Save
          </button>
        </div>
      </article>
    );
  }

  return (
    <article className="paper-card diary-card p-5 transition-colors sm:p-6">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <button onClick={() => setOpen((o) => !o)} className="min-w-0 break-words text-left font-serif text-xl text-foreground hover:underline underline-offset-4">
          {e.title || "Untitled"}
        </button>
        <div className="flex shrink-0 items-center gap-3">
          <span title={e.is_public ? "Public · anonymous" : "Private"} className="text-muted-foreground">
            {e.is_public ? <Globe className="size-4" /> : <Lock className="size-4" />}
          </span>
          <button onClick={() => { setETitle(e.title); setEContent(e.content); setEMood(e.mood); setEFolder(e.folder_id); setEMusic(e.music); setEditing(true); }} className="text-muted-foreground hover:text-primary" aria-label="Edit">
            <Pencil className="size-4" />
          </button>
          <button onClick={() => setConfirmDel(true)} className="text-muted-foreground hover:text-destructive" aria-label="Delete">
            <Trash2 className="size-4" />
          </button>
        </div>
      </header>
      <p className="mt-2 text-xs text-muted-foreground">{new Date(`${e.entry_date}T12:00:00`).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}</p>
      {e.mood && <span className="mt-3 inline-flex rounded-full bg-mood/10 px-3 py-1 text-xs text-mood">Feeling: {e.mood}</span>}
      <DiaryText content={e.content} expanded={open} />
      {open && e.image_url && (
        <img src={e.image_url} alt="" className="mt-4 max-h-96 rounded-md border border-border" loading="lazy" />
      )}
      {e.music?.music_preview_url && (
        <MusicPlayer track={{
          music_track_name: e.music.music_track_name, music_artist: e.music.music_artist,
          music_preview_url: e.music.music_preview_url, music_artwork_url: e.music.music_artwork_url,
        }} />
      )}
      {long && (
        <button onClick={() => setOpen((o) => !o)} className="mt-2 text-sm text-accent hover:text-primary">
          {open ? "Show less" : "Read more →"}
        </button>
      )}
      <ConfirmDialog
        open={confirmDel} onOpenChange={setConfirmDel}
        title="Delete this diary entry?" description="This can't be undone."
        confirmText="Delete entry"
        onConfirm={() => { onDelete(); setConfirmDel(false); }}
      />
    </article>
  );
}
