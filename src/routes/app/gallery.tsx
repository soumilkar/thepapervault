import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Check, Pencil, Trash2, Upload, X, Lock } from "lucide-react";
import { useVault } from "@/lib/vault";
import { decryptBytes, decryptText, encryptBlob, encryptText } from "@/lib/crypto";
import { useBrowserDraft } from "@/lib/browser-drafts";

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
  caption: string;
  created_at: string;
  signedUrl: string;
  iv: string | null;
  mime: string | null;
};

function GalleryPage() {
  const { user } = Route.useRouteContext();
  const { key } = useVault();
  const qc = useQueryClient();
  const [caption, setCaption, clearCaptionDraft] = useBrowserDraft(`papervault:gallery-caption:${user.id}`, "");
  const [uploading, setUploading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftCaption, setDraftCaption] = useState("");

  const images = useQuery({
    enabled: !!key,
    queryKey: ["gallery", user.id],
    queryFn: async (): Promise<DecodedItem[]> => {
      const { data, error } = await supabase
        .from("gallery_images")
        .select("id,storage_path,caption,created_at,iv,caption_iv,mime" as never)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const rows = (data ?? []) as unknown as ImageRowRaw[];
      if (!rows.length) return [];

      // Batch signed URL generation in a single request instead of N sequential requests
      const paths = rows.map((r) => r.storage_path);
      const { data: signedList } = await supabase.storage.from("gallery").createSignedUrls(paths, 60 * 60);
      const urlMap = new Map<string, string>();
      for (const item of signedList ?? []) {
        if (item.path && item.signedUrl) urlMap.set(item.path, item.signedUrl);
      }

      return Promise.all(
        rows.map(async (img) => {
          let captionPlain = img.caption ?? "";
          if (img.caption && img.caption_iv && key) {
            try {
              captionPlain = await decryptText(key, img.caption, img.caption_iv);
            } catch {
              captionPlain = "[encrypted]";
            }
          } else if (img.caption && !img.caption_iv && key) {
            const enc = await encryptText(key, img.caption);
            void supabase
              .from("gallery_images")
              .update({ caption: enc.ct, caption_iv: enc.iv })
              .eq("id", img.id);
          }
          return {
            id: img.id,
            storage_path: img.storage_path,
            caption: captionPlain,
            created_at: img.created_at,
            signedUrl: urlMap.get(img.storage_path) ?? "",
            iv: img.iv,
            mime: img.mime,
          };
        }),
      );
    },
  });

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
      const { error: upErr } = await supabase.storage
        .from("gallery")
        .upload(path, blob, { contentType: "application/octet-stream" });
      if (upErr) throw upErr;
      let captionCt: string | null = null;
      let captionIv: string | null = null;
      if (caption) {
        const enc = await encryptText(key, caption);
        captionCt = enc.ct;
        captionIv = enc.iv;
      }
      const { error: dbErr } = await supabase.from("gallery_images").insert({
        user_id: user.id,
        storage_path: path,
        caption: captionCt,
        iv,
        caption_iv: captionIv,
        mime: file.type,
      });
      if (dbErr) throw dbErr;
      clearCaptionDraft();
      toast.success("Photo added (encrypted)");
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
        supabase.storage.from("gallery").remove([img.storage_path]),
        // Clear any unallocated diary_entries.image_path references to this deleted photo
        supabase
          .from("diary_entries")
          .update({ image_path: null } as never)
          .eq("user_id", user.id)
          .eq("image_path", img.storage_path),
      ]);
      const { error } = await supabase.from("gallery_images").delete().eq("id", img.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["gallery"] });
      qc.invalidateQueries({ queryKey: ["diary"] });
      qc.invalidateQueries({ queryKey: ["dashboard-counts"] });
    },
  });

  const updateCaption = useMutation({
    mutationFn: async ({ id, caption }: { id: string; caption: string }) => {
      if (!key) throw new Error("Vault is locked");
      let captionCt: string | null = null;
      let captionIv: string | null = null;
      if (caption) {
        const enc = await encryptText(key, caption);
        captionCt = enc.ct;
        captionIv = enc.iv;
      }
      const { error } = await supabase
        .from("gallery_images")
        .update({
          caption: captionCt,
          caption_iv: captionIv,
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      setEditingId(null);
      toast.success("Caption updated");
      qc.invalidateQueries({ queryKey: ["gallery"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-8">
      <div>
        <p className="font-hand text-2xl text-sepia">moments worth keeping</p>
        <h1 className="font-serif text-4xl text-primary">Gallery</h1>
        <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
          <Lock className="size-3" /> Photos are end-to-end encrypted with your vault passphrase.
        </p>
      </div>

      <div className="paper-card p-6">
        <input
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="Caption (optional) — added to the next photo you upload"
          className="mb-4 w-full bg-transparent outline-none placeholder:text-muted-foreground/60"
        />
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border-2 border-dashed border-border bg-secondary/40 px-6 py-10 transition hover:border-ring hover:bg-secondary">
          <Upload className="size-5 text-accent" />
          <span className="text-sm">{uploading ? "Encrypting & uploading..." : "Click to upload a photo"}</span>
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

      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
        {images.isLoading && <p className="font-hand text-sepia">developing your photos...</p>}
        {images.data?.length === 0 && <p className="text-muted-foreground">No photos yet.</p>}
        {images.data?.map((img) => {
          const isEditing = editingId === img.id;
          return (
            <div key={img.id} className="paper-card group overflow-hidden">
              <div className="aspect-square overflow-hidden bg-muted">
                <DecryptedGalleryPhoto
                  signedUrl={img.signedUrl}
                  iv={img.iv}
                  mime={img.mime}
                  alt={img.caption || ""}
                  cryptoKey={key}
                />
              </div>
              <div className="flex items-start justify-between gap-2 p-3">
                {isEditing ? (
                  <>
                    <input
                      autoFocus
                      value={draftCaption}
                      onChange={(e) => setDraftCaption(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") updateCaption.mutate({ id: img.id, caption: draftCaption });
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      className="w-full bg-transparent font-hand text-lg text-sepia outline-none"
                      placeholder="caption"
                    />
                    <div className="flex shrink-0 gap-1">
                      <button
                        onClick={() => updateCaption.mutate({ id: img.id, caption: draftCaption })}
                        className="text-accent hover:text-primary"
                      >
                        <Check className="size-4" />
                      </button>
                      <button onClick={() => setEditingId(null)} className="text-muted-foreground hover:text-foreground">
                        <X className="size-4" />
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="font-hand text-lg text-sepia">{img.caption || "untitled"}</p>
                    <div className="flex shrink-0 gap-2">
                      <button
                        onClick={() => {
                          setEditingId(img.id);
                          setDraftCaption(img.caption || "");
                        }}
                        className="text-muted-foreground hover:text-primary"
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button onClick={() => remove.mutate(img)} className="text-muted-foreground hover:text-destructive">
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const DecryptedGalleryPhoto = memo(function DecryptedGalleryPhoto({
  signedUrl,
  iv,
  mime,
  alt,
  cryptoKey,
}: {
  signedUrl: string;
  iv: string | null;
  mime: string | null;
  alt: string;
  cryptoKey: CryptoKey | null;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!signedUrl) return;
    if (!iv) {
      setSrc(signedUrl);
      return;
    }
    if (!cryptoKey) return;

    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const res = await fetch(signedUrl);
        const ct = await res.arrayBuffer();
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
  }, [signedUrl, iv, mime, cryptoKey]);

  if (!src) return <div className="size-full animate-pulse bg-secondary/50" />;
  return (
    <img
      src={src}
      alt={alt}
      className="size-full object-cover transition group-hover:scale-105"
      loading="lazy"
      decoding="async"
    />
  );
});
