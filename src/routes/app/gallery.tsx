import { pageMeta } from "@/lib/page-meta";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Check, Pencil, Trash2, Upload, X, Lock } from "lucide-react";
import { useVault } from "@/lib/vault";
import { decryptBytes, decryptText, encryptBlob, encryptText } from "@/lib/crypto";

export const Route = createFileRoute("/app/gallery")({
  head: () => pageMeta('Gallery', 'Your personal collection of photos and memories.'),
  component: GalleryPage,
});

type ImageRowRaw = {
  id: string; storage_path: string; caption: string | null; created_at: string;
  iv: string | null; caption_iv: string | null; mime: string | null;
};
type Decoded = { id: string; storage_path: string; caption: string; created_at: string; url: string };

function GalleryPage() {
  const { user } = Route.useRouteContext();
  const { key } = useVault();
  const qc = useQueryClient();
  const [caption, setCaption] = useState("");
  const [uploading, setUploading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftCaption, setDraftCaption] = useState("");

  const images = useQuery({
    enabled: !!key,
    queryKey: ["gallery", user.id],
    queryFn: async (): Promise<Decoded[]> => {
      const { data, error } = await supabase
        .from("gallery_images").select("id,storage_path,caption,created_at,iv,caption_iv,mime" as never).eq("user_id", user.id).order("created_at", { ascending: false });
      if (error) throw error;
      const rows = (data ?? []) as unknown as ImageRowRaw[];
      const out: Decoded[] = [];
      for (const img of rows) {
        const { data: signed } = await supabase.storage.from("gallery").createSignedUrl(img.storage_path, 60 * 60);
        let url = signed?.signedUrl ?? "";
        if (img.iv && key && signed?.signedUrl) {
          try {
            const res = await fetch(signed.signedUrl);
            const ct = await res.arrayBuffer();
            const pt = await decryptBytes(key, ct, img.iv);
            url = URL.createObjectURL(new Blob([pt], { type: img.mime || "image/jpeg" }));
          } catch { url = ""; }
        }
        let captionPlain = img.caption ?? "";
        if (img.caption && img.caption_iv && key) {
          try { captionPlain = await decryptText(key, img.caption, img.caption_iv); }
          catch { captionPlain = "[encrypted]"; }
        }
        out.push({ id: img.id, storage_path: img.storage_path, caption: captionPlain, created_at: img.created_at, url });
      }
      return out;
    },
  });

  const upload = async (file: File) => {
    if (!key) { toast.error("Vault is locked"); return; }
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
      const { error: upErr } = await supabase.storage.from("gallery").upload(path, blob, { contentType: "application/octet-stream" });
      if (upErr) throw upErr;
      let captionCt: string | null = null;
      let captionIv: string | null = null;
      if (caption) {
        const enc = await encryptText(key, caption);
        captionCt = enc.ct; captionIv = enc.iv;
      }
      const { error: dbErr } = await supabase.from("gallery_images").insert({
        user_id: user.id, storage_path: path, caption: captionCt,
        iv, caption_iv: captionIv, mime: file.type,
      });
      if (dbErr) throw dbErr;
      setCaption("");
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
    mutationFn: async (img: Decoded) => {
      await supabase.storage.from("gallery").remove([img.storage_path]);
      const { error } = await supabase.from("gallery_images").delete().eq("id", img.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["gallery"] }),
  });

  const updateCaption = useMutation({
    mutationFn: async ({ id, caption }: { id: string; caption: string }) => {
      if (!key) throw new Error("Vault is locked");
      let captionCt: string | null = null;
      let captionIv: string | null = null;
      if (caption) {
        const enc = await encryptText(key, caption);
        captionCt = enc.ct; captionIv = enc.iv;
      }
      const { error } = await supabase.from("gallery_images").update({
        caption: captionCt,
        caption_iv: captionIv,
      }).eq("id", id);
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
        <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><Lock className="size-3" /> Photos are end-to-end encrypted with your vault passphrase.</p>
      </div>

      <div className="paper-card p-6">
        <input
          value={caption} onChange={(e) => setCaption(e.target.value)}
          placeholder="Caption (optional) — added to the next photo you upload"
          className="mb-4 w-full bg-transparent outline-none placeholder:text-muted-foreground/60"
        />
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border-2 border-dashed border-border bg-secondary/40 px-6 py-10 transition hover:border-ring hover:bg-secondary">
          <Upload className="size-5 text-accent" />
          <span className="text-sm">{uploading ? "Encrypting & uploading..." : "Click to upload a photo"}</span>
          <input
            type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden" disabled={uploading}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.currentTarget.value = ""; }}
          />
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
        {images.data?.length === 0 && <p className="text-muted-foreground">No photos yet.</p>}
        {images.data?.map((img) => {
          const isEditing = editingId === img.id;
          return (
            <div key={img.id} className="paper-card group overflow-hidden">
              <div className="aspect-square overflow-hidden bg-muted">
                {img.url && <img src={img.url} alt={img.caption || ""} className="size-full object-cover transition group-hover:scale-105" loading="lazy" />}
              </div>
              <div className="flex items-start justify-between gap-2 p-3">
                {isEditing ? (
                  <>
                    <input
                      autoFocus value={draftCaption} onChange={(e) => setDraftCaption(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") updateCaption.mutate({ id: img.id, caption: draftCaption }); if (e.key === "Escape") setEditingId(null); }}
                      className="w-full bg-transparent font-hand text-lg text-sepia outline-none"
                      placeholder="caption"
                    />
                    <div className="flex shrink-0 gap-1">
                      <button onClick={() => updateCaption.mutate({ id: img.id, caption: draftCaption })} className="text-accent hover:text-primary">
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
                      <button onClick={() => { setEditingId(img.id); setDraftCaption(img.caption || ""); }} className="text-muted-foreground hover:text-primary">
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
