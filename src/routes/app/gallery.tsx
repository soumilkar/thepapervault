import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
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
  FolderPlus,
  ChevronRight,
  BookMarked,
  StickyNote,
  Layers,
  ArrowLeft,
  FileImage,
  Maximize2,
  Plus,
  Image as ImageIcon,
} from "lucide-react";
import { useVault } from "@/lib/vault";
import { decryptBytes, decryptField, decryptText, encryptBlob, encryptText } from "@/lib/crypto";
import { useBrowserDraft } from "@/lib/browser-drafts";
import { folderOptions, folderWithDescendants, type FolderRow } from "@/lib/folders";
import {
  fetchStorageBytesWithOfflineCache,
  fetchStorageUrlWithOfflineCache,
  getStorageBlobRecord,
  peekDecryptedMediaUrl,
  setDecryptedMediaUrl,
} from "@/lib/offline-supabase";
import { useGalleryFolders, type GalleryFolder } from "@/lib/gallery-folders";
import { getBrowserNow } from "@/lib/browser-time";

export const Route = createFileRoute("/app/gallery")({
  head: () => ({
    meta: [
      { title: "Gallery · The PaperVault" },
      {
        name: "description",
        content:
          "Private, end-to-end encrypted gallery with folders for Gallery, Notes, and Diary.",
      },
    ],
  }),
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
  source: "gallery" | "diary" | "notes";
  galleryFolderId: string | null;
  noteFolderId: string | null;
  originTitle?: string | null;
};

type GalleryTab = "gallery" | "notes" | "diary" | "all";

function GalleryPage() {
  const { user } = Route.useRouteContext();
  const { key } = useVault();
  const qc = useQueryClient();

  // Primary navigation: Default to "all" folder tab (first on the left)
  const [activeTab, setActiveTab] = useState<GalleryTab>("all");

  // Subfolder navigation for Notes and Gallery
  const [selectedNoteFolderId, setSelectedNoteFolderId] = useState<string | null>(null);
  const [selectedGalleryFolderId, setSelectedGalleryFolderId] = useState<string | null>(null);

  // Gallery custom folder creation state
  const {
    folders: galleryFolders,
    createFolder: createGalleryFolder,
    deleteFolder: deleteGalleryFolder,
    renameFolder: renameGalleryFolder,
  } = useGalleryFolders(user.id);
  const [isAddingGalleryFolder, setIsAddingGalleryFolder] = useState(false);
  const [newGalleryFolderName, setNewGalleryFolderName] = useState("");
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const [caption, setCaption, clearCaptionDraft] = useBrowserDraft(
    `papervault:gallery-caption:${user.id}`,
    "",
  );
  const [uploading, setUploading] = useState(false);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftCaption, setDraftCaption] = useState("");
  const [lightboxItem, setLightboxItem] = useState<DecodedItem | null>(null);

  useEffect(() => {
    if (!pendingFile) {
      setPendingPreview(null);
      return;
    }
    const url = URL.createObjectURL(pendingFile);
    setPendingPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingFile]);

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

  const noteFolders = useMemo(() => noteFoldersQuery.data ?? [], [noteFoldersQuery.data]);
  const noteFolderOptionsList = useMemo(() => folderOptions(noteFolders), [noteFolders]);

  // Gallery folder options for upload destination
  const galleryFolderRows: FolderRow[] = useMemo(
    () =>
      galleryFolders.map((gf) => ({
        id: gf.id,
        name: gf.name,
        parent_id: gf.parent_id,
      })),
    [galleryFolders],
  );
  const galleryFolderOptionsList = useMemo(
    () => folderOptions(galleryFolderRows),
    [galleryFolderRows],
  );

  // Destination folder selector for uploads
  const [uploadTargetFolder, setUploadTargetFolder] = useState<string | null>(null);

  // Sync uploadTargetFolder with active folder navigation
  useEffect(() => {
    if (activeTab === "gallery") {
      setUploadTargetFolder(selectedGalleryFolderId);
    } else if (activeTab === "notes") {
      setUploadTargetFolder(selectedNoteFolderId);
    } else {
      setUploadTargetFolder(null);
    }
  }, [activeTab, selectedGalleryFolderId, selectedNoteFolderId]);

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
          .select("id,image_path,title,content,iv,created_at" as never)
          .eq("user_id", user.id)
          .not("image_path", "is", null),
        supabase
          .from("notes")
          .select("id,content,image_url,folder_id,created_at,iv" as never)
          .eq("user_id", user.id)
          .not("image_url", "is", null),
      ]);

      if (galleryRes.error) throw galleryRes.error;

      // Map diary entries and decrypt their titles
      const diaryMap = new Map<string, { id: string; title: string | null }>();
      for (const d of (diaryRes.data ?? []) as {
        id: string;
        image_path: string | null;
        title: string | null;
        content: string;
        iv: string | null;
      }[]) {
        if (!d.image_path) continue;
        let plainTitle = d.title;
        if (!plainTitle && d.iv && d.content && key) {
          try {
            const dec = await decryptText(key, d.content, d.iv);
            const parsed = JSON.parse(dec) as { t?: string };
            plainTitle = parsed.t || null;
          } catch {
            // ignore
          }
        }
        diaryMap.set(d.image_path, { id: d.id, title: plainTitle });
      }

      // Map notes and extract their actual image IV (ii), MIME (im), and title (t)
      const notesMap = new Map<
        string,
        {
          id: string;
          folder_id: string | null;
          title: string;
          imageIv: string | null;
          imageMime: string | null;
        }
      >();
      for (const n of (notesRes.data ?? []) as {
        id: string;
        content: string;
        image_url: string | null;
        folder_id: string | null;
        created_at: string;
        iv: string | null;
      }[]) {
        if (!n.image_url) continue;
        let noteTitle = "";
        let noteImageIv: string | null = null;
        let noteImageMime: string | null = null;

        if (n.iv && n.content && key) {
          try {
            const dec = await decryptText(key, n.content, n.iv);
            const parsed = JSON.parse(dec) as { t?: string; ii?: string; im?: string };
            noteTitle = parsed.t || "";
            noteImageIv = parsed.ii || null;
            noteImageMime = parsed.im || null;
          } catch {
            // ignore
          }
        }

        notesMap.set(n.image_url, {
          id: n.id,
          folder_id: n.folder_id,
          title: noteTitle,
          imageIv: noteImageIv,
          imageMime: noteImageMime,
        });
      }

      const rawRows = (galleryRes.data ?? []) as unknown as ImageRowRaw[];
      const seenPaths = new Set(rawRows.map((r) => r.storage_path));

      // Build list from gallery_images rows with precise bucket and source detection
      const combinedItems: {
        id: string;
        storage_path: string;
        bucket: "gallery" | "media";
        captionRaw: string | null;
        captionIv: string | null;
        created_at: string;
        iv: string | null;
        mime: string | null;
        source: "gallery" | "diary" | "notes";
        galleryFolderId: string | null;
        noteFolderId: string | null;
        originTitle?: string | null;
      }[] = rawRows.map((r) => {
        let source: "gallery" | "diary" | "notes" = "gallery";
        let noteFolderId: string | null = null;
        const galleryFolderId: string | null = null;
        let originTitle: string | null = null;
        let bucket: "gallery" | "media" = "gallery";
        let itemIv = r.iv;
        let itemMime = r.mime;

        if (notesMap.has(r.storage_path)) {
          source = "notes";
          bucket = "media"; // Note images are stored in "media" bucket
          const nInfo = notesMap.get(r.storage_path);
          noteFolderId = nInfo?.folder_id ?? null;
          originTitle = nInfo?.title || "Note Photo";
          if (!itemIv && nInfo?.imageIv) itemIv = nInfo.imageIv;
          if (!itemMime && nInfo?.imageMime) itemMime = nInfo.imageMime;
        } else if (diaryMap.has(r.storage_path)) {
          source = "diary";
          bucket = "gallery";
          originTitle = diaryMap.get(r.storage_path)?.title ?? "Diary Photo";
        }

        return {
          id: r.id,
          storage_path: r.storage_path,
          bucket,
          captionRaw: r.caption,
          captionIv: r.caption_iv,
          created_at: r.created_at,
          iv: itemIv,
          mime: itemMime,
          source,
          galleryFolderId,
          noteFolderId,
          originTitle,
        };
      });

      // Include standalone note images not present in gallery_images table
      for (const n of (notesRes.data ?? []) as {
        id: string;
        image_url: string | null;
        folder_id: string | null;
        created_at: string;
      }[]) {
        if (n.image_url && !seenPaths.has(n.image_url)) {
          const nInfo = notesMap.get(n.image_url);
          combinedItems.push({
            id: `note-${n.id}`,
            storage_path: n.image_url,
            bucket: "media",
            captionRaw: null,
            captionIv: null,
            created_at: n.created_at,
            iv: nInfo?.imageIv ?? null, // Use actual decrypted note image IV (not note.iv!)
            mime: nInfo?.imageMime ?? "image/jpeg",
            source: "notes",
            galleryFolderId: null,
            noteFolderId: n.folder_id,
            originTitle: nInfo?.title || "Note Photo",
          });
          seenPaths.add(n.image_url);
        }
      }

      // Include standalone diary images not in gallery_images table
      for (const d of (diaryRes.data ?? []) as {
        id: string;
        image_path: string | null;
        created_at: string;
      }[]) {
        if (d.image_path && !seenPaths.has(d.image_path)) {
          const dInfo = diaryMap.get(d.image_path);
          combinedItems.push({
            id: `diary-${d.id}`,
            storage_path: d.image_path,
            bucket: "gallery",
            captionRaw: null,
            captionIv: null,
            created_at: d.created_at,
            iv: null,
            mime: "image/jpeg",
            source: "diary",
            galleryFolderId: null,
            noteFolderId: null,
            originTitle: dInfo?.title || "Diary Photo",
          });
          seenPaths.add(d.image_path);
        }
      }

      if (!combinedItems.length) return [];

      // Warm batch signed URLs in the background without blocking Gallery render
      const galleryPaths = combinedItems
        .filter((i) => i.bucket === "gallery")
        .map((i) => i.storage_path);
      const mediaPaths = combinedItems
        .filter((i) => i.bucket === "media")
        .map((i) => i.storage_path);

      if (galleryPaths.length > 0) {
        void supabase.storage.from("gallery").createSignedUrls(galleryPaths, 60 * 60);
      }
      if (mediaPaths.length > 0) {
        void supabase.storage.from("media").createSignedUrls(mediaPaths, 60 * 60);
      }

      return Promise.all(
        combinedItems.map(async (img) => {
          let captionPlain = img.captionRaw ?? "";
          let itemSource = img.source;
          let itemNoteFolderId = img.noteFolderId;
          let itemGalleryFolderId = img.galleryFolderId;

          if (img.captionRaw && img.captionIv && key) {
            try {
              const decrypted = await decryptText(key, img.captionRaw, img.captionIv);
              if (decrypted.startsWith("{") && decrypted.endsWith("}")) {
                try {
                  const parsed = JSON.parse(decrypted) as {
                    text?: string;
                    source?: "gallery" | "diary" | "notes";
                    folderId?: string | null;
                  };
                  captionPlain = parsed.text || "";
                  if (parsed.source) itemSource = parsed.source;
                  if (parsed.folderId !== undefined) {
                    if (itemSource === "gallery") itemGalleryFolderId = parsed.folderId;
                    if (itemSource === "notes") itemNoteFolderId = parsed.folderId;
                  }
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
            signedUrl: "",
            iv: img.iv,
            mime: img.mime,
            source: itemSource,
            galleryFolderId: itemGalleryFolderId,
            noteFolderId: itemNoteFolderId,
            originTitle: img.originTitle,
          };
        }),
      );
    },
  });

  const allItems = useMemo(() => galleryQuery.data ?? [], [galleryQuery.data]);

  // Categorized photo lists
  const galleryItems = useMemo(() => allItems.filter((i) => i.source === "gallery"), [allItems]);
  const diaryItems = useMemo(() => allItems.filter((i) => i.source === "diary"), [allItems]);
  const noteItems = useMemo(() => allItems.filter((i) => i.source === "notes"), [allItems]);

  // Helper: Count photos in any Note folder (including all descendant subfolders)
  const getNoteFolderPhotoCount = useCallback(
    (folderId: string) => {
      const ids = folderWithDescendants(noteFolders, folderId);
      return noteItems.filter((i) => i.noteFolderId && ids.has(i.noteFolderId)).length;
    },
    [noteFolders, noteItems],
  );

  // Helper: Count photos in any Gallery custom folder (including all descendant subfolders)
  const getGalleryFolderPhotoCount = useCallback(
    (folderId: string) => {
      const ids = folderWithDescendants(galleryFolderRows, folderId);
      return galleryItems.filter((i) => i.galleryFolderId && ids.has(i.galleryFolderId)).length;
    },
    [galleryFolderRows, galleryItems],
  );

  // 1. NOTES: List only Note directories that have photos in them!
  const currentLevelNoteFolders = useMemo(() => {
    if (activeTab !== "notes") return [];
    const directFolders = !selectedNoteFolderId
      ? noteFolders.filter((f) => f.parent_id === null)
      : noteFolders.filter((f) => f.parent_id === selectedNoteFolderId);

    // CRITICAL: Filter out directories that have 0 photos!
    return directFolders.filter((f) => getNoteFolderPhotoCount(f.id) > 0);
  }, [activeTab, selectedNoteFolderId, noteFolders, getNoteFolderPhotoCount]);

  // Notes breadcrumb path
  const noteBreadcrumbPath = useMemo(() => {
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

  // 2. GALLERY: Subfolders under currently selected Gallery folder
  const currentLevelGalleryFolders = useMemo(() => {
    if (activeTab !== "gallery") return [];
    if (!selectedGalleryFolderId) {
      return galleryFolders.filter((f) => f.parent_id === null);
    }
    return galleryFolders.filter((f) => f.parent_id === selectedGalleryFolderId);
  }, [activeTab, selectedGalleryFolderId, galleryFolders]);

  // Gallery breadcrumb path
  const galleryBreadcrumbPath = useMemo(() => {
    if (!selectedGalleryFolderId) return [];
    const path: { id: string; name: string }[] = [];
    let currentId: string | null = selectedGalleryFolderId;
    let depth = 0;
    while (currentId && depth < 10) {
      depth++;
      const f = galleryFolders.find((x) => x.id === currentId);
      if (f) {
        path.unshift({ id: f.id, name: f.name });
        currentId = f.parent_id;
      } else {
        break;
      }
    }
    return path;
  }, [selectedGalleryFolderId, galleryFolders]);

  // Filtered photos for the active view
  const visibleItems = useMemo(() => {
    if (activeTab === "gallery") {
      if (!selectedGalleryFolderId) {
        // At root: show unfiled gallery photos and all gallery photos
        return galleryItems;
      }
      const folderIds = folderWithDescendants(galleryFolderRows, selectedGalleryFolderId);
      return galleryItems.filter((i) => i.galleryFolderId && folderIds.has(i.galleryFolderId));
    }

    if (activeTab === "notes") {
      if (!selectedNoteFolderId) {
        return noteItems;
      }
      const folderIds = folderWithDescendants(noteFolders, selectedNoteFolderId);
      return noteItems.filter((i) => i.noteFolderId && folderIds.has(i.noteFolderId));
    }

    if (activeTab === "diary") {
      return diaryItems; // Flat stream, no subfolders
    }

    return allItems;
  }, [
    activeTab,
    selectedGalleryFolderId,
    selectedNoteFolderId,
    galleryItems,
    noteItems,
    diaryItems,
    allItems,
    galleryFolderRows,
    noteFolders,
  ]);

  // Upload handler: Photos uploaded from Gallery go into the Gallery folder (or selected subfolder)
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

      // Determine target bucket and source
      let targetSource: "gallery" | "notes" | "diary" = "gallery";
      let targetBucket: "gallery" | "media" = "gallery";
      let targetFolderId: string | null = null;

      if (activeTab === "notes") {
        targetSource = "notes";
        targetBucket = "media";
        targetFolderId = uploadTargetFolder || selectedNoteFolderId;
      } else if (activeTab === "diary") {
        targetSource = "diary";
        targetBucket = "gallery";
        targetFolderId = null;
      } else {
        // Default "gallery" tab
        targetSource = "gallery";
        targetBucket = "gallery";
        targetFolderId = uploadTargetFolder || selectedGalleryFolderId;
      }

      // Upload to appropriate Supabase storage bucket
      const { error: upErr } = await supabase.storage
        .from(targetBucket)
        .upload(path, blob, { contentType: "application/octet-stream" });
      if (upErr) throw upErr;

      // Encrypt caption and metadata
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
        created_at: getBrowserNow().iso,
      });
      if (dbErr) throw dbErr;

      clearCaptionDraft();
      setPendingFile(null);
      setUploadMenuOpen(false);
      toast.success(
        targetSource === "gallery"
          ? "Photo uploaded to Gallery"
          : targetSource === "notes"
            ? "Photo saved to Notes directory"
            : "Photo saved to Diary",
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
      if (!img.id.startsWith("note-") && !img.id.startsWith("diary-")) {
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
        folderId: item.source === "gallery" ? item.galleryFolderId : item.noteFolderId,
      };
      const enc = await encryptText(key, JSON.stringify(payload));

      if (item.id.startsWith("note-") || item.id.startsWith("diary-")) {
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

  // Handle creating a new Gallery folder or subfolder
  const handleCreateGalleryFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = newGalleryFolderName.trim();
    if (!clean) return;
    try {
      await createGalleryFolder(clean, selectedGalleryFolderId);
      setNewGalleryFolderName("");
      setIsAddingGalleryFolder(false);
      toast.success("Folder created");
    } catch {
      toast.error("Failed to create folder");
    }
  };

  const activeGalleryFolderName = useMemo(() => {
    if (!selectedGalleryFolderId) return null;
    return galleryFolders.find((f) => f.id === selectedGalleryFolderId)?.name ?? null;
  }, [selectedGalleryFolderId, galleryFolders]);

  const activeNoteFolderName = useMemo(() => {
    if (!selectedNoteFolderId) return null;
    return noteFolders.find((f) => f.id === selectedNoteFolderId)?.name ?? null;
  }, [selectedNoteFolderId, noteFolders]);

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

      {/* Main Folder Tabs: All Photos, Gallery, Notes, and Diary */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 pb-3">
        {/* 1. All Photos */}
        <button
          onClick={() => {
            setActiveTab("all");
            setSelectedNoteFolderId(null);
            setSelectedGalleryFolderId(null);
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

        {/* 2. Gallery folder tab */}
        <button
          onClick={() => {
            setActiveTab("gallery");
            setSelectedGalleryFolderId(null);
            setSelectedNoteFolderId(null);
          }}
          className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
            activeTab === "gallery"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground"
          }`}
        >
          <ImageIcon className="size-4" />
          <span>Gallery</span>
          <span className="ml-1 rounded-full bg-background/20 px-1.5 py-0.5 text-xs">
            {galleryItems.length}
          </span>
        </button>

        {/* 3. Notes folder tab */}
        <button
          onClick={() => {
            setActiveTab("notes");
            setSelectedNoteFolderId(null);
            setSelectedGalleryFolderId(null);
          }}
          className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
            activeTab === "notes"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground"
          }`}
        >
          <StickyNote className="size-4" />
          <span>Notes</span>
          <span className="ml-1 rounded-full bg-background/20 px-1.5 py-0.5 text-xs">
            {noteItems.length}
          </span>
        </button>

        {/* 4. Diary folder tab (No Subfolders) */}
        <button
          onClick={() => {
            setActiveTab("diary");
            setSelectedNoteFolderId(null);
            setSelectedGalleryFolderId(null);
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

        {/* Minimal Plus Button & Popout Upload Menu */}
        <div className="relative ml-auto">
          <button
            type="button"
            onClick={() => setUploadMenuOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:opacity-90"
            title="Add photo"
          >
            <Plus className="size-4" />
            <span className="hidden sm:inline">Add Photo</span>
          </button>

          {uploadMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-30"
                onClick={() => !uploading && setUploadMenuOpen(false)}
              />
              <div className="absolute right-0 top-full z-40 mt-2 w-80 rounded-xl border border-border bg-card p-4 shadow-xl">
                <div className="mb-3 flex items-center justify-between">
                  <span className="font-serif text-base font-medium text-primary">
                    {activeTab === "notes"
                      ? activeNoteFolderName
                        ? `Add to "${activeNoteFolderName}"`
                        : "Add Photo to Notes"
                      : activeTab === "diary"
                        ? "Add Photo to Diary"
                        : activeGalleryFolderName
                          ? `Add to "${activeGalleryFolderName}"`
                          : "Add Photo to Gallery"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setUploadMenuOpen(false)}
                    className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                  >
                    <X className="size-4" />
                  </button>
                </div>

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (pendingFile) void upload(pendingFile);
                  }}
                  className="space-y-3"
                >
                  {/* Image Picker */}
                  <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-secondary/30 p-3 text-center transition hover:border-accent hover:bg-secondary/60">
                    {pendingPreview ? (
                      <div className="relative w-full">
                        <img
                          src={pendingPreview}
                          alt="Preview"
                          className="mx-auto max-h-36 rounded-md object-contain"
                        />
                        <p className="mt-1.5 truncate text-xs text-muted-foreground">
                          {pendingFile?.name}
                        </p>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 py-3 text-xs font-medium text-foreground">
                        <Upload className="size-4 text-accent" />
                        <span>Select image (JPEG, PNG, WebP, GIF)</span>
                      </div>
                    )}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      className="hidden"
                      disabled={uploading}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) setPendingFile(f);
                        e.currentTarget.value = "";
                      }}
                    />
                  </label>

                  {/* Caption Input */}
                  <input
                    value={caption}
                    onChange={(e) => setCaption(e.target.value)}
                    placeholder="Caption (optional)..."
                    className="w-full rounded-md border border-border bg-background/60 px-3 py-2 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-accent"
                  />

                  {/* Folder Destination Selector (if folders exist) */}
                  {(activeTab === "gallery" || activeTab === "all") &&
                    galleryFolderOptionsList.length > 0 && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">Folder:</span>
                        <select
                          value={uploadTargetFolder ?? ""}
                          onChange={(e) => setUploadTargetFolder(e.target.value || null)}
                          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-primary outline-none"
                        >
                          <option value="">Gallery Root</option>
                          {galleryFolderOptionsList.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                  {activeTab === "notes" && noteFolderOptionsList.length > 0 && (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">Folder:</span>
                      <select
                        value={uploadTargetFolder ?? ""}
                        onChange={(e) => setUploadTargetFolder(e.target.value || null)}
                        className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-primary outline-none"
                      >
                        <option value="">Notes Root</option>
                        {noteFolderOptionsList.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={!pendingFile || uploading}
                    className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
                  >
                    <Upload className="size-3.5" />
                    <span>{uploading ? "Encrypting & uploading..." : "Upload Photo"}</span>
                  </button>
                </form>
              </div>
            </>
          )}
        </div>
      </div>

      {/* GALLERY FOLDER: Custom Folders & Subfolders Management */}
      {activeTab === "gallery" && (
        <div className="space-y-4 rounded-xl border border-border/60 bg-card/60 p-4 backdrop-blur">
          {/* Breadcrumb Header & Action Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
              <button
                onClick={() => setSelectedGalleryFolderId(null)}
                className={`flex items-center gap-1 rounded-md px-2 py-1 transition hover:bg-secondary ${
                  !selectedGalleryFolderId ? "font-semibold text-primary" : ""
                }`}
              >
                <FolderOpen className="size-3.5 text-accent" />
                <span>Gallery Root</span>
              </button>

              {galleryBreadcrumbPath.map((bc, idx) => {
                const isLast = idx === galleryBreadcrumbPath.length - 1;
                return (
                  <div key={bc.id} className="flex items-center gap-1.5">
                    <ChevronRight className="size-3.5 opacity-60" />
                    <button
                      onClick={() => setSelectedGalleryFolderId(bc.id)}
                      className={`rounded-md px-2 py-1 transition hover:bg-secondary ${
                        isLast ? "font-semibold text-primary" : ""
                      }`}
                    >
                      {bc.name}
                    </button>
                  </div>
                );
              })}

              {selectedGalleryFolderId && (
                <button
                  onClick={() => {
                    const parentId =
                      galleryFolders.find((f) => f.id === selectedGalleryFolderId)?.parent_id ??
                      null;
                    setSelectedGalleryFolderId(parentId);
                  }}
                  className="ml-auto flex items-center gap-1 rounded-md px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                >
                  <ArrowLeft className="size-3" /> Up one level
                </button>
              )}
            </div>

            {/* Folder Actions */}
            <div className="flex items-center gap-2">
              {selectedGalleryFolderId && (
                <button
                  onClick={() => {
                    deleteGalleryFolder(selectedGalleryFolderId);
                    setSelectedGalleryFolderId(null);
                    toast.success("Folder deleted");
                  }}
                  className="flex items-center gap-1 rounded-md px-2.5 py-1 text-xs text-destructive transition hover:bg-destructive/10"
                  title="Delete current folder"
                >
                  <Trash2 className="size-3" /> Delete folder
                </button>
              )}
              <button
                onClick={() => setIsAddingGalleryFolder((v) => !v)}
                className="flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-secondary/80"
              >
                <FolderPlus className="size-3.5 text-accent" />
                <span>{selectedGalleryFolderId ? "Add Subfolder" : "New Folder"}</span>
              </button>
            </div>
          </div>

          {/* New Folder Form */}
          {isAddingGalleryFolder && (
            <form
              onSubmit={handleCreateGalleryFolder}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-secondary/30 p-2.5"
            >
              <input
                autoFocus
                value={newGalleryFolderName}
                onChange={(e) => setNewGalleryFolderName(e.target.value)}
                placeholder={
                  selectedGalleryFolderId
                    ? `Subfolder inside ${activeGalleryFolderName}...`
                    : "New folder name..."
                }
                className="min-w-[200px] flex-1 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-primary outline-none focus:border-accent"
              />
              <button
                type="submit"
                disabled={!newGalleryFolderName.trim()}
                className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsAddingGalleryFolder(false);
                  setNewGalleryFolderName("");
                }}
                className="rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-secondary"
              >
                Cancel
              </button>
            </form>
          )}

          {/* Subfolders Grid */}
          {currentLevelGalleryFolders.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {selectedGalleryFolderId ? "Subfolders" : "Folders"}
              </p>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {currentLevelGalleryFolders.map((f) => {
                  const count = getGalleryFolderPhotoCount(f.id);
                  const isRenaming = renamingFolderId === f.id;
                  return (
                    <div
                      key={f.id}
                      className="group relative flex flex-col justify-between rounded-lg border border-border/70 bg-secondary/40 p-3 text-left transition hover:border-accent hover:bg-secondary hover:shadow-sm"
                    >
                      <button
                        onClick={() => setSelectedGalleryFolderId(f.id)}
                        className="w-full text-left"
                      >
                        <div className="flex w-full items-center justify-between gap-1 text-primary">
                          <FolderIcon className="size-5 text-accent transition group-hover:scale-110" />
                          <span className="rounded-full bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {count}
                          </span>
                        </div>
                        {isRenaming ? (
                          <div
                            onClick={(e) => e.stopPropagation()}
                            className="mt-2 flex items-center gap-1"
                          >
                            <input
                              autoFocus
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              className="w-full rounded border border-border bg-card px-1.5 py-0.5 text-xs text-foreground outline-none"
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && renameValue.trim()) {
                                  renameGalleryFolder(f.id, renameValue.trim());
                                  setRenamingFolderId(null);
                                }
                                if (e.key === "Escape") setRenamingFolderId(null);
                              }}
                            />
                            <button
                              onClick={() => {
                                if (renameValue.trim()) {
                                  renameGalleryFolder(f.id, renameValue.trim());
                                  setRenamingFolderId(null);
                                }
                              }}
                              className="text-accent"
                            >
                              <Check className="size-3" />
                            </button>
                          </div>
                        ) : (
                          <span className="mt-2 block break-words [overflow-wrap:anywhere] text-xs font-medium text-foreground">
                            {f.name}
                          </span>
                        )}
                      </button>

                      {/* Quick rename/delete triggers */}
                      {!isRenaming && (
                        <div className="mt-1 flex items-center justify-end gap-1 opacity-0 transition group-hover:opacity-100">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenamingFolderId(f.id);
                              setRenameValue(f.name);
                            }}
                            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                            title="Rename"
                          >
                            <Pencil className="size-2.5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteGalleryFolder(f.id);
                              toast.success("Folder deleted");
                            }}
                            className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                            title="Delete"
                          >
                            <Trash2 className="size-2.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* NOTES DIRECTORIES: Only list directories that have photos in them */}
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
              <StickyNote className="size-3.5 text-accent" />
              <span>Notes Root</span>
            </button>

            {noteBreadcrumbPath.map((bc, idx) => {
              const isLast = idx === noteBreadcrumbPath.length - 1;
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
                  const parentId =
                    noteFolders.find((f) => f.id === selectedNoteFolderId)?.parent_id ?? null;
                  setSelectedNoteFolderId(parentId);
                }}
                className="ml-auto flex items-center gap-1 rounded-md px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              >
                <ArrowLeft className="size-3" /> Up one level
              </button>
            )}
          </div>

          {/* Directory & Subfolder Grid (Strictly showing folders with photo count > 0) */}
          {currentLevelNoteFolders.length > 0 ? (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {selectedNoteFolderId ? "Subfolders with photos" : "Notes Directories with photos"}
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
                      <span className="mt-2 w-full break-words [overflow-wrap:anywhere] text-xs font-medium text-foreground">
                        {f.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            !selectedNoteFolderId && (
              <p className="text-xs text-muted-foreground italic">
                Only Notes folders that contain photos are displayed here.
              </p>
            )
          )}
        </div>
      )}

      {/* DIARY HEADER (Strictly Flat: No Subfolders) */}
      {activeTab === "diary" && (
        <div className="flex items-center justify-between rounded-xl border border-border/60 bg-card/60 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <BookMarked className="size-5 text-sepia" />
            <div>
              <h3 className="font-serif text-lg text-primary">Diary Photos</h3>
              <p className="text-xs text-muted-foreground">
                All photos captured and attached to your private diary entries (flat stream).
              </p>
            </div>
          </div>
          <span className="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-muted-foreground">
            {diaryItems.length} photos
          </span>
        </div>
      )}

      {/* Photos Grid */}
      <div>
        <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Showing {visibleItems.length} {visibleItems.length === 1 ? "photo" : "photos"}
            {activeTab === "gallery" && activeGalleryFolderName
              ? ` in "${activeGalleryFolderName}"`
              : activeTab === "notes" && activeNoteFolderName
                ? ` in "${activeNoteFolderName}"`
                : ""}
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
              {activeTab === "gallery"
                ? "Upload photos directly here or create folders to organize them."
                : activeTab === "notes"
                  ? "Photos attached to notes in this folder will appear here."
                  : activeTab === "diary"
                    ? "Photos you attach to diary entries will appear here."
                    : "Photos from Gallery, Notes, and Diary will appear here."}
            </p>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {visibleItems.map((img) => {
            const isEditing = editingId === img.id;
            const folderName =
              img.source === "gallery"
                ? img.galleryFolderId
                  ? galleryFolders.find((f) => f.id === img.galleryFolderId)?.name
                  : null
                : img.noteFolderId
                  ? noteFolders.find((f) => f.id === img.noteFolderId)?.name
                  : null;

            return (
              <div
                key={img.id}
                className="paper-card group relative flex flex-col overflow-hidden transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
              >
                {/* Image Container with Fallback-Aware Decryption */}
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
                  <div className="absolute top-2 left-2 max-w-[calc(100%-1rem)] flex items-center gap-1 rounded-md bg-card/90 px-2 py-0.5 text-[10px] font-medium text-muted-foreground shadow-sm backdrop-blur">
                    {img.source === "gallery" ? (
                      <>
                        <ImageIcon className="size-3 shrink-0 text-primary" />
                        <span className="break-words [overflow-wrap:anywhere]">
                          {folderName ? `Gallery / ${folderName}` : "Gallery"}
                        </span>
                      </>
                    ) : img.source === "diary" ? (
                      <>
                        <BookMarked className="size-3 shrink-0 text-sepia" />
                        <span>Diary</span>
                      </>
                    ) : (
                      <>
                        <StickyNote className="size-3 shrink-0 text-accent" />
                        <span className="break-words [overflow-wrap:anywhere]">
                          {folderName ? `Notes / ${folderName}` : "Notes"}
                        </span>
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
                      <p className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere] font-hand text-base leading-snug text-sepia">
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

            <div className="flex items-start justify-between gap-4 p-4">
              <div className="min-w-0 flex-1">
                <p className="whitespace-normal break-words [overflow-wrap:anywhere] font-hand text-xl leading-snug text-sepia">
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

              <div className="flex shrink-0 items-center gap-2">
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

// Resilient Decrypted Image Renderer
// Tries primary bucket -> falls back to alternative bucket -> dynamically signs URL if missing
const DecryptedGalleryPhoto = memo(function DecryptedGalleryPhoto({
  bucket,
  storagePath,
  signedUrl: initialSignedUrl,
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
  const [src, setSrc] = useState<string | null>(() =>
    peekDecryptedMediaUrl(bucket, storagePath, iv),
  );

  useEffect(() => {
    const cachedUrl = peekDecryptedMediaUrl(bucket, storagePath, iv);
    if (cachedUrl) {
      setSrc(cachedUrl);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        // 1. Check local IndexedDB blob first before making any network signed-URL call
        const altBucket = bucket === "gallery" ? "media" : "gallery";
        let localRecord = await getStorageBlobRecord(bucket, storagePath);
        if (!localRecord?.buffer) {
          localRecord = await getStorageBlobRecord(altBucket, storagePath);
        }

        let bytes: ArrayBuffer | null = localRecord?.buffer ?? null;
        let currentSignedUrl = initialSignedUrl;

        // 2. Only request a signed URL and download if not yet cached in IndexedDB
        if (!bytes) {
          if (!currentSignedUrl) {
            try {
              const { data } = await supabase.storage
                .from(bucket)
                .createSignedUrl(storagePath, 3600);
              currentSignedUrl =
                data?.signedUrl || (data as { signedURL?: string })?.signedURL || "";
            } catch {
              // ignore
            }
          }
          if (currentSignedUrl) {
            bytes = await fetchStorageBytesWithOfflineCache(bucket, storagePath, currentSignedUrl);
          }
          if (!bytes) {
            try {
              const { data: altData } = await supabase.storage
                .from(altBucket)
                .createSignedUrl(storagePath, 3600);
              const altUrl =
                altData?.signedUrl || (altData as { signedURL?: string })?.signedURL || "";
              if (altUrl) {
                bytes = await fetchStorageBytesWithOfflineCache(altBucket, storagePath, altUrl);
              }
            } catch {
              // ignore
            }
          }
        }

        if (iv && bytes && cryptoKey && !cancelled) {
          try {
            const pt = await decryptBytes(cryptoKey, bytes, iv);
            const objectUrl = URL.createObjectURL(new Blob([pt], { type: mime || "image/jpeg" }));
            setDecryptedMediaUrl(bucket, storagePath, iv, objectUrl);
            if (!cancelled) setSrc(objectUrl);
            return;
          } catch {
            const objectUrl = URL.createObjectURL(
              new Blob([bytes], { type: mime || "image/jpeg" }),
            );
            setDecryptedMediaUrl(bucket, storagePath, iv, objectUrl);
            if (!cancelled) setSrc(objectUrl);
            return;
          }
        }

        // Plain / Unencrypted fallback
        if (!iv && !cancelled) {
          if (bytes) {
            const objectUrl = URL.createObjectURL(
              new Blob([bytes], { type: mime || "image/jpeg" }),
            );
            setDecryptedMediaUrl(bucket, storagePath, iv, objectUrl);
            if (!cancelled) setSrc(objectUrl);
            return;
          }
          const directUrl = await fetchStorageUrlWithOfflineCache(
            bucket,
            storagePath,
            currentSignedUrl,
          );
          if (!cancelled && directUrl) {
            setSrc(directUrl);
            return;
          }
        }
      } catch {
        // failed image load
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bucket, storagePath, initialSignedUrl, iv, mime, cryptoKey]);

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
