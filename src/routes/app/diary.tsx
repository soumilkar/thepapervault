import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  Trash2,
  X,
  Download,
  Pencil,
  Check,
  Globe,
  Lock,
  FolderPlus,
  Folder,
  Search,
  ScanText,
  Loader2,
} from "lucide-react";
import { RichText } from "@/components/RichText";
import { RichEditor } from "@/components/RichEditor";
import { folderOptions, folderWithDescendants, type FolderRow } from "@/lib/folders";
import { previewText } from "@/lib/rich-text";
import { downloadTextFile } from "@/lib/download";
import { useVault } from "@/lib/vault";
import {
  decryptBytes,
  decryptField,
  decryptText,
  encryptBlob,
  encryptField,
  encryptText,
} from "@/lib/crypto";
import { MusicSearch, MusicPlayer, type SelectedTrack } from "@/components/MusicSearch";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { AppSelect } from "@/components/AppSelect";
import { useBrowserDraft } from "@/lib/browser-drafts";
import { type DiaryMetricRow } from "@/lib/diary-metrics";
import { transcribeHandwritingFile } from "@/lib/handwriting-ocr";

const NONE = "__none__";

function countWords(s: string) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export const Route = createFileRoute("/app/diary")({
  component: DiaryPage,
});

type DiaryEncryptedPayload = {
  t?: string;
  c?: string;
  m?: string;
  wc?: number;
  mu?: SelectedTrack | null;
};

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
  created_at: string;
};

type Entry = {
  id: string;
  title: string;
  content: string;
  mood: string;
  entry_date: string;
  image_path: string | null;
  is_public: boolean;
  folder_id: string | null;
  music: SelectedTrack | null;
  created_at: string;
};

type Sort = "newest" | "oldest" | "title";

