import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  Trash2,
  X,
  FolderPlus,
  Folder,
  Search,
  Plus,
  ChevronRight,
  ChevronDown,
  FileText,
} from "lucide-react";
import { RichEditor } from "@/components/RichEditor";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { AppSelect } from "@/components/AppSelect";
import { useBrowserDraft } from "@/lib/browser-drafts";
import { useVault } from "@/lib/vault";
import { decryptBytes, decryptField, decryptText, encryptBlob, encryptField, encryptText } from "@/lib/crypto";
import { folderOptions, folderWithDescendants, type FolderRow } from "@/lib/folders";

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
const ALLOWED: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

async function uploadEncrypted(userId: string, key: CryptoKey, file: File) {
  if (!ALLOWED[file.type]) throw new Error("Only JPEG, PNG, WebP, or GIF images are allowed");
  if (file.size > 5 * 1024 * 1024) throw new Error("Image must be smaller than 5 MB");
  const path = `${userId}/${crypto.randomUUID()}.bin`;
  const { blob, iv } = await encryptBlob(key, file);
  const { error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .upload(path, blob, { contentType: "application/octet-stream" });
  if (error) throw error;
  return { path, iv, mime: file.type };
}

function formatSheetDate(iso?: string) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
}

type Payload = { t?: string; c?: string; g?: string[]; ii?: string; im?: string };
type Note = {
  id: string;
  title: string;
  content: string;
  tags: string[];
  image_url: string | null;
  image_iv: string | null;
  image_mime: string | null;
  folder_id: string | null;
  created_at: string;
  updated_at: string;
};
type RawNote = {
  id: string;
  title: string | null;
  content: string;
  tags: string[] | null;
  iv: string | null;
  image_url: string | null;
  folder_id: string | null;
  created_at: string;
  updated_at: string;
};
type Sort = "newest" | "oldest" | "edited" | "title";

