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
  Pencil,
  ScanText,
  Loader2,
} from "lucide-react";
import { RichEditor } from "@/components/RichEditor";
import { RichText } from "@/components/RichText";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { AppSelect } from "@/components/AppSelect";
import { useBrowserDraft } from "@/lib/browser-drafts";
import { useVault } from "@/lib/vault";
import {
  fetchStorageBytesWithOfflineCache,
  fetchStorageUrlWithOfflineCache,
  peekDecryptedMediaUrl,
  setDecryptedMediaUrl,
} from "@/lib/offline-supabase";
import {
  decryptBytes,
  decryptField,
  decryptText,
  encryptBlob,
  encryptField,
  encryptText,
} from "@/lib/crypto";
import { folderOptions, folderWithDescendants, type FolderRow } from "@/lib/folders";
import { transcribeHandwritingFile } from "@/lib/handwriting-ocr";

const NONE = "__none__";

export const Route = createFileRoute("/app/notes")({
  component: NotesPage,
  head: () => ({
    meta: [
      { title: "Notes · The PaperVault" },
      {
        name: "description",
        content: "Private, end-to-end encrypted notes with folders, tags and search.",
      },
      { property: "og:title", content: "Notes · The PaperVault" },
      {
        property: "og:description",
        content: "Private, end-to-end encrypted notes with folders, tags and search.",
      },
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

async function uploadEncrypted(
  userId: string,
  key: CryptoKey,
  file: File,
  preallocatedPath?: string,
) {
  if (!ALLOWED[file.type]) throw new Error("Only JPEG, PNG, WebP, or GIF images are allowed");
  if (file.size > 15 * 1024 * 1024) throw new Error("Image must be smaller than 15 MB");
  const path = preallocatedPath ?? `${userId}/${crypto.randomUUID()}.bin`;
  const { blob, iv, mime } = await encryptBlob(key, file);
  const { error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .upload(path, blob, { contentType: "application/octet-stream" });
  if (error) throw error;
  return { path, iv, mime: mime || file.type };
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

function getNoteOneLinePreview(content: string): string {
  if (!content) return "No additional text";
  const stripped = content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[#>*\-\d.]+\s+/gm, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped || "No additional text";
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
  const [draft, setDraft, clearDraft] = useBrowserDraft<NoteDraft>(
    `papervault:note-draft:${user.id}`,
    {
      title: "",
      content: "",
      tags: "",
      folderId: null,
      activeNoteId: null,
    },
  );
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
              void supabase
                .from("note_folders")
                .update({ name: encName })
                .eq("id", f.id)
                .eq("user_id", user.id);
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
                void supabase
                  .from("notes")
                  .update({ title: null, tags: null } as never)
                  .eq("id", r.id)
                  .eq("user_id", user.id);
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
                .eq("id", r.id)
                .eq("user_id", user.id);
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
    if (q)
      rows = rows.filter((n) =>
        `${n.title}\n${n.content}\n${n.tags.join(" ")}`.toLowerCase().includes(q),
      );
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

  const folderCounts = useMemo(() => {
    const allNotes = notes.data ?? [];
    const allFolders = folders.data ?? [];
    const counts = new Map<string, number>();
    counts.set("all", allNotes.length);
    counts.set("none", allNotes.filter((n) => !n.folder_id).length);
    for (const f of allFolders) {
      const desc = folderWithDescendants(allFolders, f.id);
      counts.set(f.id, allNotes.filter((n) => n.folder_id && desc.has(n.folder_id)).length);
    }
    return counts;
  }, [notes.data, folders.data]);

  const activeNote = useMemo(
    () =>
      selectedNoteId ? ((notes.data ?? []).find((n) => n.id === selectedNoteId) ?? null) : null,
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
    setSheetEditing(true);
    setDraftPreview(false);
    setBrowseOpen(false);
    setTimeout(() => textareaRef.current?.focus(), 30);
  }, [setDraft]);

  type CreateNoteVars = {
    id: string;
    title: string;
    content: string;
    tags: string;
    folderId: string | null;
    image: File | null;
    optimisticImagePath: string | null;
  };

  const create = useMutation({
    mutationFn: async (vars: CreateNoteVars): Promise<Note> => {
      if (!key) throw new Error("Vault is locked");
      let img: { path: string; iv: string; mime: string } | null = null;
      if (vars.image) {
        img = await uploadEncrypted(
          user.id,
          key,
          vars.image,
          vars.optimisticImagePath ?? undefined,
        );
        const existingPreview = peekDecryptedMediaUrl(MEDIA_BUCKET, img.path, null);
        if (existingPreview) {
          setDecryptedMediaUrl(MEDIA_BUCKET, img.path, img.iv, existingPreview);
        }
      }
      const tagArr = vars.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const payload: Payload = {
        t: vars.title,
        c: vars.content,
        g: tagArr,
        ...(img ? { ii: img.iv, im: img.mime } : {}),
      };
      const { ct, iv } = await encryptText(key, JSON.stringify(payload));
      const { data: inserted, error } = await supabase
        .from("notes")
        .insert({
          id: vars.id,
          user_id: user.id,
          title: null,
          content: ct,
          iv,
          tags: null,
          image_url: img?.path ?? null,
          folder_id: vars.folderId,
        } as never)
        .select("id,created_at,updated_at")
        .single();
      if (error) throw error;
      if (img) {
        try {
          const captionPlain = vars.title || "Note attachment";
          const { ct: capCt, iv: capIv } = await encryptText(key, captionPlain);
          await supabase.from("gallery_images").insert({
            user_id: user.id,
            storage_path: img.path,
            caption: capCt,
            iv: img.iv,
            caption_iv: capIv,
            mime: img.mime,
          });
        } catch {
          // non-blocking
        }
      }
      const row = inserted as { id: string; created_at: string; updated_at: string };
      return {
        id: row.id,
        title: vars.title,
        content: vars.content,
        tags: tagArr,
        image_url: img?.path ?? null,
        image_iv: img?.iv ?? null,
        image_mime: img?.mime ?? null,
        folder_id: vars.folderId,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    },
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ["notes", user.id] });
      const prevNotes = qc.getQueryData<Note[]>(["notes", user.id]) ?? [];
      const prevDraft = { ...draft };
      const prevImage = image;
      const prevSelectedNoteId = selectedNoteId;
      const prevIsCreatingNew = isCreatingNew;
      const prevSheetEditing = sheetEditing;

      if (vars.image && vars.optimisticImagePath) {
        const previewUrl = URL.createObjectURL(vars.image);
        setDecryptedMediaUrl(MEDIA_BUCKET, vars.optimisticImagePath, null, previewUrl);
      }

      const nowIso = new Date().toISOString();
      const tagArr = vars.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const optimisticNote: Note = {
        id: vars.id,
        title: vars.title,
        content: vars.content,
        tags: tagArr,
        image_url: vars.optimisticImagePath,
        image_iv: null,
        image_mime: vars.image?.type ?? null,
        folder_id: vars.folderId,
        created_at: nowIso,
        updated_at: nowIso,
      };

      qc.setQueryData<Note[]>(["notes", user.id], (old) => [
        optimisticNote,
        ...(old ?? []).filter((n) => n.id !== optimisticNote.id),
      ]);
      setIsCreatingNew(false);
      setSelectedNoteId(optimisticNote.id);
      setSTitle(optimisticNote.title);
      setSContent(optimisticNote.content);
      setSTags(optimisticNote.tags.join(", "));
      setSFolderId(optimisticNote.folder_id);
      setSheetEditing(false);
      setDraft({
        title: "",
        content: "",
        tags: "",
        folderId: null,
        activeNoteId: optimisticNote.id,
      });
      setImage(null);
      setDraftPreview(false);

      return {
        prevNotes,
        prevDraft,
        prevImage,
        prevSelectedNoteId,
        prevIsCreatingNew,
        prevSheetEditing,
      };
    },
    onSuccess: (createdNote) => {
      qc.setQueryData<Note[]>(["notes", user.id], (old) => [
        createdNote,
        ...(old ?? []).filter((n) => n.id !== createdNote.id),
      ]);
      toast.success("Note saved");
    },
    onError: (e: Error, _vars, ctx) => {
      if (ctx) {
        qc.setQueryData(["notes", user.id], ctx.prevNotes);
        setDraft(ctx.prevDraft);
        setImage(ctx.prevImage);
        setSelectedNoteId(ctx.prevSelectedNoteId);
        setIsCreatingNew(ctx.prevIsCreatingNew);
        setSheetEditing(ctx.prevSheetEditing);
      }
      toast.error(e.message);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["notes"] });
      qc.invalidateQueries({ queryKey: ["gallery"] });
      qc.invalidateQueries({ queryKey: ["heatmap-activity"] });
    },
  });

  const update = useMutation({
    mutationFn: async (vars: {
      note: Note;
      title: string;
      content: string;
      tags: string;
      folder_id: string | null;
      newImage?: File | null;
      optimisticImagePath?: string | null;
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
          try {
            await Promise.all([
              supabase.storage.from(MEDIA_BUCKET).remove([n.image_url]),
              supabase
                .from("gallery_images")
                .delete()
                .eq("user_id", user.id)
                .eq("storage_path", n.image_url),
            ]);
          } catch {
            // ignore
          }
        }
        const up = await uploadEncrypted(
          user.id,
          key,
          vars.newImage,
          vars.optimisticImagePath ?? undefined,
        );
        imgUrl = up.path;
        imgIv = up.iv;
        imgMime = up.mime;
        const existingPreview = peekDecryptedMediaUrl(MEDIA_BUCKET, up.path, null);
        if (existingPreview) {
          setDecryptedMediaUrl(MEDIA_BUCKET, up.path, up.iv, existingPreview);
        }
        try {
          const captionPlain = vars.title || "Note attachment";
          const { ct: capCt, iv: capIv } = await encryptText(key, captionPlain);
          await supabase.from("gallery_images").insert({
            user_id: user.id,
            storage_path: up.path,
            caption: capCt,
            iv: up.iv,
            caption_iv: capIv,
            mime: up.mime,
          });
        } catch {
          // ignore
        }
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
        .eq("id", n.id)
        .eq("user_id", user.id);
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
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ["notes", user.id] });
      const prevNotes = qc.getQueryData<Note[]>(["notes", user.id]) ?? [];
      const prevSImage = sImage;
      const prevSheetEditing = sheetEditing;

      if (vars.newImage && vars.optimisticImagePath) {
        const previewUrl = URL.createObjectURL(vars.newImage);
        setDecryptedMediaUrl(MEDIA_BUCKET, vars.optimisticImagePath, null, previewUrl);
      }

      const tagArr = vars.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const optimisticNote: Note = {
        ...vars.note,
        title: vars.title,
        content: vars.content,
        tags: tagArr,
        folder_id: vars.folder_id,
        image_url: vars.newImage
          ? (vars.optimisticImagePath ?? vars.note.image_url)
          : vars.note.image_url,
        image_iv: vars.newImage ? null : vars.note.image_iv,
        image_mime: vars.newImage ? vars.newImage.type : vars.note.image_mime,
        updated_at: new Date().toISOString(),
      };

      qc.setQueryData<Note[]>(["notes", user.id], (old) =>
        (old ?? []).map((n) => (n.id === vars.note.id ? optimisticNote : n)),
      );
      setSImage(null);
      setSheetEditing(false);

      return { prevNotes, prevSImage, prevSheetEditing };
    },
    onSuccess: (updatedNote) => {
      qc.setQueryData<Note[]>(["notes", user.id], (old) =>
        (old ?? []).map((n) => (n.id === updatedNote.id ? updatedNote : n)),
      );
      toast.success("Note updated");
    },
    onError: (e: Error, vars, ctx) => {
      if (ctx) {
        qc.setQueryData(["notes", user.id], ctx.prevNotes);
        setSTitle(vars.note.title);
        setSContent(vars.note.content);
        setSTags(vars.note.tags.join(", "));
        setSFolderId(vars.note.folder_id);
        setSImage(ctx.prevSImage);
        setSheetEditing(ctx.prevSheetEditing);
      }
      toast.error(e.message);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["notes"] });
      qc.invalidateQueries({ queryKey: ["gallery"] });
    },
  });

  const remove = useMutation({
    mutationFn: async (note: Note) => {
      if (note.image_url) {
        try {
          await Promise.all([
            supabase.storage.from(MEDIA_BUCKET).remove([note.image_url]),
            supabase
              .from("gallery_images")
              .delete()
              .eq("user_id", user.id)
              .eq("storage_path", note.image_url),
          ]);
        } catch {
          // ignore
        }
      }
      const { error } = await supabase
        .from("notes")
        .delete()
        .eq("id", note.id)
        .eq("user_id", user.id);
      if (error) throw error;
      return note.id;
    },
    onMutate: async (note) => {
      await qc.cancelQueries({ queryKey: ["notes", user.id] });
      const prevNotes = qc.getQueryData<Note[]>(["notes", user.id]) ?? [];
      const prevSelectedNoteId = selectedNoteId;
      const prevSheetEditing = sheetEditing;

      const remaining = prevNotes.filter((n) => n.id !== note.id);
      qc.setQueryData<Note[]>(["notes", user.id], remaining);
      if (selectedNoteId === note.id) {
        const nextNote = remaining[0] ?? null;
        setSelectedNoteId(nextNote?.id ?? null);
        setDraft((c) => ({ ...c, activeNoteId: nextNote?.id ?? null }));
        setSheetEditing(false);
      }

      return { prevNotes, prevSelectedNoteId, prevSheetEditing };
    },
    onError: (e: Error, _note, ctx) => {
      if (ctx) {
        qc.setQueryData(["notes", user.id], ctx.prevNotes);
        setSelectedNoteId(ctx.prevSelectedNoteId);
        setDraft((c) => ({ ...c, activeNoteId: ctx.prevSelectedNoteId }));
        setSheetEditing(ctx.prevSheetEditing);
      }
      toast.error(e.message);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["gallery"] });
      qc.invalidateQueries({ queryKey: ["notes"] });
      qc.invalidateQueries({ queryKey: ["heatmap-activity"] });
    },
  });

  const createFolder = useMutation({
    mutationFn: async (name: string): Promise<FolderRow> => {
      if (!key) throw new Error("Vault is locked");
      const encName = await encryptField(key, name);
      const parentId = newFolderParent === NONE ? null : newFolderParent;
      const { data: inserted, error } = await supabase
        .from("note_folders")
        .insert({
          user_id: user.id,
          name: encName,
          parent_id: parentId,
        } as never)
        .select("id")
        .single();
      if (error) throw error;
      const row = inserted as { id: string };
      return { id: row.id, name, parent_id: parentId };
    },
    onMutate: async (name) => {
      await qc.cancelQueries({ queryKey: ["note-folders", user.id] });
      const prevFolders = qc.getQueryData<FolderRow[]>(["note-folders", user.id]) ?? [];
      const tempId = `temp-${crypto.randomUUID()}`;
      const parentId = newFolderParent === NONE ? null : newFolderParent;
      const optimisticFolder: FolderRow = { id: tempId, name, parent_id: parentId };
      qc.setQueryData<FolderRow[]>(["note-folders", user.id], (old) =>
        [...(old ?? []), optimisticFolder].sort((a, b) => a.name.localeCompare(b.name)),
      );
      setNewFolder("");
      return { prevFolders, tempId, name };
    },
    onSuccess: (newF, _name, ctx) => {
      qc.setQueryData<FolderRow[]>(["note-folders", user.id], (old) =>
        [...(old ?? []).filter((f) => f.id !== ctx?.tempId && f.id !== newF.id), newF].sort(
          (a, b) => a.name.localeCompare(b.name),
        ),
      );
    },
    onError: (e: Error, name, ctx) => {
      if (ctx) {
        qc.setQueryData(["note-folders", user.id], ctx.prevFolders);
        setNewFolder(name);
      }
      toast.error(e.message);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["note-folders"] });
    },
  });

  const deleteFolder = useMutation({
    mutationFn: async (targetFolderId: string) => {
      const { error } = await supabase
        .from("note_folders")
        .delete()
        .eq("id", targetFolderId)
        .eq("user_id", user.id);
      if (error) throw error;
      return targetFolderId;
    },
    onMutate: async (targetFolderId) => {
      await qc.cancelQueries({ queryKey: ["note-folders", user.id] });
      const prevFolders = qc.getQueryData<FolderRow[]>(["note-folders", user.id]) ?? [];
      const prevFilterFolder = filterFolder;
      qc.setQueryData<FolderRow[]>(["note-folders", user.id], (old) =>
        (old ?? []).filter((f) => f.id !== targetFolderId),
      );
      setFilterFolder("all");
      return { prevFolders, prevFilterFolder };
    },
    onSuccess: () => {
      toast.success("Folder deleted");
    },
    onError: (e: Error, _targetFolderId, ctx) => {
      if (ctx) {
        qc.setQueryData(["note-folders", user.id], ctx.prevFolders);
        setFilterFolder(ctx.prevFilterFolder);
      }
      toast.error(e.message);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["note-folders"] });
      qc.invalidateQueries({ queryKey: ["notes"] });
    },
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

  const ocrInputRef = useRef<HTMLInputElement | null>(null);
  const [ocrProgress, setOcrProgress] = useState<{ current: number; total: number } | null>(null);

  const handleHandwritingFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        toast.error("Handwriting recognition requires an internet connection.");
        return;
      }
      const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (list.length === 0) {
        toast.error("Please select one or more image files.");
        return;
      }

      if (activeNote && !sheetEditing) {
        setSheetEditing(true);
      }

      setOcrProgress({ current: 1, total: list.length });
      let accumulated = activeNote ? sContent : content;
      let successCount = 0;

      try {
        for (let i = 0; i < list.length; i++) {
          setOcrProgress({ current: i + 1, total: list.length });
          const extracted = await transcribeHandwritingFile(list[i]);
          if (extracted) {
            accumulated = accumulated.trim()
              ? `${accumulated.trimEnd()}\n\n${extracted}`
              : extracted;
            if (activeNote) {
              setSContent(accumulated);
            } else {
              setDraft((c) => ({ ...c, content: accumulated }));
            }
            successCount++;
          }
        }
        if (successCount > 0) {
          toast.success(
            list.length === 1
              ? "Handwriting converted to text"
              : `Converted ${successCount} of ${list.length} pages to text`,
          );
        } else {
          toast.error("No legible handwriting found in the selected image(s).");
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to transcribe handwriting.");
      } finally {
        setOcrProgress(null);
      }
    },
    [activeNote, sheetEditing, sContent, content, setDraft],
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
      <div className="relative flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <p className="font-hand text-2xl text-sepia">scraps and reminders</p>
          <h1 className="font-serif text-4xl text-primary">Notes</h1>
          <p className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">
            end-to-end encrypted
          </p>
        </div>

        <div className="flex w-full items-center justify-between gap-2.5 sm:w-auto sm:justify-end">
          <button
            type="button"
            onClick={startNewNote}
            className="flex items-center justify-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:opacity-95"
          >
            <Plus className="size-4" />
            <span>New Note</span>
          </button>

          <button
            type="button"
            onClick={() => setBrowseOpen((o) => !o)}
            className="flex flex-1 items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm font-medium text-primary shadow-sm transition hover:bg-secondary/60 sm:flex-initial sm:justify-start"
          >
            <span className="flex items-center gap-2">
              <Folder className="size-4 shrink-0 text-sepia" />
              <span>Browse Pages ({totalNotesCount})</span>
            </span>
            {browseOpen ? (
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            )}
          </button>
        </div>

        {/* Translucent, Blurry, Warm Sepia-Tinted Floating Menu Matching Website Theme */}
        {browseOpen && (
          <>
            <div
              className="fixed inset-0 z-30 bg-[oklch(0.28_0.04_50_/_0.08)] dark:bg-black/45 backdrop-blur-[1px]"
              onClick={() => setBrowseOpen(false)}
            />
            <div className="absolute inset-x-0 top-full z-40 mt-2.5 w-full max-w-[calc(100vw-2rem)] space-y-3 rounded-2xl border border-border/85 bg-[oklch(0.94_0.032_76_/_0.9)] dark:bg-card/95 p-3 text-foreground shadow-xl backdrop-blur-2xl sm:left-auto sm:right-0 sm:p-4 md:w-[44rem] lg:w-[50rem]">
              {/* Top Header Row */}
              <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-2.5 px-1">
                <div className="flex min-w-0 items-center gap-2">
                  <Folder className="size-4 shrink-0 text-sepia" />
                  <span className="truncate font-serif text-base font-medium text-primary sm:text-lg">
                    Browse Pages
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    ·{" "}
                    {filterFolder === "all"
                      ? "All Notes"
                      : filterFolder === "none"
                        ? "Unfiled"
                        : (fOpts.find((f) => f.value === filterFolder)?.label ?? "Folder")}{" "}
                    ({totalNotesCount})
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
                  <button
                    type="button"
                    onClick={startNewNote}
                    className="flex items-center gap-1 rounded-lg border border-border/80 bg-card/80 px-2.5 py-1 text-xs font-medium text-primary shadow-2xs backdrop-blur-md transition hover:bg-card whitespace-nowrap shrink-0"
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

              {/* ============================================================ */}
              {/* TABLET & DESKTOP VIEW (md+): Apple Notes Side-by-Side Layout */}
              {/* ============================================================ */}
              <div className="hidden md:grid md:grid-cols-[230px_1fr] lg:grid-cols-[250px_1fr] md:gap-3.5 md:items-stretch">
                {/* Left Column: Folders Sidebar + New Folder Creator */}
                <div className="flex flex-col justify-between rounded-xl border border-border/75 bg-[oklch(0.89_0.038_74_/_0.52)] dark:bg-secondary/65 p-2.5 backdrop-blur-md">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between px-2 py-0.5">
                      <span className="text-xs font-medium text-muted-foreground">Folders</span>
                      {filterFolder !== "all" && filterFolder !== "none" && (
                        <button
                          type="button"
                          onClick={() => deleteFolder.mutate(filterFolder)}
                          title="Delete selected folder"
                          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:bg-secondary/80 hover:text-destructive"
                        >
                          <Trash2 className="size-3" />
                          <span>Delete</span>
                        </button>
                      )}
                    </div>

                    <div className="max-h-[16.5rem] space-y-0.5 overflow-y-auto pr-0.5">
                      <button
                        type="button"
                        onClick={() => setFilterFolder("all")}
                        className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition ${
                          filterFolder === "all"
                            ? "bg-primary text-primary-foreground font-medium shadow-2xs"
                            : "text-foreground/85 hover:bg-card/70"
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <Folder
                            className={`size-3.5 shrink-0 ${
                              filterFolder === "all" ? "text-primary-foreground" : "text-sepia"
                            }`}
                          />
                          <span className="truncate">All Notes</span>
                        </span>
                        <span
                          className={`text-xs tabular-nums ${
                            filterFolder === "all"
                              ? "text-primary-foreground/85"
                              : "text-muted-foreground"
                          }`}
                        >
                          {folderCounts.get("all") ?? 0}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setFilterFolder("none")}
                        className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition ${
                          filterFolder === "none"
                            ? "bg-primary text-primary-foreground font-medium shadow-2xs"
                            : "text-foreground/85 hover:bg-card/70"
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <FileText
                            className={`size-3.5 shrink-0 ${
                              filterFolder === "none" ? "text-primary-foreground" : "text-sepia"
                            }`}
                          />
                          <span className="truncate">Unfiled Notes</span>
                        </span>
                        <span
                          className={`text-xs tabular-nums ${
                            filterFolder === "none"
                              ? "text-primary-foreground/85"
                              : "text-muted-foreground"
                          }`}
                        >
                          {folderCounts.get("none") ?? 0}
                        </span>
                      </button>

                      {fOpts.map((o) => {
                        const isSelectedFolder = filterFolder === o.value;
                        const segments = o.label.split(" / ");
                        const depth = Math.min(segments.length - 1, 4);
                        const leafName = segments[segments.length - 1] || o.label;
                        const count = folderCounts.get(o.value) ?? 0;
                        return (
                          <button
                            key={o.value}
                            type="button"
                            onClick={() => setFilterFolder(o.value)}
                            title={o.label}
                            className={`flex w-full items-center justify-between gap-2 rounded-lg py-1.5 pr-2.5 text-left text-sm transition ${
                              depth === 0
                                ? "pl-2.5"
                                : depth === 1
                                  ? "pl-5"
                                  : depth === 2
                                    ? "pl-7"
                                    : "pl-9"
                            } ${
                              isSelectedFolder
                                ? "bg-primary text-primary-foreground font-medium shadow-2xs"
                                : "text-foreground/85 hover:bg-card/70"
                            }`}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <Folder
                                className={`size-3.5 shrink-0 ${
                                  isSelectedFolder ? "text-primary-foreground" : "text-sepia"
                                }`}
                              />
                              <span className="truncate">{leafName}</span>
                            </span>
                            <span
                              className={`text-xs tabular-nums ${
                                isSelectedFolder
                                  ? "text-primary-foreground/85"
                                  : "text-muted-foreground"
                              }`}
                            >
                              {count}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Pinned New Folder Form at Bottom of Folders Column */}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (newFolder.trim()) createFolder.mutate(newFolder.trim());
                    }}
                    className="mt-3 space-y-2 border-t border-border/65 pt-2.5 text-xs"
                  >
                    <input
                      value={newFolder}
                      onChange={(e) => setNewFolder(e.target.value)}
                      placeholder="New folder name..."
                      className="w-full rounded-lg border border-border/80 bg-card/85 px-2.5 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/80 focus:border-primary/40"
                    />
                    <div className="flex items-center gap-1.5">
                      <div className="min-w-0 flex-1">
                        <AppSelect
                          value={newFolderParent}
                          onValueChange={setNewFolderParent}
                          triggerClassName="w-full border-border/80 bg-card/85 text-xs text-foreground hover:bg-card"
                          options={[
                            { value: NONE, label: "Top level" },
                            ...fOpts.map((o) => ({ value: o.value, label: `inside ${o.label}` })),
                          ]}
                        />
                      </div>
                      <button
                        type="submit"
                        className="flex shrink-0 items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground shadow-2xs transition hover:opacity-95 whitespace-nowrap"
                      >
                        <FolderPlus className="size-3.5" /> Add
                      </button>
                    </div>
                  </form>
                </div>

                {/* Right Column: Search, Sort & Apple Notes List (Title + Date & 1-Line Preview) */}
                <div className="flex min-w-0 flex-col space-y-2.5">
                  <div className="flex items-center gap-2">
                    <label className="flex flex-1 items-center gap-2 rounded-xl border border-border/75 bg-[oklch(0.89_0.038_74_/_0.52)] dark:bg-secondary/65 px-3 py-1.5 text-sm backdrop-blur-md transition focus-within:border-primary/40 focus-within:bg-card/80">
                      <Search className="size-4 shrink-0 text-sepia" />
                      <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search notes..."
                        className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/80"
                      />
                      {query && (
                        <button
                          type="button"
                          onClick={() => setQuery("")}
                          aria-label="Clear search"
                        >
                          <X className="size-4 text-muted-foreground hover:text-foreground" />
                        </button>
                      )}
                    </label>

                    <div className="shrink-0">
                      <AppSelect
                        value={sort}
                        onValueChange={(v) => setSort(v as Sort)}
                        triggerClassName="border-border/80 bg-card/85 text-xs text-foreground hover:bg-card"
                        options={[
                          { value: "newest", label: "Newest first" },
                          { value: "oldest", label: "Oldest first" },
                          { value: "edited", label: "Recently edited" },
                          { value: "title", label: "Title A–Z" },
                        ]}
                      />
                    </div>
                  </div>

                  {/* Apple Notes-Style List: Title on top, Date + 1-Line Preview side-by-side */}
                  <div className="max-h-[22rem] flex-1 space-y-1.5 overflow-y-auto pr-0.5">
                    {notes.isLoading && (
                      <div className="rounded-xl border border-border/75 bg-[oklch(0.89_0.038_74_/_0.52)] dark:bg-secondary/65 p-4 font-hand text-sepia backdrop-blur-md">
                        gathering notes...
                      </div>
                    )}
                    {!notes.isLoading && filtered.length === 0 && (
                      <div className="flex h-44 flex-col items-center justify-center rounded-xl border border-border/75 bg-[oklch(0.89_0.038_74_/_0.52)] dark:bg-secondary/65 p-4 text-center text-sm text-muted-foreground backdrop-blur-md">
                        <p>{notes.data?.length === 0 ? "No notes yet." : "No notes match."}</p>
                      </div>
                    )}
                    {filtered.map((n) => {
                      const isSelected = n.id === selectedNoteId;
                      const folderLabel = fOpts.find((f) => f.value === n.folder_id)?.label?.trim();
                      const previewLine = getNoteOneLinePreview(n.content);
                      return (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => openNoteInSheet(n, false)}
                          className={`group flex w-full flex-col gap-1 rounded-xl border px-3.5 py-2.5 text-left backdrop-blur-md transition ${
                            isSelected
                              ? "border-primary/50 bg-card/95 shadow-xs"
                              : "border-border/70 bg-[oklch(0.89_0.038_74_/_0.52)] dark:bg-secondary/60 hover:border-primary/30 hover:bg-card/80"
                          }`}
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <p className="min-w-0 flex-1 truncate font-serif text-base font-medium leading-snug text-primary">
                              {n.title || "Untitled"}
                            </p>
                            {folderLabel && filterFolder === "all" && (
                              <span className="shrink-0 truncate max-w-[10rem] text-[11px] text-muted-foreground">
                                {folderLabel}
                              </span>
                            )}
                          </div>

                          <div className="flex items-baseline gap-2 text-xs">
                            <span className="shrink-0 font-medium tabular-nums text-foreground/80">
                              {formatSheetDate(n.updated_at || n.created_at)}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-muted-foreground">
                              {previewLine}
                            </span>
                          </div>

                          {n.tags.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-[11px] text-sepia">
                              {n.tags.map((t) => (
                                <span key={t}>#{t}</span>
                              ))}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* ============================================================ */}
              {/* MOBILE VIEW (< md): Classic Menu Style with Apple Notes Rows */}
              {/* ============================================================ */}
              <div className="space-y-2.5 md:hidden">
                {/* Search Box (Translucent Warm-Tinted Box) */}
                <label className="flex items-center gap-2 rounded-xl border border-border/75 bg-[oklch(0.89_0.038_74_/_0.52)] dark:bg-secondary/65 px-3.5 py-2 text-sm backdrop-blur-md transition focus-within:border-primary/40 focus-within:bg-card/80">
                  <Search className="size-4 shrink-0 text-sepia" />
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
                <div className="grid grid-cols-1 gap-2 rounded-xl border border-border/75 bg-[oklch(0.89_0.038_74_/_0.52)] dark:bg-secondary/65 p-2.5 text-xs backdrop-blur-md">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <Folder className="size-3.5 text-sepia" />
                      Folder
                    </span>
                    <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
                      <AppSelect
                        value={filterFolder}
                        onValueChange={(v) => setFilterFolder(v)}
                        triggerClassName="w-full border-border/80 bg-card/80 text-foreground hover:bg-card"
                        options={[
                          { value: "all", label: `All notes (${folderCounts.get("all") ?? 0})` },
                          { value: "none", label: `No folder (${folderCounts.get("none") ?? 0})` },
                          ...fOpts.map((o) => ({
                            value: o.value,
                            label: `${o.label} (${folderCounts.get(o.value) ?? 0})`,
                          })),
                        ]}
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
                  </div>

                  <label className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Sort</span>
                    <div className="min-w-0 flex-1">
                      <AppSelect
                        value={sort}
                        onValueChange={(v) => setSort(v as Sort)}
                        triggerClassName="w-full border-border/80 bg-card/80 text-foreground hover:bg-card"
                        options={[
                          { value: "newest", label: "Newest first" },
                          { value: "oldest", label: "Oldest first" },
                          { value: "edited", label: "Recently edited" },
                          { value: "title", label: "Title A–Z" },
                        ]}
                      />
                    </div>
                  </label>
                </div>

                {/* New Folder Creation Box (Translucent Warm-Tinted Box) */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (newFolder.trim()) createFolder.mutate(newFolder.trim());
                  }}
                  className="flex flex-col gap-2 rounded-xl border border-border/75 bg-[oklch(0.89_0.038_74_/_0.52)] dark:bg-secondary/65 p-2.5 text-xs backdrop-blur-md"
                >
                  <input
                    value={newFolder}
                    onChange={(e) => setNewFolder(e.target.value)}
                    placeholder="New folder"
                    className="w-full rounded-md border border-border/80 bg-card/80 px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/80 focus:border-primary/40"
                  />
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <AppSelect
                        value={newFolderParent}
                        onValueChange={setNewFolderParent}
                        triggerClassName="w-full border-border/80 bg-card/80 text-foreground hover:bg-card"
                        options={[
                          { value: NONE, label: "Top level" },
                          ...fOpts.map((o) => ({ value: o.value, label: `inside ${o.label}` })),
                        ]}
                      />
                    </div>
                    <button
                      type="submit"
                      className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-2xs transition hover:opacity-95"
                    >
                      <FolderPlus className="size-3.5" /> Add
                    </button>
                  </div>
                </form>

                {/* Saved Pages List (Apple Notes Style: Title + Date & 1-Line Preview) */}
                <div className="max-h-64 space-y-2 overflow-y-auto pr-0.5">
                  {notes.isLoading && (
                    <div className="rounded-xl border border-border/75 bg-[oklch(0.89_0.038_74_/_0.52)] dark:bg-secondary/65 p-3 font-hand text-sepia backdrop-blur-md">
                      gathering notes...
                    </div>
                  )}
                  {!notes.isLoading && filtered.length === 0 && (
                    <div className="rounded-xl border border-border/75 bg-[oklch(0.89_0.038_74_/_0.52)] dark:bg-secondary/65 p-3 text-sm text-muted-foreground backdrop-blur-md">
                      {notes.data?.length === 0 ? "No notes yet." : "No notes match."}
                    </div>
                  )}
                  {filtered.map((n) => {
                    const isSelected = n.id === selectedNoteId;
                    const folderLabel = fOpts.find((f) => f.value === n.folder_id)?.label?.trim();
                    const previewLine = getNoteOneLinePreview(n.content);
                    return (
                      <button
                        key={n.id}
                        type="button"
                        onClick={() => openNoteInSheet(n, false)}
                        className={`flex w-full flex-col gap-1 rounded-xl border px-3 py-2.5 text-left backdrop-blur-md transition ${
                          isSelected
                            ? "border-primary/45 bg-card/90 shadow-2xs"
                            : "border-border/75 bg-[oklch(0.89_0.038_74_/_0.52)] dark:bg-secondary/60 hover:border-primary/30 hover:bg-card/80"
                        }`}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="min-w-0 flex-1 truncate font-serif text-base font-medium leading-snug text-primary">
                            {n.title || "Untitled"}
                          </p>
                          {folderLabel && filterFolder === "all" && (
                            <span className="shrink-0 truncate max-w-[7.5rem] text-[11px] text-muted-foreground">
                              {folderLabel}
                            </span>
                          )}
                        </div>

                        <div className="flex items-baseline gap-2 text-xs">
                          <span className="shrink-0 font-medium tabular-nums text-foreground/80">
                            {formatSheetDate(n.updated_at || n.created_at)}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-muted-foreground">
                            {previewLine}
                          </span>
                        </div>

                        {n.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 pt-0.5 text-[11px] text-sepia">
                            {n.tags.map((t) => (
                              <span key={t}>#{t}</span>
                            ))}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      <input
        ref={ocrInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          void handleHandwritingFiles(e.target.files);
          e.currentTarget.value = "";
        }}
      />

      {/* Metadata Row Above the Main Studio Sheet (Date · Folder Selector · Handwriting to Text · Tags · Delete Icon) */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-sm text-muted-foreground">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <div className="inline-flex items-center gap-1.5 text-foreground/85">
            <span>{formatSheetDate(activeNote?.updated_at ?? activeNote?.created_at)}</span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </div>

          <span className="text-muted-foreground/60">·</span>

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

          <span className="hidden text-muted-foreground/60 sm:inline">·</span>

          <input
            value={activeNote ? sTags : tags}
            onChange={(e) => (activeNote ? setSTags(e.target.value) : setTags(e.target.value))}
            placeholder="tags, separated, by, commas"
            className="min-w-[180px] bg-transparent text-xs text-sepia outline-none placeholder:text-muted-foreground/60 sm:text-sm"
          />
        </div>

        <div className="flex items-center gap-2">
          {activeNote && !isCreatingNew && (
            <button
              type="button"
              onClick={() => setSheetEditing((prev) => !prev)}
              title={sheetEditing ? "Done editing" : "Edit note"}
              aria-label={sheetEditing ? "Done editing" : "Edit note"}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
                sheetEditing
                  ? "border-primary bg-primary text-primary-foreground shadow-2xs hover:opacity-95"
                  : "border-border/80 bg-secondary/40 text-primary hover:bg-secondary"
              }`}
            >
              <Pencil className="size-3.5" />
              <span>{sheetEditing ? "Done editing" : "Edit note"}</span>
            </button>
          )}

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

      {/* Main Studio Sheet: Clean View Mode or Instant WYSIWYG RichEditor */}
      {activeNote && !sheetEditing && !isCreatingNew ? (
        <div className="space-y-6 rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
          <div className="border-b border-border/60 pb-4">
            <h2 className="break-words font-serif text-3xl leading-tight text-primary sm:text-4xl">
              {activeNote.title || "Untitled"}
            </h2>
          </div>

          <div className="min-h-[200px]">
            {activeNote.content ? (
              <RichText className="text-foreground/90">{activeNote.content}</RichText>
            ) : (
              <p className="italic text-muted-foreground/60">(No content)</p>
            )}
          </div>

          {activeNote.image_url && (
            <NoteImage
              path={activeNote.image_url}
              iv={activeNote.image_iv}
              mime={activeNote.image_mime}
              cryptoKey={key}
              framed
            />
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4 text-xs uppercase tracking-wide text-muted-foreground">
            <span>
              {(() => {
                const words = activeNote.content.trim()
                  ? activeNote.content.trim().split(/\s+/).length
                  : 0;
                return `${words} ${words === 1 ? "word" : "words"}`;
              })()}
            </span>
            <span className="normal-case tracking-normal text-muted-foreground/75">
              Saved {formatSheetDate(activeNote.updated_at || activeNote.created_at)}
            </span>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (activeNote) {
              update.mutate({
                note: activeNote,
                title: sTitle,
                content: sContent,
                tags: sTags,
                folder_id: sFolderId,
                newImage: sImage,
                optimisticImagePath: sImage ? `${user.id}/${crypto.randomUUID()}.bin` : null,
              });
            } else if (content.trim() || title.trim() || image) {
              create.mutate({
                id: crypto.randomUUID(),
                title,
                content,
                tags,
                folderId,
                image,
                optimisticImagePath: image ? `${user.id}/${crypto.randomUUID()}.bin` : null,
              });
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
                if (f.size > 15 * 1024 * 1024) {
                  toast.error("Image must be smaller than 15 MB");
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
            toolbarRightSlot={
              <button
                type="button"
                disabled={!!ocrProgress}
                onClick={() => ocrInputRef.current?.click()}
                title="Convert handwritten images to text (supports multiple images)"
                className="inline-flex items-center gap-1.5 text-sm text-foreground/80 transition hover:text-primary disabled:opacity-50"
              >
                {ocrProgress ? (
                  <>
                    <Loader2 className="size-4 animate-spin text-sepia" />
                    <span>
                      Scanning {ocrProgress.current}/{ocrProgress.total}...
                    </span>
                  </>
                ) : (
                  <>
                    <ScanText className="size-4 text-sepia" />
                    <span>Handwriting</span>
                  </>
                )}
              </button>
            }
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
                    {activeNote && (
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
      )}

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
  const [src, setSrc] = useState<string | null>(
    () =>
      peekDecryptedMediaUrl(MEDIA_BUCKET, path, iv) ??
      peekDecryptedMediaUrl(MEDIA_BUCKET, path, null),
  );
  useEffect(() => {
    const cached =
      peekDecryptedMediaUrl(MEDIA_BUCKET, path, iv) ??
      peekDecryptedMediaUrl(MEDIA_BUCKET, path, null);
    if (cached) {
      setSrc(cached);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.storage.from(MEDIA_BUCKET).createSignedUrl(path, 60 * 60);
        if (cancelled) return;
        if (!iv) {
          const url = await fetchStorageUrlWithOfflineCache(MEDIA_BUCKET, path, data?.signedUrl);
          if (!cancelled && url) {
            setDecryptedMediaUrl(MEDIA_BUCKET, path, null, url);
            setSrc(url);
          }
          return;
        }
        if (!cryptoKey) return;
        const bytes = await fetchStorageBytesWithOfflineCache(MEDIA_BUCKET, path, data?.signedUrl);
        if (!bytes || cancelled) return;
        const pt = await decryptBytes(cryptoKey, bytes, iv);
        const safeMime = mime && ALLOWED[mime] ? mime : "image/jpeg";
        const objectUrl = URL.createObjectURL(new Blob([pt], { type: safeMime }));
        setDecryptedMediaUrl(MEDIA_BUCKET, path, iv, objectUrl);
        if (!cancelled) setSrc(objectUrl);
      } catch {
        // unreadable image
      }
    })();
    return () => {
      cancelled = true;
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
  return (
    <img
      src={src}
      className="mt-3 max-h-56 w-full rounded-md border border-border object-cover"
      alt=""
      loading="lazy"
    />
  );
}