const NULL_MUSIC_COLUMNS = {
  music_track_id: null,
  music_track_name: null,
  music_artist: null,
  music_preview_url: null,
  music_artwork_url: null,
};

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
  const [draft, setDraft, clearDraft] = useBrowserDraft<DiaryDraft>(
    `papervault:diary-draft:${user.id}`,
    {
      title: "",
      content: "",
      mood: "",
      isPublic: false,
      folderId: null,
      music: null,
    },
  );
  const { title, content, mood, isPublic, folderId, music } = draft;
  const setTitle = (value: string) => setDraft((current) => ({ ...current, title: value }));
  const setContent = (value: string) => setDraft((current) => ({ ...current, content: value }));
  const setMood = (value: string) => setDraft((current) => ({ ...current, mood: value }));
  const setIsPublic = (value: boolean) => setDraft((current) => ({ ...current, isPublic: value }));
  const setFolderId = (value: string | null) =>
    setDraft((current) => ({ ...current, folderId: value }));
  const setMusic = (value: SelectedTrack | null) =>
    setDraft((current) => ({ ...current, music: value }));
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const [filterFolder, setFilterFolder] = useState<string | "all">("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [newFolder, setNewFolder] = useState("");
  const [newFolderParent, setNewFolderParent] = useState<string>(NONE);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!photo) {
      setPhotoPreview(null);
      return;
    }
    const url = URL.createObjectURL(photo);
    setPhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const folders = useQuery({
    enabled: !!key,
    queryKey: ["diary-folders", user.id],
    queryFn: async (): Promise<FolderRow[]> => {
      const { data, error } = await supabase
        .from("diary_folders")
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
              void supabase.from("diary_folders").update({ name: encName }).eq("id", f.id);
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

  const entries = useQuery({
    enabled: !!key,
    queryKey: ["diary", user.id],
    queryFn: async (): Promise<Entry[]> => {
      const { data, error } = await supabase
        .from("diary_entries")
        .select("*")
        .eq("user_id", user.id)
        .order("entry_date", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) throw error;
      const rows = (data ?? []) as unknown as DiaryRowRaw[];

      return Promise.all(
        rows.map(async (row) => {
          let t = row.title ?? "";
          let c = row.content;
          let m = row.mood ?? "";
          let mu: SelectedTrack | null = row.music_preview_url
            ? {
                music_track_id: row.music_track_id ?? "",
                music_track_name: row.music_track_name ?? "",
                music_artist: row.music_artist ?? "",
                music_preview_url: row.music_preview_url,
                music_artwork_url: row.music_artwork_url ?? "",
              }
            : null;

          if (row.iv && key) {
            try {
              const plain = await decryptText(key, row.content, row.iv);
              const obj = JSON.parse(plain) as DiaryEncryptedPayload;
              t = obj.t ?? "";
              c = obj.c ?? "";
              m = obj.m ?? "";
              if (obj.mu) mu = obj.mu;

              // If any legacy plaintext metadata columns remain on a private entry, scrub them into the ciphertext
              const hasLeakedMeta =
                !row.is_public &&
                (row.title !== null ||
                  row.mood !== null ||
                  (row.word_count !== null && row.word_count !== 0) ||
                  row.music_preview_url !== null ||
                  obj.wc === undefined);
              if (hasLeakedMeta) {
                const upgradedPayload: DiaryEncryptedPayload = {
                  t,
                  c,
                  m,
                  wc: countWords(c),
                  mu,
                };
                const reEnc = await encryptText(key, JSON.stringify(upgradedPayload));
                void supabase
                  .from("diary_entries")
                  .update({
                    title: null,
                    mood: null,
                    content: reEnc.ct,
                    iv: reEnc.iv,
                    word_count: 0,
                    ...NULL_MUSIC_COLUMNS,
                  } as never)
                  .eq("id", row.id);
              }
            } catch {
              c = "[Could not decrypt this entry]";
            }
          } else if (!row.is_public && !row.iv && key) {
            // Legacy unencrypted private entry: immediately encrypt all fields and scrub plaintext columns
            const upgradedPayload: DiaryEncryptedPayload = {
              t,
              c,
              m,
              wc: countWords(c),
              mu,
            };
            const enc = await encryptText(key, JSON.stringify(upgradedPayload));
            void supabase
              .from("diary_entries")
              .update({
                title: null,
                mood: null,
                content: enc.ct,
                iv: enc.iv,
                word_count: 0,
                ...NULL_MUSIC_COLUMNS,
              } as never)
              .eq("id", row.id);
          }

          return {
            id: row.id,
            title: t,
            content: c,
            mood: m,
            entry_date: row.entry_date,
            image_path: row.image_path,
            is_public: row.is_public,
            folder_id: row.folder_id,
            music: mu,
            created_at: row.created_at,
          };
        }),
      );
    },
  });

  const filteredSorted = useMemo(() => {
    let rows = entries.data ?? [];
    if (filterFolder === "none") rows = rows.filter((e) => !e.folder_id);
    else if (filterFolder !== "all") {
      const ids = folderWithDescendants(folders.data ?? [], filterFolder);
      rows = rows.filter((e) => e.folder_id && ids.has(e.folder_id));
    }
    const q = query.trim().toLowerCase();
    if (q)
      rows = rows.filter((e) =>
        `${e.title}\n${e.content}\n${e.mood}\n${e.entry_date}`.toLowerCase().includes(q),
      );
    rows = [...rows].sort((a, b) => {
      if (sort === "title") return (a.title || "").localeCompare(b.title || "");
      const cmp = new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime();
      if (cmp !== 0) return sort === "newest" ? -cmp : cmp;
      const cTime = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      return sort === "newest" ? -cTime : cTime;
    });
    return rows;
  }, [entries.data, folders.data, filterFolder, sort, query]);

  const invalidateDiaryQueries = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["diary"] });
    qc.invalidateQueries({ queryKey: ["diary-metrics"] });
    qc.invalidateQueries({ queryKey: ["public-diary-feed"] });
    qc.invalidateQueries({ queryKey: ["dashboard-counts"] });
  }, [qc]);

  const create = useMutation({
    mutationFn: async (): Promise<Entry> => {
      const musicPatch = {
        music_track_id: music?.music_track_id ?? null,
        music_track_name: music?.music_track_name ?? null,
        music_artist: music?.music_artist ?? null,
        music_preview_url: music?.music_preview_url ?? null,
        music_artwork_url: music?.music_artwork_url ?? null,
      };
      if (isPublic) {
        const { data: inserted, error } = await supabase
          .from("diary_entries")
          .insert({
            user_id: user.id,
            title: title || null,
            content,
            mood: mood || null,
            is_public: true,
            folder_id: folderId,
            visibility: "public_anon",
            word_count: countWords(content),
            ...musicPatch,
          } as never)
          .select("id,created_at,entry_date")
          .single();
        if (error) throw error;
        const row = inserted as { id: string; created_at: string; entry_date: string };
        return {
          id: row.id,
          title: title || "",
          content,
          mood: mood || "",
          entry_date: row.entry_date || new Date().toISOString().slice(0, 10),
          image_path: null,
          is_public: true,
          folder_id: folderId,
          music,
          created_at: row.created_at || new Date().toISOString(),
        };
      }
      if (!key) throw new Error("Vault is locked");
      let imagePath: string | null = null;
      if (photo) {
        const ALLOWED: Record<string, string> = {
          "image/jpeg": "jpg",
          "image/png": "png",
          "image/webp": "webp",
          "image/gif": "gif",
        };
        if (!ALLOWED[photo.type])
          throw new Error("Only JPEG, PNG, WebP, or GIF images are allowed");
        if (photo.size > 5 * 1024 * 1024) throw new Error("Photo must be smaller than 5 MB");
        imagePath = `${user.id}/${crypto.randomUUID()}.bin`;
        const { blob, iv: imgIv } = await encryptBlob(key, photo);
        const { error: upErr } = await supabase.storage
          .from("gallery")
          .upload(imagePath, blob, { contentType: "application/octet-stream" });
        if (upErr) throw upErr;
        const captionPlain = title || content.slice(0, 60) || "from my diary";
        const { ct: capCt, iv: capIv } = await encryptText(key, captionPlain);
        await supabase.from("gallery_images").insert({
          user_id: user.id,
          storage_path: imagePath,
          caption: capCt,
          iv: imgIv,
          caption_iv: capIv,
          mime: photo.type,
        });
      }
      const payload: DiaryEncryptedPayload = {
        t: title,
        c: content,
        m: mood,
        wc: countWords(content),
        mu: music,
      };
      const { ct, iv } = await encryptText(key, JSON.stringify(payload));
      const { data: inserted, error } = await supabase
        .from("diary_entries")
        .insert({
          user_id: user.id,
          title: null,
          content: ct,
          mood: null,
          image_path: imagePath,
          visibility: "private",
          is_public: false,
          folder_id: folderId,
          iv,
          word_count: 0,
          ...NULL_MUSIC_COLUMNS,
        } as never)
        .select("id,created_at,entry_date")
        .single();
      if (error) throw error;
      const row = inserted as { id: string; created_at: string; entry_date: string };
      return {
        id: row.id,
        title: title || "",
        content,
        mood: mood || "",
        entry_date: row.entry_date || new Date().toISOString().slice(0, 10),
        image_path: imagePath,
        is_public: false,
        folder_id: folderId,
        music,
        created_at: row.created_at || new Date().toISOString(),
      };
    },
    onSuccess: (createdEntry) => {
      qc.setQueryData<Entry[]>(["diary", user.id], (old) => [
        createdEntry,
        ...(old ?? []).filter((e) => e.id !== createdEntry.id),
      ]);
      qc.setQueryData<DiaryMetricRow[]>(["diary-metrics", user.id], (old) => [
        ...(old ?? []),
        {
          entry_date: createdEntry.entry_date,
          word_count: countWords(createdEntry.content),
        },
      ]);
      clearDraft();
      setPhoto(null);
      toast.success("Entry saved");
      invalidateDiaryQueries();
      qc.invalidateQueries({ queryKey: ["gallery"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: async (vars: {
      id: string;
      title: string;
      content: string;
      mood: string;
      folder_id: string | null;
      music: SelectedTrack | null;
      wasPrivate: boolean;
    }): Promise<{
      id: string;
      title: string;
      content: string;
      mood: string;
      folder_id: string | null;
      music: SelectedTrack | null;
    }> => {
      const musicPatch = {
        music_track_id: vars.music?.music_track_id ?? null,
        music_track_name: vars.music?.music_track_name ?? null,
        music_artist: vars.music?.music_artist ?? null,
        music_preview_url: vars.music?.music_preview_url ?? null,
        music_artwork_url: vars.music?.music_artwork_url ?? null,
      };
      if (vars.wasPrivate) {
        if (!key) throw new Error("Vault is locked");
        const payload: DiaryEncryptedPayload = {
          t: vars.title,
          c: vars.content,
          m: vars.mood,
          wc: countWords(vars.content),
          mu: vars.music,
        };
        const { ct, iv } = await encryptText(key, JSON.stringify(payload));
        const { error } = await supabase
          .from("diary_entries")
          .update({
            title: null,
            mood: null,
            content: ct,
            iv,
            folder_id: vars.folder_id,
            word_count: 0,
            ...NULL_MUSIC_COLUMNS,
          } as never)
          .eq("id", vars.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("diary_entries")
          .update({
            title: vars.title || null,
            content: vars.content,
            mood: vars.mood || null,
            folder_id: vars.folder_id,
            word_count: countWords(vars.content),
            ...musicPatch,
          } as never)
          .eq("id", vars.id);
        if (error) throw error;
      }
      return {
        id: vars.id,
        title: vars.title,
        content: vars.content,
        mood: vars.mood,
        folder_id: vars.folder_id,
        music: vars.music,
      };
    },
    onSuccess: (updated) => {
      qc.setQueryData<Entry[]>(["diary", user.id], (old) =>
        (old ?? []).map((e) => (e.id === updated.id ? { ...e, ...updated } : e)),
      );
      toast.success("Entry updated");
      invalidateDiaryQueries();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("diary_entries").delete().eq("id", id);
      if (error) throw error;
      return id;
    },
    onSuccess: (deletedId) => {
      qc.setQueryData<Entry[]>(["diary", user.id], (old) =>
        (old ?? []).filter((e) => e.id !== deletedId),
      );
      toast.success("Entry deleted");
      invalidateDiaryQueries();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const createFolder = useMutation({
    mutationFn: async (name: string): Promise<FolderRow> => {
      if (!key) throw new Error("Vault is locked");
      const encName = await encryptField(key, name);
      const parentId = newFolderParent === NONE ? null : newFolderParent;
      const { data: inserted, error } = await supabase
        .from("diary_folders")
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
    onSuccess: (newF) => {
      qc.setQueryData<FolderRow[]>(["diary-folders", user.id], (old) => [...(old ?? []), newF]);
      setNewFolder("");
      qc.invalidateQueries({ queryKey: ["diary-folders"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteFolder = useMutation({
    mutationFn: async (targetFolderId: string) => {
      const { error } = await supabase
        .from("diary_folders")
        .delete()
        .eq("id", targetFolderId)
        .eq("user_id", user.id);
      if (error) throw error;
      return targetFolderId;
    },
    onSuccess: (deletedFolderId) => {
      qc.setQueryData<FolderRow[]>(["diary-folders", user.id], (old) =>
        (old ?? []).filter((f) => f.id !== deletedFolderId),
      );
      setFilterFolder("all");
      toast.success("Folder deleted");
      qc.invalidateQueries({ queryKey: ["diary-folders"] });
      qc.invalidateQueries({ queryKey: ["diary"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleDeleteEntry = useCallback((id: string) => remove.mutate(id), [remove]);
  const handleSaveEntry = useCallback(
    (
      id: string,
      wasPrivate: boolean,
      v: {
        title: string;
        content: string;
        mood: string;
        folder_id: string | null;
        music: SelectedTrack | null;
      },
    ) => {
      update.mutate({ id, ...v, wasPrivate });
    },
    [update],
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

      setOcrProgress({ current: 1, total: list.length });
      let accumulated = content;
      let successCount = 0;

      try {
        for (let i = 0; i < list.length; i++) {
          setOcrProgress({ current: i + 1, total: list.length });
          const extracted = await transcribeHandwritingFile(list[i]);
          if (extracted) {
            accumulated = accumulated.trim()
              ? `${accumulated.trimEnd()}\n\n${extracted}`
              : extracted;
            setDraft((current) => ({ ...current, content: accumulated }));
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
    [content, setDraft],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-hand text-2xl text-sepia">today's page</p>
          <h1 className="font-serif text-4xl text-primary">Diary</h1>
          <p className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">
            end-to-end encrypted
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            const rows = entries.data ?? [];
            if (!rows.length) {
              toast.error("No entries to export yet");
              return;
            }
            const txt = rows
              .map(
                (e) =>
                  `${e.entry_date} — ${e.title || "Untitled"}${e.mood ? `  (feeling: ${e.mood})` : ""}${e.is_public ? "  [public]" : ""}\n${"-".repeat(60)}\n${e.content}\n`,
              )
              .join("\n\n");
            downloadTextFile(`diary-${new Date().toISOString().slice(0, 10)}.txt`, txt);
          }}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm text-primary hover:bg-secondary"
        >
          <Download className="size-4" /> Export
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (content.trim()) create.mutate();
        }}
        className="paper-card overflow-hidden"
      >
        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              if (f.size >= 5 * 1024 * 1024) toast.error("Photo must be smaller than 5 MB");
              else setPhoto(f);
            }
            e.currentTarget.value = "";
          }}
        />
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

        <RichEditor
          value={content}
          onChange={setContent}
          placeholder="Pour it out..."
          minHeightClass="min-h-[180px]"
          onPhotoClick={!isPublic ? () => photoInputRef.current?.click() : undefined}
          photoLabel={photo ? "Change photo" : "Photo"}
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
          bodyClassName="space-y-4 p-6"
          headerSlot={
            <div className="space-y-2">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title"
                className="w-full bg-transparent font-serif text-2xl text-primary outline-none placeholder:text-muted-foreground/60 sm:text-3xl"
              />
              <input
                value={mood}
                onChange={(e) => setMood(e.target.value)}
                placeholder="How are you feeling?"
                className="w-full bg-transparent text-sm text-accent outline-none placeholder:text-muted-foreground/60"
              />
            </div>
          }
          footerSlot={
            <div className="space-y-4 pt-2">
              {photoPreview && !isPublic && (
                <div className="relative inline-block">
                  <img
                    src={photoPreview}
                    alt="preview"
                    className="max-h-56 rounded-md border border-border"
                  />
                  <button
                    type="button"
                    onClick={() => setPhoto(null)}
                    className="absolute -right-2 -top-2 rounded-full bg-background p-1 shadow"
                  >
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
                      { value: "private", label: "Private (encrypted)" },
                      { value: "public", label: "Public · anonymous" },
                    ]}
                  />
                </label>
                <label className="flex items-center gap-2">
                  <span className="text-muted-foreground">Folder</span>
                  <AppSelect
                    value={folderId ?? NONE}
                    onValueChange={(v) => setFolderId(v === NONE ? null : v)}
                    options={[{ value: NONE, label: "— none —" }, ...fOpts]}
                  />
                </label>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    {(() => {
                      const words = countWords(content);
                      return `${words} ${words === 1 ? "word" : "words"}`;
                    })()}
                  </span>
                  {isPublic && (
                    <span className="text-xs text-muted-foreground">
                      Public entries appear anonymously in the community Feed.
                    </span>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={!content.trim() || create.isPending}
                  className="rounded-md bg-primary px-5 py-2 text-sm text-primary-foreground disabled:opacity-50"
                >
                  {create.isPending ? "Saving..." : "Save entry"}
                </button>
              </div>
            </div>
          }
        />
      </form>

      <label className="paper-card flex items-center gap-2 px-3 py-2 text-sm">
        <Search className="size-4 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search diary entries..."
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/60"
        />
        {query && (
          <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
            <X className="size-4 text-muted-foreground" />
          </button>
        )}
      </label>
      <div className="paper-card flex flex-wrap items-center gap-3 p-3 text-sm">
        <div className="flex items-center gap-1.5">
          <Folder className="size-4 text-muted-foreground" />
          <AppSelect
            value={filterFolder}
            onValueChange={(v) => setFilterFolder(v as typeof filterFolder)}
            options={[
              { value: "all", label: "All entries" },
              { value: "none", label: "No folder" },
              ...fOpts,
            ]}
          />
          {filterFolder !== "all" && filterFolder !== "none" && (
            <button
              type="button"
              onClick={() => deleteFolder.mutate(filterFolder)}
              title="Delete selected folder"
              className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-destructive"
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
            options={[
              { value: "newest", label: "Newest first" },
              { value: "oldest", label: "Oldest first" },
              { value: "title", label: "Title A–Z" },
            ]}
          />
        </label>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (newFolder.trim()) createFolder.mutate(newFolder.trim());
          }}
          className="flex flex-wrap items-center gap-1 sm:ml-auto"
        >
          <input
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            placeholder="New folder"
            className="w-32 rounded-md border border-input bg-card px-2 py-1"
          />
          <AppSelect
            value={newFolderParent}
            onValueChange={setNewFolderParent}
            options={[
              { value: NONE, label: "Top level" },
              ...fOpts.map((o) => ({ value: o.value, label: `inside ${o.label}` })),
            ]}
          />
          <button
            type="submit"
            className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground"
          >
            <FolderPlus className="size-3.5" /> Add
          </button>
        </form>
      </div>

      <div className="space-y-4">
        {entries.isLoading && <p className="font-hand text-sepia">opening your pages...</p>}
        {entries.data?.length === 0 && (
          <p className="text-muted-foreground">Your diary is a blank page. Start above.</p>
        )}
        {filteredSorted.map((e) => (
          <DiaryCard
            key={e.id}
            entry={e}
            folderOpts={fOpts}
            cryptoKey={key}
            onDelete={handleDeleteEntry}
            onSave={handleSaveEntry}
          />
        ))}
      </div>
    </div>
  );
}

function DiaryImage({
  path,
  encrypted,
  cryptoKey,
}: {
  path: string;
  encrypted: boolean;
  cryptoKey: CryptoKey | null;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      const { data: signed } = await supabase.storage
        .from("gallery")
        .createSignedUrl(path, 60 * 60);
      if (!signed?.signedUrl || cancelled) return;
      if (!encrypted || !cryptoKey) {
        setSrc(signed.signedUrl);
        return;
      }
      const { data: meta } = await supabase
        .from("gallery_images")
        .select("iv,mime" as never)
        .eq("storage_path", path)
        .maybeSingle();
      const row = meta as unknown as { iv: string | null; mime: string | null } | null;
      if (!row?.iv) {
        if (!cancelled) setSrc(signed.signedUrl);
        return;
      }
      try {
        const res = await fetch(signed.signedUrl);
        const ct = await res.arrayBuffer();
        const pt = await decryptBytes(cryptoKey, ct, row.iv);
        objectUrl = URL.createObjectURL(new Blob([pt], { type: row.mime || "image/jpeg" }));
        if (!cancelled) setSrc(objectUrl);
      } catch {
        // unreadable image
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, encrypted, cryptoKey]);

  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      className="mt-4 max-h-96 rounded-md border border-border"
      loading="lazy"
    />
  );
}

const DiaryCard = memo(function DiaryCard({
  entry: e,
  folderOpts,
  cryptoKey,
  onDelete,
  onSave,
}: {
  entry: Entry;
  folderOpts: { value: string; label: string }[];
  cryptoKey: CryptoKey | null;
  onDelete: (id: string) => void;
  onSave: (
    id: string,
    wasPrivate: boolean,
    v: {
      title: string;
      content: string;
      mood: string;
      folder_id: string | null;
      music: SelectedTrack | null;
    },
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [eTitle, setETitle] = useState(e.title);
  const [eContent, setEContent] = useState(e.content);
  const [eMood, setEMood] = useState(e.mood);
  const [eFolder, setEFolder] = useState<string | null>(e.folder_id);
  const [eMusic, setEMusic] = useState<SelectedTrack | null>(e.music);
  const [confirmDel, setConfirmDel] = useState(false);
  const cardOcrInputRef = useRef<HTMLInputElement | null>(null);
  const [cardOcrProgress, setCardOcrProgress] = useState<{ current: number; total: number } | null>(
    null,
  );
  const pv = useMemo(() => previewText(e.content, 220), [e.content]);
  const long = pv.truncated || !!e.image_path;

  const handleCardHandwritingFiles = useCallback(
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

      setCardOcrProgress({ current: 1, total: list.length });
      let accumulated = eContent;
      let successCount = 0;

      try {
        for (let i = 0; i < list.length; i++) {
          setCardOcrProgress({ current: i + 1, total: list.length });
          const extracted = await transcribeHandwritingFile(list[i]);
          if (extracted) {
            accumulated = accumulated.trim()
              ? `${accumulated.trimEnd()}\n\n${extracted}`
              : extracted;
            setEContent(accumulated);
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
        setCardOcrProgress(null);
      }
    },
    [eContent],
  );

  if (editing) {
    return (
      <article className="paper-card overflow-hidden">
        <input
          ref={cardOcrInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(ev) => {
            void handleCardHandwritingFiles(ev.target.files);
            ev.currentTarget.value = "";
          }}
        />
        <RichEditor
          value={eContent}
          onChange={setEContent}
          placeholder="Pour it out..."
          minHeightClass="min-h-[180px]"
          toolbarRightSlot={
            <button
              type="button"
              disabled={!!cardOcrProgress}
              onClick={() => cardOcrInputRef.current?.click()}
              title="Convert handwritten images to text (supports multiple images)"
              className="inline-flex items-center gap-1.5 text-sm text-foreground/80 transition hover:text-primary disabled:opacity-50"
            >
              {cardOcrProgress ? (
                <>
                  <Loader2 className="size-4 animate-spin text-sepia" />
                  <span>
                    Scanning {cardOcrProgress.current}/{cardOcrProgress.total}...
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
          bodyClassName="space-y-3 p-6"
          headerSlot={
            <div className="space-y-2">
              <input
                value={eTitle}
                onChange={(ev) => setETitle(ev.target.value)}
                placeholder="Title"
                className="w-full bg-transparent font-serif text-2xl text-primary outline-none"
              />
              <input
                value={eMood}
                onChange={(ev) => setEMood(ev.target.value)}
                placeholder="How are you feeling?"
                className="w-full bg-transparent text-sm text-accent outline-none"
              />
            </div>
          }
          footerSlot={
            <div className="space-y-3 pt-2">
              <MusicSearch selected={eMusic} onChange={setEMusic} />
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-2">
                  <span className="text-muted-foreground">Folder</span>
                  <AppSelect
                    value={eFolder ?? NONE}
                    onValueChange={(v) => setEFolder(v === NONE ? null : v)}
                    options={[{ value: NONE, label: "— none —" }, ...folderOpts]}
                  />
                </label>
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-3">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  {(() => {
                    const words = countWords(eContent);
                    return `${words} ${words === 1 ? "word" : "words"}`;
                  })()}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm"
                  >
                    <X className="size-4" /> Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onSave(e.id, !e.is_public, {
                        title: eTitle,
                        content: eContent,
                        mood: eMood,
                        folder_id: eFolder,
                        music: eMusic,
                      });
                      setEditing(false);
                    }}
                    className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
                  >
                    <Check className="size-4" /> Save
                  </button>
                </div>
              </div>
            </div>
          }
        />
      </article>
    );
  }

  return (
    <article className="paper-card p-6">
      <header className="flex items-baseline justify-between gap-3">
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-left font-serif text-xl text-primary hover:underline underline-offset-4"
        >
          {e.title || "Untitled"}
        </button>
        <div className="flex items-center gap-3">
          <span className="font-hand text-sepia">
            {new Date(e.entry_date).toLocaleDateString(undefined, {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </span>
          <span
            title={e.is_public ? "Public · anonymous" : "Private"}
            className="text-muted-foreground"
          >
            {e.is_public ? <Globe className="size-4" /> : <Lock className="size-4" />}
          </span>
          <button
            onClick={() => {
              setETitle(e.title);
              setEContent(e.content);
              setEMood(e.mood);
              setEFolder(e.folder_id);
              setEMusic(e.music);
              setEditing(true);
            }}
            className="text-muted-foreground hover:text-primary"
            aria-label="Edit"
          >
            <Pencil className="size-4" />
          </button>
          <button
            onClick={() => setConfirmDel(true)}
            className="text-muted-foreground hover:text-destructive"
            aria-label="Delete"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </header>
      {e.mood && <p className="mt-1 text-sm text-accent">Feeling: {e.mood}</p>}
      <div className="mt-3 break-words">
        <RichText>{open ? e.content : pv.text}</RichText>
      </div>
      {open && e.image_path && (
        <DiaryImage path={e.image_path} encrypted={!e.is_public} cryptoKey={cryptoKey} />
      )}
      {e.music?.music_preview_url && (
        <MusicPlayer
          track={{
            music_track_name: e.music.music_track_name,
            music_artist: e.music.music_artist,
            music_preview_url: e.music.music_preview_url,
            music_artwork_url: e.music.music_artwork_url,
          }}
        />
      )}
      {long && (
        <button
          onClick={() => setOpen((o) => !o)}
          className="mt-2 text-sm text-accent hover:text-primary"
        >
          {open ? "Show less" : "Read more"}
        </button>
      )}
      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title="Delete this diary entry?"
        description="This can't be undone."
        confirmText="Delete entry"
        onConfirm={() => {
          onDelete(e.id);
          setConfirmDel(false);
        }}
      />
    </article>
  );
});