function NotesPage() {
  const { user } = Route.useRouteContext();
  const { key } = useVault();
  const qc = useQueryClient();
  type NoteDraft = {
    title: string;
    content: string;
    tags: string;
    folderId: string | null;
    activeNoteId?: string | null;
  };
  const [draft, setDraft, clearDraft] = useBrowserDraft<NoteDraft>(`papervault:note-draft:${user.id}`, {
    title: "",
    content: "",
    tags: "",
    folderId: null,
    activeNoteId: null,
  });
  const { title, content, tags, folderId, activeNoteId: draftActiveNoteId } = draft;
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

  // Studio sheet state
  const [browseOpen, setBrowseOpen] = useState(false);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [sheetEditing, setSheetEditing] = useState(false);
  const [draftPreview, setDraftPreview] = useState(false);
  const [sTitle, setSTitle] = useState("");
  const [sContent, setSContent] = useState("");
  const [sTags, setSTags] = useState("");
  const [sFolderId, setSFolderId] = useState<string | null>(null);
  const [sImage, setSImage] = useState<File | null>(null);
  const [sImagePreview, setSImagePreview] = useState<string | null>(null);
  const [confirmDeleteActive, setConfirmDeleteActive] = useState(false);
  const [linkPromptOpen, setLinkPromptOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkText, setLinkText] = useState("");

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!image) {
      setImagePreview(null);
      return;
    }
    const url = URL.createObjectURL(image);
    setImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  useEffect(() => {
    if (!sImage) {
      setSImagePreview(null);
      return;
    }
    const url = URL.createObjectURL(sImage);
    setSImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [sImage]);

  const folders = useQuery({
    enabled: !!key,
    queryKey: ["note-folders", user.id],
    queryFn: async (): Promise<FolderRow[]> => {
      const { data, error } = await supabase
        .from("note_folders")
        .select("id,name,parent_id")
        .eq("user_id", user.id);
      if (error) throw error;
      const raw = data ?? [];
      if (!key) return [];
      const decoded = await Promise.all(
        raw.map(async (f) => {
          try {
            const { plaintext, wasEncrypted } = await decryptField(key, f.name);
            if (!wasEncrypted && f.name) {
              const encName = await encryptField(key, f.name);
              void supabase.from("note_folders").update({ name: encName }).eq("id", f.id);
            }
            return { id: f.id, name: plaintext, parent_id: f.parent_id };
          } catch {
            return { id: f.id, name: "[Locked folder]", parent_id: f.parent_id };
          }
        }),
      );
      return decoded.sort((a, b) => a.name.localeCompare(b.name));
    },
  });
  const fOpts = useMemo(() => folderOptions(folders.data ?? []), [folders.data]);

  const notes = useQuery({
    enabled: !!key,
    queryKey: ["notes", user.id],
    queryFn: async (): Promise<Note[]> => {
      const { data, error } = await supabase.from("notes").select("*").eq("user_id", user.id);
      if (error) throw error;
      const rows = (data ?? []) as unknown as RawNote[];

      return Promise.all(
        rows.map(async (r) => {
          let p: Payload;
          if (r.iv && key) {
            try {
              p = JSON.parse(await decryptText(key, r.content, r.iv)) as Payload;
              if (r.title !== null || r.tags !== null) {
                void supabase.from("notes").update({ title: null, tags: null } as never).eq("id", r.id);
              }
            } catch {
              p = { t: "", c: "[Could not unlock this note]" };
            }
          } else {
            p = { t: r.title ?? "", c: r.content, g: r.tags ?? [] };
            if (key) {
              const { ct, iv } = await encryptText(key, JSON.stringify(p));
              void supabase
                .from("notes")
                .update({ content: ct, iv, title: null, tags: null } as never)
                .eq("id", r.id);
            }
          }
          return {
            id: r.id,
            title: p.t ?? "",
            content: p.c ?? "",
            tags: p.g ?? [],
            image_url: r.image_url,
            image_iv: p.ii ?? null,
            image_mime: p.im ?? null,
            folder_id: r.folder_id,
            created_at: r.created_at,
            updated_at: r.updated_at,
          };
        }),
      );
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

  const activeNote = useMemo(
    () => (selectedNoteId ? (notes.data ?? []).find((n) => n.id === selectedNoteId) ?? null : null),
    [selectedNoteId, notes.data],
  );

  // Restore last viewed note or default to most recent saved note when notes load (including after logout/login)
  useEffect(() => {
    if (isCreatingNew) return;
    const list = notes.data;
    if (!list || list.length === 0) return;

    if (selectedNoteId && list.some((n) => n.id === selectedNoteId)) {
      return;
    }

    if (draftActiveNoteId && list.some((n) => n.id === draftActiveNoteId)) {
      setSelectedNoteId(draftActiveNoteId);
      return;
    }

    // If user is not actively typing an unsaved draft, show the most recently saved/updated note
    if (!title.trim() && !content.trim()) {
      const latest = [...list].sort(
        (a, b) =>
          new Date(b.updated_at || b.created_at).getTime() -
          new Date(a.updated_at || a.created_at).getTime(),
      )[0];
      if (latest) {
        setSelectedNoteId(latest.id);
      }
    }
  }, [notes.data, isCreatingNew, selectedNoteId, draftActiveNoteId, title, content]);

  // Sync active note fields when selection changes
  useEffect(() => {
    if (activeNote) {
      setSTitle(activeNote.title);
      setSContent(activeNote.content);
      setSTags(activeNote.tags.join(", "));
      setSFolderId(activeNote.folder_id);
      setSImage(null);
    }
  }, [activeNote]);

  const openNoteInSheet = useCallback(
    (n: Note, editMode = false) => {
      setIsCreatingNew(false);
      setSelectedNoteId(n.id);
      setDraft((c) => ({ ...c, activeNoteId: n.id }));
      setSTitle(n.title);
      setSContent(n.content);
      setSTags(n.tags.join(", "));
      setSFolderId(n.folder_id);
      setSImage(null);
      setSheetEditing(editMode);
      setBrowseOpen(false);
    },
    [setDraft],
  );

  const startNewNote = useCallback(() => {
    setIsCreatingNew(true);
    setSelectedNoteId(null);
    setDraft((c) => ({ ...c, activeNoteId: null }));
    setSheetEditing(false);
    setDraftPreview(false);
    setBrowseOpen(false);
    setTimeout(() => textareaRef.current?.focus(), 30);
  }, [setDraft]);

  const create = useMutation({
    mutationFn: async (): Promise<Note> => {
      if (!key) throw new Error("Vault is locked");
      let img: { path: string; iv: string; mime: string } | null = null;
      if (image) img = await uploadEncrypted(user.id, key, image);
      const tagArr = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const payload: Payload = {
        t: title,
        c: content,
        g: tagArr,
        ...(img ? { ii: img.iv, im: img.mime } : {}),
      };
      const { ct, iv } = await encryptText(key, JSON.stringify(payload));
      const { data: inserted, error } = await supabase
        .from("notes")
        .insert({
          user_id: user.id,
          title: null,
          content: ct,
          iv,
          tags: null,
          image_url: img?.path ?? null,
          folder_id: folderId,
        } as never)
        .select("id,created_at,updated_at")
        .single();
      if (error) throw error;
      const row = inserted as { id: string; created_at: string; updated_at: string };
      return {
        id: row.id,
        title,
        content,
        tags: tagArr,
        image_url: img?.path ?? null,
        image_iv: img?.iv ?? null,
        image_mime: img?.mime ?? null,
        folder_id: folderId,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    },
    onSuccess: (createdNote) => {
      qc.setQueryData<Note[]>(["notes", user.id], (old) => [
        createdNote,
        ...(old ?? []).filter((n) => n.id !== createdNote.id),
      ]);
      setIsCreatingNew(false);
      setSelectedNoteId(createdNote.id);
      setSTitle(createdNote.title);
      setSContent(createdNote.content);
      setSTags(createdNote.tags.join(", "));
      setSFolderId(createdNote.folder_id);
      setSheetEditing(false);
      setDraft({
        title: "",
        content: "",
        tags: "",
        folderId: null,
        activeNoteId: createdNote.id,
      });
      setImage(null);
      setDraftPreview(false);
      toast.success("Note saved");
      qc.invalidateQueries({ queryKey: ["notes"] });
      qc.invalidateQueries({ queryKey: ["heatmap-activity"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: async (vars: {
      note: Note;
      title: string;
      content: string;
      tags: string;
      folder_id: string | null;
      newImage?: File | null;
    }): Promise<Note> => {
      if (!key) throw new Error("Vault is locked");
      const tagArr = vars.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const n = vars.note;
      let imgUrl = n.image_url;
      let imgIv = n.image_iv;
      let imgMime = n.image_mime;
      if (vars.newImage) {
        if (n.image_url) {
          await supabase.storage.from(MEDIA_BUCKET).remove([n.image_url]);
        }
        const up = await uploadEncrypted(user.id, key, vars.newImage);
        imgUrl = up.path;
        imgIv = up.iv;
        imgMime = up.mime;
      }
      const payload: Payload = {
        t: vars.title,
        c: vars.content,
        g: tagArr,
        ...(imgIv ? { ii: imgIv, im: imgMime ?? undefined } : {}),
      };
      const updatedAt = new Date().toISOString();
      const { ct, iv } = await encryptText(key, JSON.stringify(payload));
      const { error } = await supabase
        .from("notes")
        .update({
          content: ct,
          iv,
          title: null,
          tags: null,
          image_url: imgUrl,
          folder_id: vars.folder_id,
          updated_at: updatedAt,
        } as never)
        .eq("id", n.id);
      if (error) throw error;
      return {
        ...n,
        title: vars.title,
        content: vars.content,
        tags: tagArr,
        image_url: imgUrl,
        image_iv: imgIv,
        image_mime: imgMime,
        folder_id: vars.folder_id,
        updated_at: updatedAt,
      };
    },
    onSuccess: (updatedNote) => {
      qc.setQueryData<Note[]>(["notes", user.id], (old) =>
        (old ?? []).map((n) => (n.id === updatedNote.id ? updatedNote : n)),
      );
      setSImage(null);
      toast.success("Note updated");
      qc.invalidateQueries({ queryKey: ["notes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (note: Note) => {
      if (note.image_url) {
        await supabase.storage.from(MEDIA_BUCKET).remove([note.image_url]);
      }
      const { error } = await supabase.from("notes").delete().eq("id", note.id);
      if (error) throw error;
      return note.id;
    },
    onSuccess: (deletedId) => {
      const remaining = (qc.getQueryData<Note[]>(["notes", user.id]) ?? []).filter((n) => n.id !== deletedId);
      qc.setQueryData<Note[]>(["notes", user.id], remaining);
      if (selectedNoteId === deletedId) {
        const nextNote = remaining[0] ?? null;
        setSelectedNoteId(nextNote?.id ?? null);
        setDraft((c) => ({ ...c, activeNoteId: nextNote?.id ?? null }));
        setSheetEditing(false);
      }
      qc.invalidateQueries({ queryKey: ["notes"] });
      qc.invalidateQueries({ queryKey: ["heatmap-activity"] });
    },
  });

  const createFolder = useMutation({
    mutationFn: async (name: string) => {
      if (!key) throw new Error("Vault is locked");
      const encName = await encryptField(key, name);
      const { error } = await supabase.from("note_folders").insert({
        user_id: user.id,
        name: encName,
        parent_id: newFolderParent === NONE ? null : newFolderParent,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      setNewFolder("");
      qc.invalidateQueries({ queryKey: ["note-folders"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteFolder = useMutation({
    mutationFn: async (targetFolderId: string) => {
      const { error } = await supabase
        .from("note_folders")
        .delete()
        .eq("id", targetFolderId)
        .eq("user_id", user.id);
      if (error) throw error;
    },
    onSuccess: () => {
      setFilterFolder("all");
      toast.success("Folder deleted");
      qc.invalidateQueries({ queryKey: ["note-folders"] });
      qc.invalidateQueries({ queryKey: ["notes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const currentTitle = activeNote ? sTitle : title;
  const titleInputRef = useRef<HTMLTextAreaElement>(null);

  const syncTitleHeight = useCallback(() => {
    const el = titleInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => {
    syncTitleHeight();
  }, [currentTitle, syncTitleHeight]);

  useEffect(() => {
    window.addEventListener("resize", syncTitleHeight);
    return () => window.removeEventListener("resize", syncTitleHeight);
  }, [syncTitleHeight]);

  const currentText = activeNote ? sContent : content;
  const updateCurrentText = useCallback(
    (next: string) => {
      if (activeNote) {
        setSContent(next);
      } else {
        setDraft((c) => ({ ...c, content: next }));
      }
    },
    [activeNote, setDraft],
  );

  const totalNotesCount = filtered.length;
  const activeFolderValue = (activeNote ? sFolderId : folderId) ?? NONE;
  const hasActiveNoteChanges =
    !!activeNote &&
    (sTitle !== activeNote.title ||
      sContent !== activeNote.content ||
      sTags !== activeNote.tags.join(", ") ||
      sFolderId !== activeNote.folder_id ||
      sImage !== null ||
      sheetEditing);

  return (
    <div className="space-y-5">
      {/* Header Row with Right-Side Browse Pages Menu Button & New Note */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-hand text-2xl text-sepia">scraps and reminders</p>
          <h1 className="font-serif text-4xl text-primary">Notes</h1>
          <p className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">end-to-end encrypted</p>
        </div>

        <div className="relative flex items-center gap-2.5">
          <button
            type="button"
            onClick={startNewNote}
            className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:opacity-95"
          >
            <Plus className="size-4" />
            <span>New Note</span>
          </button>

          <button
            type="button"
            onClick={() => setBrowseOpen((o) => !o)}
            className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm font-medium text-primary shadow-sm transition hover:bg-secondary/60"
          >
            <Folder className="size-4 text-sepia" />
            <span>Browse Pages ({totalNotesCount})</span>
            {browseOpen ? (
              <ChevronDown className="size-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 text-muted-foreground" />
            )}
          </button>

          {/* Translucent, Blurry, Warm Sepia-Tinted Floating Menu Matching Website Theme */}
          {browseOpen && (
            <>
              <div
                className="fixed inset-0 z-30 bg-[oklch(0.28_0.04_50_/_0.08)] backdrop-blur-[1px]"
                onClick={() => setBrowseOpen(false)}
              />
              <div className="absolute right-0 top-full z-40 mt-2.5 w-[min(92vw,31rem)] space-y-3 rounded-2xl border border-border/85 bg-[oklch(0.94_0.032_76_/_0.82)] p-4 text-foreground shadow-xl backdrop-blur-2xl">
                <div className="flex items-center justify-between gap-2 px-1">
                  <div className="flex items-center gap-2">
                    <Folder className="size-4 text-sepia" />
                    <span className="font-serif text-lg font-medium text-primary">
                      Browse Pages ({totalNotesCount})
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={startNewNote}
                      className="flex items-center gap-1 rounded-lg border border-border/80 bg-card/75 px-2.5 py-1 text-xs font-medium text-primary shadow-2xs backdrop-blur-md transition hover:bg-card"
                    >
                      <Plus className="size-3.5" /> New Note
                    </button>
                    <button
                      type="button"
                      onClick={() => setBrowseOpen(false)}
                      className="rounded-lg p-1 text-muted-foreground transition hover:bg-secondary/70 hover:text-primary"
                      aria-label="Close menu"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                </div>

                {/* Search Box (Translucent Warm-Tinted Box) */}
                <label className="flex items-center gap-2 rounded-xl border border-border/75 bg-[oklch(0.89_0.038_74_/_0.52)] px-3.5 py-2 text-sm backdrop-blur-md transition focus-within:border-primary/40 focus-within:bg-card/80">
                  <Search className="size-4 text-sepia" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search notes..."
                    className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/80"
                  />
                  {query && (
                    <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
                      <X className="size-4 text-muted-foreground hover:text-foreground" />
                    </button>
                  )}
                </label>

                {/* Folder Filter & Sort Box (Translucent Warm-Tinted Box) */}
                <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-border/75 bg-[oklch(0.89_0.038_74_/_0.52)] p-3 text-xs backdrop-blur-md sm:text-sm">
                  <div className="flex items-center gap-1.5">
                    <Folder className="size-4 text-sepia" />
                    <AppSelect
                      value={filterFolder}
                      onValueChange={(v) => setFilterFolder(v)}
                      triggerClassName="border-border/80 bg-card/80 text-foreground hover:bg-card"
                      options={[{ value: "all", label: "All notes" }, { value: "none", label: "No folder" }, ...fOpts]}
                    />
                    {filterFolder !== "all" && filterFolder !== "none" && (
                      <button
                        type="button"
                        onClick={() => deleteFolder.mutate(filterFolder)}
                        title="Delete selected folder"
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary/70 hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </div>

                  <label className="flex items-center gap-2">
                    <span className="text-muted-foreground">Sort</span>
                    <AppSelect
                      value={sort}
                      onValueChange={(v) => setSort(v as Sort)}
                      triggerClassName="border-border/80 bg-card/80 text-foreground hover:bg-card"
                      options={[
                        { value: "newest", label: "Newest first" },
                        { value: "oldest", label: "Oldest first" },
                        { value: "edited", label: "Recently edited" },
                        { value: "title", label: "Title A–Z" },
                      ]}
                    />
                  </label>
                </div>

                {/* New Folder Creation Box (Translucent Warm-Tinted Box) */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (newFolder.trim()) createFolder.mutate(newFolder.trim());
                  }}
                  className="flex flex-wrap items-center gap-2 rounded-xl border border-border/75 bg-[oklch(0.89_0.038_74_/_0.52)] p-3 text-xs backdrop-blur-md sm:text-sm"
                >
                  <input
                    value={newFolder}
                    onChange={(e) => setNewFolder(e.target.value)}
                    placeholder="New folder"
                    className="min-w-[7rem] flex-1 rounded-md border border-border/80 bg-card/80 px-2.5 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground/80 focus:border-primary/40"
                  />
                  <AppSelect
                    value={newFolderParent}
                    onValueChange={setNewFolderParent}
                    triggerClassName="border-border/80 bg-card/80 text-foreground hover:bg-card"
                    options={[
                      { value: NONE, label: "Top level" },
                      ...fOpts.map((o) => ({ value: o.value, label: `inside ${o.label}` })),
                    ]}
                  />
                  <button
                    type="submit"
                    className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-2xs transition hover:opacity-95"
                  >
                    <FolderPlus className="size-3.5" /> Add
                  </button>
                </form>

                {/* Saved Pages List (Each in a Translucent Warm-Tinted Box) */}
                <div className="max-h-72 space-y-2 overflow-y-auto pr-0.5">
                  {notes.isLoading && (
                    <div className="rounded-xl border border-border/75 bg-[oklch(0.89_0.038_74_/_0.52)] p-3 font-hand text-sepia backdrop-blur-md">
                      gathering notes...
                    </div>
                  )}
                  {!notes.isLoading && filtered.length === 0 && (
                    <div className="rounded-xl border border-border/75 bg-[oklch(0.89_0.038_74_/_0.52)] p-3 text-sm text-muted-foreground backdrop-blur-md">
                      {notes.data?.length === 0 ? "No notes yet." : "No notes match."}
                    </div>
                  )}
                  {filtered.map((n) => {
                    const isSelected = n.id === selectedNoteId;
                    const folderLabel = fOpts.find((f) => f.value === n.folder_id)?.label?.trim();
                    return (
                      <button
                        key={n.id}
                        type="button"
                        onClick={() => openNoteInSheet(n, false)}
                        className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-left backdrop-blur-md transition ${
                          isSelected
                            ? "border-primary/45 bg-card/90 shadow-2xs"
                            : "border-border/75 bg-[oklch(0.89_0.038_74_/_0.52)] hover:border-primary/30 hover:bg-card/80"
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start gap-2">
                            <FileText className="mt-1 size-3.5 shrink-0 text-sepia" />
                            <div className="min-w-0 flex-1">
                              <span className="break-words font-serif text-base font-medium leading-snug text-primary">
                                {n.title || "Untitled"}
                              </span>
                              {folderLabel && (
                                <span className="ml-1.5 inline-block text-xs text-muted-foreground">
                                  · {folderLabel}
                                </span>
                              )}
                            </div>
                          </div>
                          {n.tags.length > 0 && (
                            <div className="mt-0.5 flex flex-wrap gap-1 pl-5">
                              {n.tags.map((t) => (
                                <span key={t} className="text-[11px] text-sepia">
                                  #{t}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <span className="shrink-0 self-start pt-0.5 text-xs text-muted-foreground">
                          {formatSheetDate(n.updated_at || n.created_at)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Metadata Row Above the Main Studio Sheet (Date · Folder Selector · Tags · Delete Icon) */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-sm text-muted-foreground">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <div className="inline-flex items-center gap-1.5 text-foreground/85">
            <span>{formatSheetDate(activeNote?.updated_at ?? activeNote?.created_at)}</span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </div>

          <span className="text-muted-foreground/60">·</span>

          <div className="inline-flex items-center gap-1.5">
            <AppSelect
              value={activeFolderValue}
              onValueChange={(v) => {
                const nextFolder = v === NONE ? null : v;
                if (activeNote) {
                  setSFolderId(nextFolder);
                  update.mutate({
                    note: activeNote,
                    title: sTitle,
                    content: sContent,
                    tags: sTags,
                    folder_id: nextFolder,
                  });
                } else {
                  setFolderId(nextFolder);
                }
              }}
              options={[{ value: NONE, label: "Unfiled Notes" }, ...fOpts]}
            />
          </div>

          <span className="hidden text-muted-foreground/60 sm:inline">·</span>

          <input
            value={activeNote ? sTags : tags}
            onChange={(e) => (activeNote ? setSTags(e.target.value) : setTags(e.target.value))}
            placeholder="tags, separated, by, commas"
            className="min-w-[180px] bg-transparent text-xs text-sepia outline-none placeholder:text-muted-foreground/60 sm:text-sm"
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (activeNote) {
                setConfirmDeleteActive(true);
              } else if (title || content || tags || image) {
                clearDraft();
                setImage(null);
                toast.success("Draft cleared");
              }
            }}
            title={activeNote ? "Delete this note" : "Clear draft"}
            aria-label={activeNote ? "Delete this note" : "Clear draft"}
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-secondary hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>

      {/* Main Studio Sheet Card with Instant WYSIWYG RichEditor */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (activeNote) {
            update.mutate(
              {
                note: activeNote,
                title: sTitle,
                content: sContent,
                tags: sTags,
                folder_id: sFolderId,
                newImage: sImage,
              },
              {
                onSuccess: () => setSheetEditing(false),
              },
            );
          } else if (content.trim() || title.trim() || image) {
            create.mutate();
          }
        }}
        className="rounded-2xl border border-border bg-card shadow-sm"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              if (f.size > 5 * 1024 * 1024) {
                toast.error("Image must be smaller than 5 MB");
              } else if (activeNote) {
                setSImage(f);
                setSheetEditing(true);
              } else {
                setImage(f);
              }
            }
            e.currentTarget.value = "";
          }}
        />

        <RichEditor
          value={currentText}
          onChange={updateCurrentText}
          placeholder="Jot something down..."
          minHeightClass="min-h-[260px]"
          onPhotoClick={() => fileInputRef.current?.click()}
          photoLabel="Photo"
          headerSlot={
            <textarea
              ref={titleInputRef}
              rows={1}
              value={currentTitle}
              onChange={(e) => {
                const next = e.target.value.replace(/\r?\n/g, " ");
                if (activeNote) {
                  setSTitle(next);
                } else {
                  setTitle(next);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                }
              }}
              placeholder="Title"
              className="block w-full resize-none overflow-hidden break-words bg-transparent font-serif text-3xl leading-tight text-primary outline-none placeholder:text-muted-foreground/50 sm:text-4xl"
            />
          }
          footerSlot={
            <>
              {/* Attached image preview for new note or updated note */}
              {(activeNote ? sImagePreview : imagePreview) && (
                <div className="relative rounded-2xl border border-border bg-secondary/35 p-3 sm:p-4">
                  <div className="overflow-hidden rounded-xl border border-border/80 bg-card">
                    <img
                      src={(activeNote ? sImagePreview : imagePreview) ?? ""}
                      className="max-h-96 w-full object-contain"
                      alt=""
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => (activeNote ? setSImage(null) : setImage(null))}
                    className="absolute right-5 top-5 rounded-full border border-border bg-card p-1.5 shadow-sm hover:bg-secondary"
                    aria-label="Remove attached image"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              )}

              {activeNote && !sImagePreview && activeNote.image_url && (
                <NoteImage
                  path={activeNote.image_url}
                  iv={activeNote.image_iv}
                  mime={activeNote.image_mime}
                  cryptoKey={key}
                  framed
                />
              )}

              {/* Sheet Footer Action Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  {(() => {
                    const words = currentText.trim() ? currentText.trim().split(/\s+/).length : 0;
                    return `${words} ${words === 1 ? "word" : "words"}`;
                  })()}
                </span>

                <div className="flex items-center gap-2">
                  {activeNote && hasActiveNoteChanges && (
                    <button
                      type="button"
                      onClick={() => {
                        setSTitle(activeNote.title);
                        setSContent(activeNote.content);
                        setSTags(activeNote.tags.join(", "));
                        setSFolderId(activeNote.folder_id);
                        setSImage(null);
                        setSheetEditing(false);
                      }}
                      className="flex items-center gap-1 rounded-lg border border-border px-3.5 py-2 text-sm hover:bg-secondary"
                    >
                      <X className="size-4" /> Cancel
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={(activeNote ? update.isPending : create.isPending) || !key}
                    className="rounded-xl bg-primary px-5 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:opacity-95 disabled:opacity-50"
                  >
                    {activeNote
                      ? update.isPending
                        ? "Saving..."
                        : "Save changes"
                      : create.isPending
                        ? "Saving..."
                        : "Save note"}
                  </button>
                </div>
              </div>
            </>
          }
        />
      </form>

      <ConfirmDialog
        open={confirmDeleteActive}
        onOpenChange={setConfirmDeleteActive}
        title="Delete this note?"
        description="This can't be undone."
        confirmText="Delete"
        onConfirm={() => {
          if (activeNote) {
            remove.mutate(activeNote);
          }
          setConfirmDeleteActive(false);
        }}
      />
    </div>
  );
}

function NoteImage({
  path,
  iv,
  mime,
  cryptoKey,
  framed = false,
}: {
  path: string;
  iv: string | null;
  mime: string | null;
  cryptoKey: CryptoKey | null;
  framed?: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      const { data } = await supabase.storage.from(MEDIA_BUCKET).createSignedUrl(path, 60 * 60);
      if (!data?.signedUrl || cancelled) return;
      if (!iv) {
        setSrc(data.signedUrl);
        return;
      }
      if (!cryptoKey) return;
      try {
        const bytes = await (await fetch(data.signedUrl)).arrayBuffer();
        const pt = await decryptBytes(cryptoKey, bytes, iv);
        objectUrl = URL.createObjectURL(new Blob([pt], { type: mime || "image/jpeg" }));
        if (!cancelled) setSrc(objectUrl);
      } catch {
        // unreadable image
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, iv, mime, cryptoKey]);
  if (!src) return null;
  if (framed) {
    return (
      <div className="mt-4 rounded-2xl border border-border bg-secondary/35 p-3 sm:p-4">
        <div className="overflow-hidden rounded-xl border border-border/80 bg-card">
          <img src={src} className="max-h-[30rem] w-full object-contain" alt="" loading="lazy" />
        </div>
      </div>
    );
  }
  return <img src={src} className="mt-3 max-h-56 w-full rounded-md border border-border object-cover" alt="" loading="lazy" />;
}


