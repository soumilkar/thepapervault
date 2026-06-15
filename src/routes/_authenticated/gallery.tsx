import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Trash2, Upload } from "lucide-react";

export const Route = createFileRoute("/_authenticated/gallery")({
  component: GalleryPage,
});

type ImageRow = { id: string; storage_path: string; caption: string | null; created_at: string };

function GalleryPage() {
  const { user } = Route.useRouteContext();
  const qc = useQueryClient();
  const [caption, setCaption] = useState("");
  const [uploading, setUploading] = useState(false);

  const images = useQuery({
    queryKey: ["gallery", user.id],
    queryFn: async (): Promise<(ImageRow & { url: string })[]> => {
      const { data, error } = await supabase
        .from("gallery_images").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      const withUrls = await Promise.all((data ?? []).map(async (img) => {
        const { data: signed } = await supabase.storage.from("gallery").createSignedUrl(img.storage_path, 60 * 60);
        return { ...img, url: signed?.signedUrl ?? "" };
      }));
      return withUrls;
    },
  });

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const ext = file.name.split(".").pop() || "jpg";
      const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("gallery").upload(path, file);
      if (upErr) throw upErr;
      const { error: dbErr } = await supabase.from("gallery_images").insert({
        user_id: user.id, storage_path: path, caption: caption || null,
      });
      if (dbErr) throw dbErr;
      setCaption("");
      toast.success("Photo added");
      qc.invalidateQueries({ queryKey: ["gallery"] });
      qc.invalidateQueries({ queryKey: ["dashboard-counts"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const remove = useMutation({
    mutationFn: async (img: ImageRow) => {
      await supabase.storage.from("gallery").remove([img.storage_path]);
      const { error } = await supabase.from("gallery_images").delete().eq("id", img.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["gallery"] }),
  });

  return (
    <div className="space-y-8">
      <div>
        <p className="font-hand text-2xl text-sepia">moments worth keeping</p>
        <h1 className="font-serif text-4xl text-primary">Gallery</h1>
      </div>

      <div className="paper-card p-6">
        <input
          value={caption} onChange={(e) => setCaption(e.target.value)}
          placeholder="Caption (optional) — added to the next photo you upload"
          className="mb-4 w-full bg-transparent outline-none placeholder:text-muted-foreground/60"
        />
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border-2 border-dashed border-border bg-secondary/40 px-6 py-10 transition hover:border-ring hover:bg-secondary">
          <Upload className="size-5 text-accent" />
          <span className="text-sm">{uploading ? "Uploading..." : "Click to upload a photo"}</span>
          <input
            type="file" accept="image/*" className="hidden" disabled={uploading}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.currentTarget.value = ""; }}
          />
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
        {images.data?.length === 0 && <p className="text-muted-foreground">No photos yet.</p>}
        {images.data?.map((img) => (
          <div key={img.id} className="paper-card group overflow-hidden">
            <div className="aspect-square overflow-hidden bg-muted">
              {img.url && <img src={img.url} alt={img.caption || ""} className="size-full object-cover transition group-hover:scale-105" loading="lazy" />}
            </div>
            <div className="flex items-start justify-between gap-2 p-3">
              <p className="font-hand text-lg text-sepia">{img.caption || "untitled"}</p>
              <button onClick={() => remove.mutate(img)} className="text-muted-foreground hover:text-destructive">
                <Trash2 className="size-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
