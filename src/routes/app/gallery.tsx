import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  Check,
  Pencil,
  Trash2,
  Upload,
  X,
  Lock,
  Folder as FolderIcon,
  FolderOpen,
  ChevronRight,
  BookMarked,
  StickyNote,
  Layers,
  ArrowLeft,
  FileImage,
  Maximize2,
  Download,
} from "lucide-react";
import { useVault } from "@/lib/vault";
import { decryptBytes, decryptField, decryptText, encryptBlob, encryptText } from "@/lib/crypto";
import { useBrowserDraft } from "@/lib/browser-drafts";
import { folderOptions, folderWithDescendants, type FolderRow } from "@/lib/folders";
import {
  fetchStorageBytesWithOfflineCache,
  fetchStorageUrlWithOfflineCache,
} from "@/lib/offline-supabase";

export const Route = createFileRoute("/app/gallery")({
  component: GalleryPage,
});

type ImageRowRaw = {
  id: string;
  storage_path: string;
  caption: string | null;
  created_at: string;
  iv: string | null;
  caption_iv: string | null;
  mime: string | null;
};

type DecodedItem = {
  id: string;
  storage_path: string;
  bucket: "gallery" | "media";
  caption: string;
  created_at: string;
  signedUrl: string;
  iv: string | null;
  mime: string | null;
  source: "diary" | "notes";
  noteFolderId: string | null;
  originTitle?: string | null;
};

type GalleryTab = "all" | "diary" | "notes";

