import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { ImagePlus, Trash2, X, Pencil, Check, FolderPlus, Folder, Search, Plus, Minus } from "lucide-react";
import { RichText } from "@/components/RichText";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { AppSelect } from "@/components/AppSelect";
import { useBrowserDraft } from "@/lib/browser-drafts";
import { useVault } from "@/lib/vault";
import { decryptBytes, decryptText, encryptBlob, encryptText } from "@/lib/crypto";
import { folderOptions, folderWithDescendants, type FolderRow } from "@/lib/folders";
import { hasImageLinks, previewText } from "@/lib/rich-text";

const NONE = "__none__";

export const Route = createFileRoute("/app/notes")({
  component: NotesPage,
  head: () => ({
    meta: [
      { title: "Notes · The PaperVault" },
      { name: "description", content: "Private, end-to-end encrypted notes with folders, tags and search." },
      { property: "og:title", content: "Notes · The PaperVault" },
      { property: "og:description", content: "Private, end-to-end encrypted notes with folders, tags and search." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const MEDIA_BUCKET = "media";
const ALLOWED: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

async function uploadEncrypted(userId: string, key: CryptoKey, file: File) {
  if (!ALLOWED[file.type]) throw new Error("Only JPEG, PNG, WebP, or GIF images are allowed");
  if (file.size > 5 * 1024 * 1024) throw new Error("Image must be smaller than 5 MB");
  const path = `${userId}/${crypto.randomUUID()}.bin`;
  const { blob, iv } = await encryptBlob(key, file);
  const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(path, blob, { contentType: "application/octet-stream" });
  if (error) throw error;
  return { path, iv, mime: file.type };
}

type Payload = { t?: string; c?: string; g?: string[]; ii?: string; im?: string };
type Note = {
  id: string; title: string; content: string; tags: string[];
  image_url: string | null; image_iv: string | null; image_mime: string | null;
  folder_id: string | null; created_at: string; updated_at: string;
};
type RawNote = {
  id: string; title: string | null; content: string; tags: string[] | null; iv: string | null;
  image_url: string | null; folder_id: string | null; created_at: string; updated_at: string;
};
type Sort = "newest" | "oldest" | "edited" | "title";

function NotesPage() {
  const { user } = Route.useRouteContext();
  const { key } = useVault();
  const qc = useQueryClient();
  type NoteDraft = { title: string; content: string; tags: string; folderId: string | null };
  const [draft, setDraft, clearDraft] = useBrowserDraft<NoteDraft>(`papervault:note-draft:${user.id}`, {
    title: "", content: "", tags: "", folderId: null,
  });
  const { title, content, tags, folderId } = draft;
  const setTitle = (value: string) => setDraft((c) => ({ ...c, title: value }));
  const setContent = (value: string) => setDraft((c) => ({ ...c, content: value }));
  const setTags = (value: string) => setDraft((c) => ({ ...c, tags: value }));
  const setFolderId = (value: string | null) => setDraft((c) => ({ ...c, folderId: value }));
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [filterFolder, setFilterFolder] = useState<string>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [query, setQuery] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const [newFolderParent, setNewFolderParent] = useState<string>(NONE);

  useEffect(() => {
    if (!image) { setImagePreview(null); return; }
    const url = URL.createObjectURL(image);
    setImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  const folders = useQuery({
    queryKey: ["note-folders", user.id],
    queryFn: async (): Promise<FolderRow[]> => {
      const { data, error } = await supabase.from("note_folders").select("id,name,parent_id").eq("user_id", user.id).order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
  const fOpts = useMemo(() => folderOptions(folders.data ?? []), [folders.data]);

  const notes = useQuery({
    enabled: !!key,
    queryKey: ["notes", user.id],
    queryFn: async (): Promise<Note[]> => {
      const { data, error } = await supabase.from("notes").select("*").eq("user_id", user.id);
      if (error) throw error;
      const out: Note[] = [];
      for (const r of (data ?? []) as unknown as RawNote[]) {
        let p: Payload;
        if (r.iv && key) {
          try { p = JSON.parse(await decryptText(key, r.content, r.iv)) as Payload; }
          catch { p = { t: "", c: "[Could not unlock this note]" }; }
        } else {
          p = { t: r.title ?? "", c: r.content, g: r.tags ?? [] };
          // Encrypt older plain notes in place.
          if (key) {
            const { ct, iv } = await encryptText(key, JSON.stringify(p));
            void supabase.from("notes").update({ content: ct, iv, title: null, tags: null } as never).eq("id", r.id);
          }
        }
        out.push({
          id: r.id, title: p.t ?? "", content: p.c ?? "", tags: p.g ?? [],
          image_url: r.image_url, image_iv: p.ii ?? null, image_mime: p.im ?? null,
          folder_id: r.folder_id, created_at: r.created_at, updated_at: r.updated_at,
        });
      }
      return out;
    },
  });

  const filtered = useMemo(() => {
    let rows = notes.data ?? [];
    if (filterFolder === "none") rows = rows.filter((n) => !n.folder_id);
    else if (filterFolder !== "all") {
      const ids = folderWithDescendants(folders.data ?? [], filterFolder);
      rows = rows.filter((n) => n.folder_id && ids.has(n.folder_id));
    }
    const q = query.trim().toLowerCase();
    if (q) rows = rows.filter((n) => `${n.title}\n${n.content}\n${n.tags.join(" ")}`.toLowerCase().includes(q));
    const time = (s: string) => new Date(s).getTime();
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (sort === "title") cmp = (a.title || "").localeCompare(b.title || "");
      else if (sort === "edited") cmp = time(b.updated_at) - time(a.updated_at);
      else if (sort === "newest") cmp = time(b.created_at) - time(a.created_at);
      else cmp = time(a.created_at) - time(b.created_at);
      return cmp || a.id.localeCompare(b.id);
    });
  }, [notes.data, folders.data, filterFolder, sort, query]);

  const create = useMutation({
    mutationFn: async () => {
      if (!key) throw new Error("Vault is locked");
      let img: { path: string; iv: string; mime: string } | null = null;
      if (image) img = await uploadEncrypted(user.id, key, image);
      const tagArr = tags.split(",").map((t) => t.trim()).filter(Boolean);
      const payload: Payload = { t: title, c: content, g: tagArr, ...(img ? { ii: img.iv, im: img.mime } : {}) };
      const { ct, iv } = await encryptText(key, JSON.stringify(payload));
      const { error } = await supabase.from("notes").insert({
        user_id: user.id, title: null, content: ct, iv, tags: null,
        image_url: img?.path ?? null, folder_id: folderId,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      clearDraft(); setImage(null);
      toast.success("Note saved");
      qc.invalidateQueries({ queryKey: ["notes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: async (vars: { note: Note; title: string; content: string; tags: string; folder_id: string | null }) => {
      if (!key) throw new Error("Vault is locked");
      const tagArr = vars.tags.split(",").map((t) => t.trim()).filter(Boolean);
      const n = vars.note;
      const payload: Payload = { t: vars.title, c: vars.content, g: tagArr, ...(n.image_iv ? { ii: n.image_iv, im: n.image_mime ?? undefined } : {}) };
      const { ct, iv } = await encryptText(key, JSON.stringify(payload));
      const { error } = await supabase.from("notes").update({
        content: ct, iv, title: null, tags: null, folder_id: vars.folder_id, updated_at: new Date().toISOString(),
      } as never).eq("id", n.id);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Note updated"); qc.invalidateQueries({ queryKey: ["notes"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("notes").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notes"] }),
  });

  const createFolder = useMutation({
    mutationFn: async (name: string) => {
      const { error } = await supabase.from("note_folders").insert({
        user_id: user.id, name, parent_id: newFolderParent === NONE ? null : newFolderParent,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => { setNewFolder(""); qc.invalidateQueries({ queryKey: ["note-folders"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div>
        <p className="font-hand text-2xl text-sepia">scraps and reminders</p>
        <h1 className="font-serif text-4xl text-primary">Notes</h1>
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); if (content.trim() || title.trim()) create.mutate(); }}
        className="paper-card space-y-3 p-6"
      >
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)"
          className="w-full bg-transparent font-serif text-2xl outline-none placeholder:text-muted-foreground/60" />
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, separated, by, commas"
          className="w-full bg-transparent text-sm text-accent outline-none placeholder:text-muted-foreground/60" />
        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={5}
          placeholder="Jot something down... paste an image link on its own line to show the picture"
          className="w-full resize-y bg-transparent leading-relaxed outline-none placeholder:text-muted-foreground/60" />
        {hasImageLinks(content) && (
          <div className="rounded-md border border-border bg-secondary/30 p-3 text-sm">
            <p className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Preview</p>
            <RichText>{content}</RichText>
          </div>
        )}
        {imagePreview && (
          <div className="relative inline-block">
            <img src={imagePreview} className="max-h-56 rounded-md border border-border" alt="" />
            <button type="button" onClick={() => setImage(null)}
              className="absolute -right-2 -top-2 rounded-full bg-background p-1 shadow"><X className="size-4" /></button>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-accent hover:text-primary">
            <ImagePlus className="size-4" />
            <span>{image ? "Change image" : "Attach image"}</span>
            <input type="file" accept="image/*" className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) { if (f.size > 5 * 1024 * 1024) toast.error("Image must be smaller than 5 MB"); else setImage(f); }
                e.currentTarget.value = "";
              }} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Folder</span>
            <AppSelect
              value={folderId ?? NONE}
              onValueChange={(v) => setFolderId(v === NONE ? null : v)}
              options={[{ value: NONE, label: "— none —" }, ...fOpts]}
            />
          </label>
          <button type="submit" disabled={create.isPending || !key}
            className="rounded-md bg-primary px-5 py-2 text-sm text-primary-foreground disabled:opacity-50">
            {create.isPending ? "Saving..." : "Save note"}
          </button>
        </div>
      </form>

      <div className="paper-card space-y-3 p-3 text-sm">
        <label className="flex items-center gap-2 rounded-md border border-input bg-card px-3 py-2">
          <Search className="size-4 text-muted-foreground" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search notes..."
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/60" />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search"><X className="size-4 text-muted-foreground" /></button>}
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            <Folder className="size-4 text-muted-foreground" />
            <AppSelect
              value={filterFolder}
              onValueChange={(v) => setFilterFolder(v)}
              options={[{ value: "all", label: "All notes" }, { value: "none", label: "No folder" }, ...fOpts]}
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
                { value: "edited", label: "Recently edited" },
                { value: "title", label: "Title A–Z" },
              ]}
            />
          </label>
          <form
            onSubmit={(e) => { e.preventDefault(); if (newFolder.trim()) createFolder.mutate(newFolder.trim()); }}
            className="flex flex-wrap items-center gap-1 sm:ml-auto"
          >
            <input value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="New folder"
              className="w-32 rounded-md border border-input bg-card px-2 py-1" />
            <AppSelect
              value={newFolderParent}
              onValueChange={setNewFolderParent}
              options={[{ value: NONE, label: "Top level" }, ...fOpts.map((o) => ({ value: o.value, label: `inside ${o.label}` }))]}
            />
            <button type="submit" className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground">
              <FolderPlus className="size-3.5" /> Add
            </button>
          </form>
        </div>
      </div>

      <div className="columns-1 gap-4 sm:columns-2">
        {notes.isLoading && <p className="font-hand text-sepia">gathering notes...</p>}
        {notes.data?.length === 0 && <p className="text-muted-foreground">No notes yet.</p>}
        {notes.data && notes.data.length > 0 && filtered.length === 0 && <p className="text-muted-foreground">No notes match.</p>}
        {filtered.map((n) => (
          <div key={n.id} className="mb-4 break-inside-avoid">
            <NoteCard note={n} folderOpts={fOpts} cryptoKey={key}
              onDelete={() => remove.mutate(n.id)}
              onSave={(v) => update.mutate({ note: n, ...v })} />
          </div>
        ))}
      </div>
    </div>
  );
}

function NoteImage({ path, iv, mime, cryptoKey }: { path: string; iv: string | null; mime: string | null; cryptoKey: CryptoKey | null }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      const { data } = await supabase.storage.from(MEDIA_BUCKET).createSignedUrl(path, 60 * 60);
      if (!data?.signedUrl || cancelled) return;
      if (!iv) { setSrc(data.signedUrl); return; }
      if (!cryptoKey) return;
      try {
        const bytes = await (await fetch(data.signedUrl)).arrayBuffer();
        const pt = await decryptBytes(cryptoKey, bytes, iv);
        objectUrl = URL.createObjectURL(new Blob([pt], { type: mime || "image/jpeg" }));
        if (!cancelled) setSrc(objectUrl);
      } catch { /* unreadable image */ }
    })();
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path, iv, mime, cryptoKey]);
  if (!src) return null;
  return <img src={src} className="mt-3 max-h-56 w-full rounded-md border border-border object-cover" alt="" loading="lazy" />;
}

function NoteCard({
  note: n, folderOpts, cryptoKey, onDelete, onSave,
}: {
  note: Note; folderOpts: { value: string; label: string }[]; cryptoKey: CryptoKey | null;
  onDelete: () => void;
  onSave: (v: { title: string; content: string; tags: string; folder_id: string | null }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [eTitle, setETitle] = useState(n.title);
  const [eContent, setEContent] = useState(n.content);
  const [eTags, setETags] = useState(n.tags.join(", "));
  const [eFolder, setEFolder] = useState<string | null>(n.folder_id);
  const [confirmDel, setConfirmDel] = useState(false);
  const pv = previewText(n.content, 220);
  const long = pv.truncated;

  if (editing) {
    return (
      <article className="paper-card space-y-2 p-4">
        <input value={eTitle} onChange={(e) => setETitle(e.target.value)} placeholder="Title"
          className="w-full bg-transparent font-serif text-xl outline-none" />
        <input value={eTags} onChange={(e) => setETags(e.target.value)} placeholder="tags, separated, by, commas"
          className="w-full bg-transparent text-sm text-accent outline-none" />
        <textarea value={eContent} onChange={(e) => setEContent(e.target.value)} rows={6}
          className="w-full resize-y bg-transparent leading-relaxed outline-none" />
        {hasImageLinks(eContent) && <div className="text-sm"><RichText>{eContent}</RichText></div>}
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Folder</span>
          <AppSelect
            value={eFolder ?? NONE}
            onValueChange={(v) => setEFolder(v === NONE ? null : v)}
            options={[{ value: NONE, label: "— none —" }, ...folderOpts]}
          />
        </label>
        <div className="flex justify-end gap-2">
          <button onClick={() => setEditing(false)} className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm">
            <X className="size-4" /> Cancel
          </button>
          <button
            onClick={() => { onSave({ title: eTitle, content: eContent, tags: eTags, folder_id: eFolder }); setEditing(false); }}
            className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
          >
            <Check className="size-4" /> Save
          </button>
        </div>
      </article>
    );
  }

  return (
    <article className="paper-card min-w-0 p-4">
      <header className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 break-words font-serif text-lg text-primary">{n.title || "Untitled"}</h3>
        <div className="flex shrink-0 items-center gap-2">
          <button onClick={() => { setETitle(n.title); setEContent(n.content); setETags(n.tags.join(", ")); setEFolder(n.folder_id); setEditing(true); }}
            className="text-muted-foreground hover:text-primary" aria-label="Edit"><Pencil className="size-4" /></button>
          <button onClick={() => setConfirmDel(true)} className="text-muted-foreground hover:text-destructive" aria-label="Delete"><Trash2 className="size-4" /></button>
        </div>
      </header>
      {n.tags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {n.tags.map((t) => <span key={t} className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground">#{t}</span>)}
        </div>
      )}
      <div className="mt-2 break-words text-sm"><RichText>{open ? n.content : pv.text}</RichText></div>
      {long && (
        <button onClick={() => setOpen((o) => !o)} className="mt-1 flex items-center gap-1 text-sm text-accent hover:text-primary">
          {open ? <><Minus className="size-3.5" /> Collapse</> : <><Plus className="size-3.5" /> Expand</>}
        </button>
      )}
      {n.image_url && <NoteImage path={n.image_url} iv={n.image_iv} mime={n.image_mime} cryptoKey={cryptoKey} />}
      <p className="mt-2 text-[11px] text-muted-foreground">{new Date(n.updated_at).toLocaleString()}</p>
      <ConfirmDialog
        open={confirmDel} onOpenChange={setConfirmDel}
        title="Delete this note?" description="This can't be undone."
        confirmText="Delete" onConfirm={() => { onDelete(); setConfirmDel(false); }}
      />
    </article>
  );
}
