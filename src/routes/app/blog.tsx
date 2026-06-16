import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";

export const Route = createFileRoute("/app/blog")({
  component: BlogPage,
});

function BlogPage() {
  const { user } = Route.useRouteContext();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [open, setOpen] = useState(false);

  const posts = useQuery({
    queryKey: ["blog", user.id],
    queryFn: async () => {
      const { data, error } = await supabase.from("blog_posts").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const tagArr = tags.split(",").map((t) => t.trim()).filter(Boolean);
      const { error } = await supabase.from("blog_posts").insert({
        user_id: user.id, title, content, tags: tagArr.length ? tagArr : null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setTitle(""); setContent(""); setTags(""); setOpen(false);
      toast.success("Blog published");
      qc.invalidateQueries({ queryKey: ["blog"] });
      qc.invalidateQueries({ queryKey: ["dashboard-counts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("blog_posts").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["blog"] }),
  });

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <p className="font-hand text-2xl text-sepia">your thoughts, published</p>
          <h1 className="font-serif text-4xl text-primary">Blog</h1>
        </div>
        <button onClick={() => setOpen(!open)} className="rounded-md bg-primary px-5 py-2 text-sm text-primary-foreground">
          {open ? "Cancel" : "Write new post"}
        </button>
      </div>

      {open && (
        <form
          onSubmit={(e) => { e.preventDefault(); if (title.trim() && content.trim()) create.mutate(); }}
          className="paper-card space-y-3 p-6"
        >
          <input
            value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Post title" required
            className="w-full bg-transparent font-serif text-3xl outline-none placeholder:text-muted-foreground/60"
          />
          <input
            value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, separated, by, commas"
            className="w-full bg-transparent text-sm text-accent outline-none placeholder:text-muted-foreground/60"
          />
          <textarea
            value={content} onChange={(e) => setContent(e.target.value)} placeholder="Write your story..." rows={12} required
            className="w-full resize-none bg-transparent leading-relaxed outline-none placeholder:text-muted-foreground/60"
          />
          <div className="flex justify-end">
            <button type="submit" disabled={create.isPending} className="rounded-md bg-primary px-5 py-2 text-sm text-primary-foreground disabled:opacity-50">
              {create.isPending ? "Publishing..." : "Publish"}
            </button>
          </div>
        </form>
      )}

      <div className="space-y-4">
        {posts.data?.length === 0 && <p className="text-muted-foreground">No blog posts yet.</p>}
        {posts.data?.map((p) => <BlogCard key={p.id} post={p} isOwner={p.user_id === user.id} onDelete={() => remove.mutate(p.id)} />)}
      </div>
    </div>
  );
}

function BlogCard({ post: p, onDelete }: { post: any; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const preview = p.content.length > 220 ? p.content.slice(0, 220).trimEnd() + "…" : p.content;
  return (
    <article className="paper-card p-6">
      <header className="flex items-baseline justify-between">
        <button onClick={() => setOpen((o) => !o)} className="text-left font-serif text-2xl text-primary hover:underline underline-offset-4">
          {p.title}
        </button>
        <div className="flex items-center gap-3">
          <span className="font-hand text-sepia">{new Date(p.created_at).toLocaleDateString()}</span>
          <button onClick={onDelete} className="text-muted-foreground hover:text-destructive">
            <Trash2 className="size-4" />
          </button>
        </div>
      </header>
      {p.tags && p.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {p.tags.map((t: string) => <span key={t} className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">#{t}</span>)}
        </div>
      )}
      <p className="mt-3 whitespace-pre-wrap leading-relaxed">{open ? p.content : preview}</p>
      {p.content.length > 220 && (
        <button onClick={() => setOpen((o) => !o)} className="mt-2 text-sm text-accent hover:text-primary">
          {open ? "Show less" : "Read more"}
        </button>
      )}
    </article>
  );
}
