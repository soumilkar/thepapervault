import { pageMeta } from "@/lib/page-meta";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { ImagePlus, Trash2, X, Pencil, Check, FolderPlus, Folder } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/Markdown";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { AppSelect } from "@/components/AppSelect";
import { useBrowserDraft } from "@/lib/browser-drafts";

const NONE = "__none__";

export const Route = createFileRoute("/app/notes")({
  head: () => pageMeta("Notes", "Your notes organized by folders and tags."),
  component: NotesPage,
});

const MEDIA_BUCKET = "media";

async function uploadMedia(userId: string, file: File): Promise<string> {
  const ALLOWED: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
  const ext = ALLOWED[file.type];
  if (!ext) throw new Error("Only JPEG, PNG, WebP, or GIF images are allowed");
  if (file.size > 5 * 1024 * 1024) throw new Error("Image must be smaller than 5 MB");
  const path = `${userId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(path, file, { contentType: file.type });
  if (error) throw error;
  return path;
}

type Note = {
  id: string; title: string | null; content: string; tags: string[] | null;
  image_url: string | null; folder_id: string | null; created_at: string; updated_at: string;
};
type Sort = "newest" | "oldest" | "title";

function NotesPage() {
  const { user } = Route.useRouteContext();
  const qc = useQueryClient();
  type NoteDraft = { title: string; content: string; tags: string; folderId: string | null };
  const [draft, setDraft, clearDraft] = useBrowserDraft<NoteDraft>(`papervault:note-draft:${user.id}`, {
    title: "", content: "", tags: "", folderId: null,
  });
  const { title, content, tags, folderId } = draft;
  const setTitle = (value: string) => setDraft((current) => ({ ...current, title: value }));
  const setContent = (value: string) => setDraft((current) => ({ ...current, content: value }));
  const setTags = (value: string) => setDraft((current) => ({ ...current, tags: value }));
  const setFolderId = (value: string | null) => setDraft((current) => ({ ...current, folderId: value }));
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [filterFolder, setFilterFolder] = useState<string | "all">("all");
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [sort, setSort] = useState<Sort>("newest");
  const [newFolder, setNewFolder] = useState("");

  useEffect(() => {
    if (!image) { setImagePreview(null); return; }
    const url = URL.createObjectURL(image);
    setImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  const folders = useQuery({
    queryKey: ["note-folders", user.id],
    queryFn: async () => {
      const { data, error } = await supabase.from("note_folders").select("*").eq("user_id", user.id).order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const notes = useQuery({
    queryKey: ["notes", user.id],
    queryFn: async (): Promise<Note[]> => {
      const { data, error } = await supabase.from("notes").select("*").eq("user_id", user.id).order("updated_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Note[];
    },
  });

  const filtered = useMemo(() => {
    let rows = notes.data ?? [];
    if (filterTag) rows = rows.filter(n => n.tags?.includes(filterTag));
    if (filterFolder !== "all") rows = rows.filter((n) => filterFolder === "none" ? !n.folder_id : n.folder_id === filterFolder);
    rows = [...rows].sort((a, b) => {
      if (sort === "title") return (a.title || "").localeCompare(b.title || "");
      const cmp = new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
      return sort === "newest" ? -cmp : cmp;
    });
    return rows;
  }, [notes.data, filterFolder, sort, filterTag]);

  const create = useMutation({
    mutationFn: async () => {
      let imagePath: string | null = null;
      if (image) imagePath = await uploadMedia(user.id, image);
      const tagArr = tags.split(",").map((t) => t.trim()).filter(Boolean);
      const { error } = await supabase.from("notes").insert({
        user_id: user.id, title: title || null, content,
        tags: tagArr.length ? tagArr : null, image_url: imagePath, folder_id: folderId,
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
    mutationFn: async (vars: { id: string; title: string; content: string; tags: string; folder_id: string | null }) => {
      const tagArr = vars.tags.split(",").map((t) => t.trim()).filter(Boolean);
      const { error } = await supabase.from("notes").update({
        title: vars.title || null, content: vars.content,
        tags: tagArr.length ? tagArr : null, folder_id: vars.folder_id,
      } as never).eq("id", vars.id);
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
      const { error } = await supabase.from("note_folders").insert({ user_id: user.id, name });
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

      <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="min-w-0 border-b border-border pb-5 md:border-b-0 md:border-r md:pr-5">
        <h2 className="mb-3 text-lg text-foreground">Folders</h2>
        <div className="flex flex-wrap gap-1 md:flex-col">
          {[{ id: "all", name: "All notes" }, { id: "none", name: "No folder" }, ...(folders.data ?? [])].map(f => <Button key={f.id} variant={filterFolder === f.id ? "secondary" : "ghost"} className="justify-start" onClick={() => setFilterFolder(f.id)}><Folder /> <span className="truncate">{f.name}</span></Button>)}
        </div>
        <h2 className="mb-3 mt-6 text-lg text-foreground">Tags</h2>
        <div className="flex flex-wrap gap-1"><Button variant={filterTag === null ? "secondary" : "ghost"} size="sm" onClick={() => setFilterTag(null)}>All</Button>{Array.from(new Set((notes.data ?? []).flatMap(n => n.tags ?? []))).map(t => <Button key={t} variant={filterTag === t ? "secondary" : "ghost"} size="sm" onClick={() => setFilterTag(t)}>#{t}</Button>)}</div>
      </aside>
      <div className="min-w-0 space-y-5">
      <form
        onSubmit={(e) => { e.preventDefault(); if (content.trim() || title.trim()) create.mutate(); }}
        className="paper-card space-y-3 p-6"
      >
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)"
          className="w-full bg-transparent font-serif text-2xl outline-none placeholder:text-muted-foreground/60" />
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, separated, by, commas"
          className="w-full bg-transparent text-sm text-accent outline-none placeholder:text-muted-foreground/60" />
        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={5}
          placeholder="Jot something down... (markdown supported)"
          className="w-full resize-none bg-transparent leading-relaxed outline-none placeholder:text-muted-foreground/60" />
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
              options={[
                { value: NONE, label: "— none —" },
                ...(folders.data ?? []).map((f) => ({ value: f.id, label: f.name })),
              ]}
            />
          </label>
          <button type="submit" disabled={create.isPending}
            className="rounded-md bg-primary px-5 py-2 text-sm text-primary-foreground disabled:opacity-50">
            {create.isPending ? "Saving..." : "Save note"}
          </button>
        </div>
      </form>

      <div className="flex flex-wrap items-center gap-3 border-y border-border py-3 text-sm">
        <label className="flex items-center gap-2">
          <Folder className="size-4 text-muted-foreground" />
          <AppSelect
            value={filterFolder}
            onValueChange={(v) => setFilterFolder(v)}
            options={[
              { value: "all", label: "All notes" },
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
              { value: "newest", label: "Most recent" },
              { value: "oldest", label: "Oldest first" },
              { value: "title", label: "Title A–Z" },
            ]}
          />
        </label>
        <form
          onSubmit={(e) => { e.preventDefault(); if (newFolder.trim()) createFolder.mutate(newFolder.trim()); }}
          className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1 lg:ml-auto lg:w-auto"
        >
          <input value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="New folder"
            className="w-full min-w-0 rounded-md border border-input bg-card px-2 py-1" />
          <button type="submit" className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground">
            <FolderPlus className="size-3.5" /> Add
          </button>
        </form>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {notes.isLoading && <p className="font-hand text-sepia">gathering notes...</p>}
        {notes.data?.length === 0 && <p className="text-muted-foreground">No notes yet.</p>}
        {filtered.map((n) => (
          <NoteCard key={n.id} note={n} folders={folders.data ?? []}
            onDelete={() => remove.mutate(n.id)}
            onSave={(v) => update.mutate({ id: n.id, ...v })} />
        ))}
      </div>
      </div>
      </div>
    </div>
  );
}

function NoteImage({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    supabase.storage.from(MEDIA_BUCKET).createSignedUrl(path, 60 * 60).then(({ data }) => {
      if (!cancelled) setSrc(data?.signedUrl ?? null);
    });
    return () => { cancelled = true; };
  }, [path]);
  if (!src) return null;
  return <img src={src} className="mt-3 max-h-56 w-full rounded-md border border-border object-cover" alt="" loading="lazy" />;
}

function NoteCard({
  note: n, folders, onDelete, onSave,
}: {
  note: Note; folders: { id: string; name: string }[];
  onDelete: () => void;
  onSave: (v: { title: string; content: string; tags: string; folder_id: string | null }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [eTitle, setETitle] = useState(n.title ?? "");
  const [eContent, setEContent] = useState(n.content);
  const [eTags, setETags] = useState((n.tags ?? []).join(", "));
  const [eFolder, setEFolder] = useState<string | null>(n.folder_id);
  const [confirmDel, setConfirmDel] = useState(false);

  if (editing) {
    return (
      <article className="paper-card space-y-2 p-4">
        <input value={eTitle} onChange={(e) => setETitle(e.target.value)} placeholder="Title"
          className="w-full bg-transparent font-serif text-xl outline-none" />
        <input value={eTags} onChange={(e) => setETags(e.target.value)} placeholder="tags, separated, by, commas"
          className="w-full bg-transparent text-sm text-accent outline-none" />
        <textarea value={eContent} onChange={(e) => setEContent(e.target.value)} rows={6}
          className="w-full resize-none bg-transparent leading-relaxed outline-none" />
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
    <article className="paper-card p-4">
      <header className="flex items-start justify-between gap-2">
        <h3 className="font-serif text-lg text-primary">{n.title || "Untitled"}</h3>
        <div className="flex items-center gap-2">
          <button onClick={() => setEditing(true)} className="text-muted-foreground hover:text-primary"><Pencil className="size-4" /></button>
          <button onClick={() => setConfirmDel(true)} className="text-muted-foreground hover:text-destructive"><Trash2 className="size-4" /></button>
        </div>
      </header>
      {n.tags && n.tags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {n.tags.map((t) => <span key={t} className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground">#{t}</span>)}
        </div>
      )}
      <div className="mt-2 text-sm"><Markdown>{n.content}</Markdown></div>
      {n.image_url && <NoteImage path={n.image_url} />}
      <p className="mt-2 text-[11px] text-muted-foreground">{new Date(n.updated_at).toLocaleString()}</p>
      <ConfirmDialog
        open={confirmDel} onOpenChange={setConfirmDel}
        title="Delete this note?" description="This can't be undone."
        confirmText="Delete" onConfirm={() => { onDelete(); setConfirmDel(false); }}
      />
    </article>
  );
}