export function GalleryPage() {
  const { user } = Route.useRouteContext();
  const { key } = useVault();
  const qc = useQueryClient();

  const [activeTab, setActiveTab] = useState<GalleryTab>("all");
  const [selectedNoteFolderId, setSelectedNoteFolderId] = useState<string | null>(null);

  const [caption, setCaption, clearCaptionDraft] = useBrowserDraft(
    `papervault:gallery-caption:${user.id}`,
    "",
  );
  const [uploading, setUploading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftCaption, setDraftCaption] = useState("");
  const [lightboxItem, setLightboxItem] = useState<DecodedItem | null>(null);

  // 1. Fetch note folders
  const noteFoldersQuery = useQuery({
    enabled: !!key,
    queryKey: ["note-folders", user.id],
    queryFn: async (): Promise<FolderRow[]> => {
      const { data, error } = await supabase
        .from("note_folders")
        .select("id,name,parent_id")
        .eq("user_id", user.id);
      if (error) throw error;
      if (!key) return [];
      const decoded = await Promise.all(
        (data ?? []).map(async (f) => {
          try {
            const { plaintext } = await decryptField(key, f.name);
            return { id: f.id, name: plaintext, parent_id: f.parent_id };
          } catch {
            return { id: f.id, name: "[Locked folder]", parent_id: f.parent_id };
          }
        }),
      );
      return decoded.sort((a, b) => a.name.localeCompare(b.name));
    },
  });

  const noteFolders = noteFoldersQuery.data ?? [];
  const folderOptionsList = useMemo(() => folderOptions(noteFolders), [noteFolders]);

  // Target folder when uploading directly in Gallery
  const [uploadTargetFolder, setUploadTargetFolder] = useState<string | null>(null);

  // Sync uploadTargetFolder with active folder navigation
  useEffect(() => {
    if (activeTab === "notes" && selectedNoteFolderId) {
      setUploadTargetFolder(selectedNoteFolderId);
    } else if (activeTab === "diary") {
      setUploadTargetFolder(null);
    }
  }, [activeTab, selectedNoteFolderId]);

  // 2. Fetch all gallery images, cross-referenced with diary_entries and notes
  const galleryQuery = useQuery({
    enabled: !!key,
    queryKey: ["gallery", user.id],
    queryFn: async (): Promise<DecodedItem[]> => {
      const [galleryRes, diaryRes, notesRes] = await Promise.all([
        supabase
          .from("gallery_images")
          .select("id,storage_path,caption,created_at,iv,caption_iv,mime" as never)
          .eq("user_id", user.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("diary_entries")
          .select("id,image_path,title,created_at" as never)
          .eq("user_id", user.id)
          .not("image_path", "is", null),
        supabase
          .from("notes")
          .select("id,image_url,folder_id,created_at,iv" as never)
          .eq("user_id", user.id)
          .not("image_url", "is", null),
      ]);

      if (galleryRes.error) throw galleryRes.error;

      const diaryMap = new Map<string, { id: string; title: string | null }>();
      for (const d of (diaryRes.data ?? []) as { id: string; image_path: string | null; title: string | null }[]) {
        if (d.image_path) diaryMap.set(d.image_path, { id: d.id, title: d.title });
      }

      const notesMap = new Map<string, { id: string; folder_id: string | null }>();
      for (const n of (notesRes.data ?? []) as { id: string; image_url: string | null; folder_id: string | null }[]) {
        if (n.image_url) notesMap.set(n.image_url, { id: n.id, folder_id: n.folder_id });
      }

      const rawRows = (galleryRes.data ?? []) as unknown as ImageRowRaw[];
      const seenPaths = new Set(rawRows.map((r) => r.storage_path));

      // Also include notes with attached images that might not be in gallery_images yet
      const combinedItems: {
        id: string;
        storage_path: string;
        bucket: "gallery" | "media";
        captionRaw: string | null;
        captionIv: string | null;
        created_at: string;
        iv: string | null;
        mime: string | null;
        source: "diary" | "notes";
        noteFolderId: string | null;
        originTitle?: string | null;
      }[] = rawRows.map((r) => {
        let source: "diary" | "notes" = "diary";
        let noteFolderId: string | null = null;
        let originTitle: string | null = null;

        if (notesMap.has(r.storage_path)) {
          source = "notes";
          const nInfo = notesMap.get(r.storage_path);
          noteFolderId = nInfo?.folder_id ?? null;
        } else if (diaryMap.has(r.storage_path)) {
          source = "diary";
          originTitle = diaryMap.get(r.storage_path)?.title ?? null;
        }

        return {
          id: r.id,
          storage_path: r.storage_path,
          bucket: "gallery",
          captionRaw: r.caption,
          captionIv: r.caption_iv,
          created_at: r.created_at,
          iv: r.iv,
          mime: r.mime,
          source,
          noteFolderId,
          originTitle,
        };
      });

      // Include standalone note images not in gallery_images table
      for (const n of (notesRes.data ?? []) as { id: string; image_url: string | null; folder_id: string | null; created_at: string; iv: string | null }[]) {
        if (n.image_url && !seenPaths.has(n.image_url)) {
          combinedItems.push({
            id: `note-${n.id}`,
            storage_path: n.image_url,
            bucket: "media",
            captionRaw: null,
            captionIv: null,
            created_at: n.created_at,
            iv: n.iv,
            mime: "image/jpeg",
            source: "notes",
            noteFolderId: n.folder_id,
            originTitle: "Note Photo",
          });
          seenPaths.add(n.image_url);
        }
      }

      if (!combinedItems.length) return [];

      // Generate signed URLs across all items in batch
      const galleryPaths = combinedItems.filter((i) => i.bucket === "gallery").map((i) => i.storage_path);
      const mediaPaths = combinedItems.filter((i) => i.bucket === "media").map((i) => i.storage_path);

      const [gallerySigned, mediaSigned] = await Promise.all([
        galleryPaths.length > 0 ? supabase.storage.from("gallery").createSignedUrls(galleryPaths, 60 * 60) : { data: [] },
        mediaPaths.length > 0 ? supabase.storage.from("media").createSignedUrls(mediaPaths, 60 * 60) : { data: [] },
      ]);

      const urlMap = new Map<string, string>();
      for (const item of (gallerySigned.data ?? [])) {
        if (item.path && item.signedUrl) urlMap.set(item.path, item.signedUrl);
      }
      for (const item of (mediaSigned.data ?? [])) {
        if (item.path && item.signedUrl) urlMap.set(item.path, item.signedUrl);
      }

      return Promise.all(
        combinedItems.map(async (img) => {
          let captionPlain = img.captionRaw ?? "";
          let itemSource = img.source;
          let itemNoteFolderId = img.noteFolderId;

          if (img.captionRaw && img.captionIv && key) {
            try {
              const decrypted = await decryptText(key, img.captionRaw, img.captionIv);
              if (decrypted.startsWith("{") && decrypted.endsWith("}")) {
                try {
                  const parsed = JSON.parse(decrypted) as { text?: string; source?: "diary" | "notes"; folderId?: string | null };
                  captionPlain = parsed.text || "";
                  if (parsed.source) itemSource = parsed.source;
                  if (parsed.folderId !== undefined) itemNoteFolderId = parsed.folderId;
                } catch {
                  captionPlain = decrypted;
                }
              } else {
                captionPlain = decrypted;
              }
            } catch {
              captionPlain = "[encrypted]";
            }
          }

          return {
            id: img.id,
            storage_path: img.storage_path,
            bucket: img.bucket,
            caption: captionPlain,
            created_at: img.created_at,
            signedUrl: urlMap.get(img.storage_path) ?? "",
            iv: img.iv,
            mime: img.mime,
            source: itemSource,
            noteFolderId: itemNoteFolderId,
            originTitle: img.originTitle,
          };
        }),
      );
    },
  });

  const allItems = galleryQuery.data ?? [];

  // Folder & Source calculations
  const diaryItems = useMemo(() => allItems.filter((i) => i.source === "diary"), [allItems]);
  const noteItems = useMemo(() => allItems.filter((i) => i.source === "notes"), [allItems]);

  // Subfolders under current selected Notes folder
  const currentLevelNoteFolders = useMemo(() => {
    if (activeTab !== "notes") return [];
    if (!selectedNoteFolderId) {
      // Root of Notes: show folders with parent_id === null
      return noteFolders.filter((f) => f.parent_id === null);
    }
    // Child folders under the currently selected folder
    return noteFolders.filter((f) => f.parent_id === selectedNoteFolderId);
  }, [activeTab, selectedNoteFolderId, noteFolders]);

  // Breadcrumb path for Notes
  const breadcrumbPath = useMemo(() => {
    if (!selectedNoteFolderId) return [];
    const path: { id: string; name: string }[] = [];
    let currentId: string | null = selectedNoteFolderId;
    let depth = 0;
    while (currentId && depth < 10) {
      depth++;
      const f = noteFolders.find((x) => x.id === currentId);
      if (f) {
        path.unshift({ id: f.id, name: f.name });
        currentId = f.parent_id;
      } else {
        break;
      }
    }
    return path;
  }, [selectedNoteFolderId, noteFolders]);

  // Filtered photos for the active view
  const visibleItems = useMemo(() => {
    if (activeTab === "diary") {
      return diaryItems;
    }
    if (activeTab === "notes") {
      if (!selectedNoteFolderId) {
        // At the root of Notes, display notes images that have no folder or show all notes images
        return noteItems;
      }
      // Include items in this folder and its subfolders
      const folderIds = folderWithDescendants(noteFolders, selectedNoteFolderId);
      return noteItems.filter((i) => i.noteFolderId && folderIds.has(i.noteFolderId));
    }
    return allItems;
  }, [activeTab, selectedNoteFolderId, diaryItems, noteItems, allItems, noteFolders]);

  // Count photos in any note folder (including subfolders)
  const getNoteFolderPhotoCount = (folderId: string) => {
    const ids = folderWithDescendants(noteFolders, folderId);
    return noteItems.filter((i) => i.noteFolderId && ids.has(i.noteFolderId)).length;
  };

  // Upload handler
  const upload = async (file: File) => {
    if (!key) {
      toast.error("Vault is locked");
      return;
    }
    const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!ALLOWED.includes(file.type)) {
      toast.error("Only JPEG, PNG, WebP, or GIF images are allowed");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Photo must be smaller than 5 MB");
      return;
    }
    setUploading(true);
    try {
      const path = `${user.id}/${crypto.randomUUID()}.bin`;
      const { blob, iv } = await encryptBlob(key, file);

      // Upload through storage client (which routes through /api/storage-proxy)
      const { error: upErr } = await supabase.storage
        .from("gallery")
        .upload(path, blob, { contentType: "application/octet-stream" });
      if (upErr) throw upErr;

      const targetSource = activeTab === "notes" ? "notes" : "diary";
      const targetFolderId = activeTab === "notes" ? (uploadTargetFolder || selectedNoteFolderId) : null;

      // Encrypt caption with metadata
      const payload = {
        text: caption.trim(),
        source: targetSource,
        folderId: targetFolderId,
      };
      const enc = await encryptText(key, JSON.stringify(payload));

      const { error: dbErr } = await supabase.from("gallery_images").insert({
        user_id: user.id,
        storage_path: path,
        caption: enc.ct,
        iv,
        caption_iv: enc.iv,
        mime: file.type,
      });
      if (dbErr) throw dbErr;

      clearCaptionDraft();
      toast.success(
        targetSource === "notes"
          ? "Photo added to Notes gallery"
          : "Photo added to Diary gallery",
      );
      qc.invalidateQueries({ queryKey: ["gallery"] });
      qc.invalidateQueries({ queryKey: ["dashboard-counts"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const remove = useMutation({
    mutationFn: async (img: DecodedItem) => {
      await Promise.all([
        supabase.storage.from(img.bucket).remove([img.storage_path]),
        supabase
          .from("diary_entries")
          .update({ image_path: null } as never)
          .eq("user_id", user.id)
          .eq("image_path", img.storage_path),
        supabase
          .from("notes")
          .update({ image_url: null } as never)
          .eq("user_id", user.id)
          .eq("image_url", img.storage_path),
      ]);
      if (!img.id.startsWith("note-")) {
        const { error } = await supabase.from("gallery_images").delete().eq("id", img.id);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      setLightboxItem(null);
      toast.success("Photo removed");
      qc.invalidateQueries({ queryKey: ["gallery"] });
      qc.invalidateQueries({ queryKey: ["diary"] });
      qc.invalidateQueries({ queryKey: ["notes"] });
      qc.invalidateQueries({ queryKey: ["dashboard-counts"] });
    },
  });

  const updateCaption = useMutation({
    mutationFn: async ({ item, newCaption }: { item: DecodedItem; newCaption: string }) => {
      if (!key) throw new Error("Vault is locked");
      const payload = {
        text: newCaption.trim(),
        source: item.source,
        folderId: item.noteFolderId,
      };
      const enc = await encryptText(key, JSON.stringify(payload));

      if (item.id.startsWith("note-")) {
        // Insert as new gallery image row if previously only on note
        const { error } = await supabase.from("gallery_images").insert({
          user_id: user.id,
          storage_path: item.storage_path,
          caption: enc.ct,
          caption_iv: enc.iv,
          iv: item.iv,
          mime: item.mime,
        });
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("gallery_images")
          .update({
            caption: enc.ct,
            caption_iv: enc.iv,
          })
          .eq("id", item.id);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      setEditingId(null);
      toast.success("Caption updated");
      qc.invalidateQueries({ queryKey: ["gallery"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <p className="font-hand text-2xl text-sepia">moments worth keeping</p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-serif text-4xl text-primary">Gallery</h1>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3.5 text-accent" />
            <span>End-to-end encrypted with your vault key</span>
          </div>
        </div>
      </div>

      {/* Main Folder Tabs */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 pb-3">
        <button
          onClick={() => {
            setActiveTab("all");
            setSelectedNoteFolderId(null);
          }}
          className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
            activeTab === "all"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground"
          }`}
        >
          <Layers className="size-4" />
          <span>All Photos</span>
          <span className="ml-1 rounded-full bg-background/20 px-1.5 py-0.5 text-xs">
            {allItems.length}
          </span>
        </button>

        <button
          onClick={() => {
            setActiveTab("diary");
            setSelectedNoteFolderId(null);
          }}
          className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
            activeTab === "diary"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground"
          }`}
        >
          <BookMarked className="size-4" />
          <span>Diary</span>
          <span className="ml-1 rounded-full bg-background/20 px-1.5 py-0.5 text-xs">
            {diaryItems.length}
          </span>
        </button>

        <button
          onClick={() => {
            setActiveTab("notes");
            setSelectedNoteFolderId(null);
          }}
          className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
            activeTab === "notes"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground"
          }`}
        >
          <StickyNote className="size-4" />
          <span>Notes Folders</span>
          <span className="ml-1 rounded-full bg-background/20 px-1.5 py-0.5 text-xs">
            {noteItems.length}
          </span>
        </button>
      </div>

      {/* Notes Subfolder Navigation (Hierarchical directories & subfolders matching Notes) */}
      {activeTab === "notes" && (
        <div className="space-y-4 rounded-xl border border-border/60 bg-card/60 p-4 backdrop-blur">
          {/* Breadcrumbs for Notes navigation */}
          <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            <button
              onClick={() => setSelectedNoteFolderId(null)}
              className={`flex items-center gap-1 rounded-md px-2 py-1 transition hover:bg-secondary ${
                !selectedNoteFolderId ? "font-semibold text-primary" : ""
              }`}
            >
              <StickyNote className="size-3.5" />
              <span>Notes Root</span>
            </button>

            {breadcrumbPath.map((bc, idx) => {
              const isLast = idx === breadcrumbPath.length - 1;
              return (
                <div key={bc.id} className="flex items-center gap-1.5">
                  <ChevronRight className="size-3.5 opacity-60" />
                  <button
                    onClick={() => setSelectedNoteFolderId(bc.id)}
                    className={`rounded-md px-2 py-1 transition hover:bg-secondary ${
                      isLast ? "font-semibold text-primary" : ""
                    }`}
                  >
                    {bc.name}
                  </button>
                </div>
              );
            })}

            {selectedNoteFolderId && (
              <button
                onClick={() => {
                  const parentId = noteFolders.find((f) => f.id === selectedNoteFolderId)?.parent_id ?? null;
                  setSelectedNoteFolderId(parentId);
                }}
                className="ml-auto flex items-center gap-1 rounded-md px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              >
                <ArrowLeft className="size-3" /> Up one level
              </button>
            )}
          </div>

          {/* Directory & Subfolder Grid */}
          {currentLevelNoteFolders.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {selectedNoteFolderId ? "Subfolders" : "Notes Directories"}
              </p>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {currentLevelNoteFolders.map((f) => {
                  const count = getNoteFolderPhotoCount(f.id);
                  return (
                    <button
                      key={f.id}
                      onClick={() => setSelectedNoteFolderId(f.id)}
                      className="group flex flex-col items-start justify-between rounded-lg border border-border/70 bg-secondary/40 p-3 text-left transition hover:border-accent hover:bg-secondary hover:shadow-sm"
                    >
                      <div className="flex w-full items-center justify-between gap-1 text-primary">
                        <FolderIcon className="size-5 text-accent transition group-hover:scale-110" />
                        <span className="rounded-full bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {count}
                        </span>
                      </div>
                      <span className="mt-2 line-clamp-1 w-full text-xs font-medium text-foreground">
                        {f.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Diary Info Header (No Subfolders rule enforced) */}
      {activeTab === "diary" && (
        <div className="flex items-center justify-between rounded-xl border border-border/60 bg-card/60 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <BookMarked className="size-5 text-accent" />
            <div>
              <h3 className="font-serif text-lg text-primary">Diary Photos</h3>
              <p className="text-xs text-muted-foreground">
                All photos captured and attached to your private diary entries.
              </p>
            </div>
          </div>
          <span className="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-muted-foreground">
            {diaryItems.length} photos
          </span>
        </div>
      )}

      {/* Upload Box */}
      <div className="paper-card p-6">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Caption (optional) — encrypted with your vault key"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />

          {/* Destination folder indicator/selector when uploading */}
          {activeTab === "notes" && folderOptionsList.length > 0 && (
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs text-muted-foreground">Save into:</span>
              <select
                value={uploadTargetFolder ?? ""}
                onChange={(e) => setUploadTargetFolder(e.target.value || null)}
                className="rounded-md border border-border bg-card px-2.5 py-1 text-xs text-primary outline-none"
              >
                <option value="">Unfiled Notes Root</option>
                {folderOptionsList.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border/80 bg-secondary/30 px-6 py-9 transition hover:border-accent hover:bg-secondary/60">
          <Upload className="size-5 text-accent" />
          <span className="text-sm font-medium">
            {uploading
              ? "Encrypting & uploading..."
              : activeTab === "diary"
              ? "Upload photo to Diary"
              : activeTab === "notes"
              ? "Upload photo to Notes"
              : "Upload a photo"}
          </span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
              e.currentTarget.value = "";
            }}
          />
        </label>
      </div>

      {/* Photos Grid */}
      <div>
        <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Showing {visibleItems.length} {visibleItems.length === 1 ? "photo" : "photos"}
          </span>
        </div>

        {galleryQuery.isLoading && (
          <div className="py-12 text-center font-hand text-xl text-sepia animate-pulse">
            Developing your encrypted photos...
          </div>
        )}

        {!galleryQuery.isLoading && visibleItems.length === 0 && (
          <div className="rounded-xl border border-dashed border-border/80 p-12 text-center">
            <FileImage className="mx-auto size-10 text-muted-foreground/40" />
            <p className="mt-3 text-sm font-medium text-foreground">No photos in this section</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {activeTab === "diary"
                ? "Photos you attach to diary entries will appear here."
                : activeTab === "notes"
                ? "Photos attached to notes in this folder will appear here."
                : "Photos you upload or attach in Diary and Notes will appear here."}
            </p>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {visibleItems.map((img) => {
            const isEditing = editingId === img.id;
            const folderName = img.noteFolderId
              ? noteFolders.find((f) => f.id === img.noteFolderId)?.name
              : null;

            return (
              <div
                key={img.id}
                className="paper-card group relative flex flex-col overflow-hidden transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
              >
                {/* Image Container */}
                <div
                  onClick={() => setLightboxItem(img)}
                  className="relative aspect-square cursor-pointer overflow-hidden bg-muted"
                >
                  <DecryptedGalleryPhoto
                    bucket={img.bucket}
                    storagePath={img.storage_path}
                    signedUrl={img.signedUrl}
                    iv={img.iv}
                    mime={img.mime}
                    alt={img.caption || ""}
                    cryptoKey={key}
                  />

                  {/* Hover Lightbox Badge */}
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition group-hover:opacity-100">
                    <span className="flex items-center gap-1 rounded-full bg-background/90 px-2.5 py-1 text-xs font-medium text-foreground shadow">
                      <Maximize2 className="size-3" /> View
                    </span>
                  </div>

                  {/* Source Badge */}
                  <div className="absolute top-2 left-2 flex items-center gap-1 rounded-md bg-card/90 px-2 py-0.5 text-[10px] font-medium text-muted-foreground shadow-sm backdrop-blur">
                    {img.source === "diary" ? (
                      <>
                        <BookMarked className="size-3 text-sepia" />
                        <span>Diary</span>
                      </>
                    ) : (
                      <>
                        <StickyNote className="size-3 text-accent" />
                        <span>{folderName ? `Notes / ${folderName}` : "Notes"}</span>
                      </>
                    )}
                  </div>
                </div>

                {/* Caption & Actions */}
                <div className="flex flex-1 flex-col justify-between p-3">
                  {isEditing ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        autoFocus
                        value={draftCaption}
                        onChange={(e) => setDraftCaption(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            updateCaption.mutate({ item: img, newCaption: draftCaption });
                          }
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        className="w-full bg-transparent text-sm font-medium text-primary outline-none"
                        placeholder="caption..."
                      />
                      <button
                        onClick={() =>
                          updateCaption.mutate({ item: img, newCaption: draftCaption })
                        }
                        className="text-accent hover:text-primary"
                        title="Save caption"
                      >
                        <Check className="size-4" />
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="text-muted-foreground hover:text-foreground"
                        title="Cancel"
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-2">
                      <p className="line-clamp-2 font-hand text-base text-sepia">
                        {img.caption || img.originTitle || "untitled moment"}
                      </p>
                      <div className="flex shrink-0 items-center gap-1 opacity-70 group-hover:opacity-100">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingId(img.id);
                            setDraftCaption(img.caption || "");
                          }}
                          className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-primary"
                          title="Edit caption"
                        >
                          <Pencil className="size-3.5" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            remove.mutate(img);
                          }}
                          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          title="Delete photo"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="mt-2 text-[10px] text-muted-foreground/70">
                    {new Date(img.created_at).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Lightbox Modal */}
      {lightboxItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
          onClick={() => setLightboxItem(null)}
        >
          <div
            className="relative flex max-h-[92vh] max-w-4xl flex-col overflow-hidden rounded-2xl bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative flex max-h-[75vh] items-center justify-center overflow-hidden bg-black/90">
              <DecryptedGalleryPhoto
                bucket={lightboxItem.bucket}
                storagePath={lightboxItem.storage_path}
                signedUrl={lightboxItem.signedUrl}
                iv={lightboxItem.iv}
                mime={lightboxItem.mime}
                alt={lightboxItem.caption || ""}
                cryptoKey={key}
                fullscreen
              />
            </div>

            <div className="flex items-center justify-between p-4">
              <div>
                <p className="font-hand text-xl text-sepia">
                  {lightboxItem.caption || lightboxItem.originTitle || "Untitled moment"}
                </p>
                <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="capitalize">Source: {lightboxItem.source}</span>
                  <span>•</span>
                  <span>
                    {new Date(lightboxItem.created_at).toLocaleDateString("en-US", {
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => remove.mutate(lightboxItem)}
                  className="flex items-center gap-1 rounded-md px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="size-3.5" /> Delete
                </button>
                <button
                  onClick={() => setLightboxItem(null)}
                  className="rounded-full bg-secondary p-1.5 text-muted-foreground hover:bg-secondary/80 hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const DecryptedGalleryPhoto = memo(function DecryptedGalleryPhoto({
  bucket,
  storagePath,
  signedUrl,
  iv,
  mime,
  alt,
  cryptoKey,
  fullscreen,
}: {
  bucket: "gallery" | "media";
  storagePath: string;
  signedUrl: string;
  iv: string | null;
  mime: string | null;
  alt: string;
  cryptoKey: CryptoKey | null;
  fullscreen?: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        if (!iv) {
          const url = await fetchStorageUrlWithOfflineCache(bucket, storagePath, signedUrl);
          if (!cancelled && url) setSrc(url);
          return;
        }
        if (!cryptoKey) return;
        const ct = await fetchStorageBytesWithOfflineCache(bucket, storagePath, signedUrl);
        if (!ct || cancelled) return;
        const pt = await decryptBytes(cryptoKey, ct, iv);
        objectUrl = URL.createObjectURL(new Blob([pt], { type: mime || "image/jpeg" }));
        if (!cancelled) setSrc(objectUrl);
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [bucket, storagePath, signedUrl, iv, mime, cryptoKey]);

  if (!src) return <div className="size-full animate-pulse bg-secondary/50" />;
  return (
    <img
      src={src}
      alt={alt}
      className={
        fullscreen
          ? "max-h-[75vh] w-auto object-contain"
          : "size-full object-cover transition group-hover:scale-105"
      }
      loading="lazy"
      decoding="async"
    />
  );
});
