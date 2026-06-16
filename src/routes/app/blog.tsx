import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Trash2, Pencil, X, Check, BookOpen, Users } from "lucide-react";

export const Route = createFileRoute("/app/blog")({
  component: BlogPage,
});

type Tab = "mine" | "community";

function BlogPage() {
  const { user } = Route.useRouteContext();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("mine");

  const mine = useQuery({
    queryKey: ["blog", "mine", user.id],
    queryFn: async () => {
      const { data, error } = await supabase.from("blog_posts").select("*")
        .eq("user_id", user.id).order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const community = useQuery({
    queryKey: ["blog", "community", user.id],
    enabled: tab === "community",
    queryFn: async () => {
      const { data: posts, error } = await supabase.from("blog_posts").select("*")
        .neq("user_id", user.id).order("created_at", { ascending: false }).limit(100);
      if (error) throw error;
      const ids = Array.from(new Set((posts ?? []).map((p) => p.user_id)));
      const nameMap = new Map<string, string>();
      if (ids.length) {
        const { data: profs } = await supabase.from("profiles").select("id, display_name").in("id", ids);
        (profs ?? []).forEach((p) => nameMap.set(p.id, p.display_name || "someone"));
      }
      return (posts ?? []).map((p) => ({ ...p, author: nameMap.get(p.user_id) || "someone" }));
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["blog"] });
      qc.invalidateQueries({ queryKey: ["dashboard-counts"] });
    },
  });

  const update = useMutation({
    mutationFn: async (vars: { id: string; title: string; content: string; tags: string }) => {
      const tagArr = vars.tags.split(",").map((t) => t.trim()).filter(Boolean);
      const { error } = await supabase.from("blog_posts")
        .update({ title: vars.title, content: vars.content, tags: tagArr.length ? tagArr : null })
        .eq("id", vars.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Post updated");
      qc.invalidateQueries({ queryKey: ["blog"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
        <div className="min-w-0">
          <p className="font-hand text-2xl text-sepia">your thoughts, published</p>
          <h1 className="font-serif text-4xl text-primary">Blog</h1>
        </div>
        <button onClick={() => setOpen(!open)} className="shrink-0 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">
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

      <div className="flex gap-2 border-b border-border">
        <TabBtn active={tab === "mine"} onClick={() => setTab("mine")} icon={<BookOpen className="size-4" />} label="My Blogs" />
        <TabBtn active={tab === "community"} onClick={() => setTab("community")} icon={<Users className="size-4" />} label="Community" />
      </div>

      {tab === "mine" ? (
        <div className="space-y-4">
          {mine.isLoading && <p className="text-muted-foreground">Loading...</p>}
          {mine.data?.length === 0 && <p className="text-muted-foreground">No blog posts yet.</p>}
          {mine.data?.map((p) => (
            <BlogCard
              key={p.id}
              post={p}
              isOwner
              onDelete={() => remove.mutate(p.id)}
              onSave={(vals) => update.mutate({ id: p.id, ...vals })}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {community.isLoading && <p className="text-muted-foreground">Loading community stories...</p>}
          {community.data?.length === 0 && <p className="text-muted-foreground">No posts from others yet.</p>}
          {community.data?.map((p) => (
            <BlogCard key={p.id} post={p} isOwner={false} author={p.author} />
          ))}
        </div>
      )}
    </div>
  );
}

function TabBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 border-b-2 px-4 py-2 text-sm transition ${active ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-primary"}`}
    >
      {icon}{label}
    </button>
  );
}

function BlogCard({
  post: p, isOwner, author, onDelete, onSave,
}: {
  post: any; isOwner: boolean; author?: string;
  onDelete?: () => void;
  onSave?: (vals: { title: string; content: string; tags: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [eTitle, setETitle] = useState(p.title);
  const [eContent, setEContent] = useState(p.content);
  const [eTags, setETags] = useState((p.tags ?? []).join(", "));

  const preview = p.content.length > 220 ? p.content.slice(0, 220).trimEnd() + "…" : p.content;

  const startEdit = () => {
    setETitle(p.title); setEContent(p.content); setETags((p.tags ?? []).join(", "));
    setEditing(true); setOpen(true);
  };

  if (editing) {
    return (
      <article className="paper-card space-y-3 p-6">
        <input value={eTitle} onChange={(e) => setETitle(e.target.value)}
          className="w-full bg-transparent font-serif text-2xl outline-none" />
        <input value={eTags} onChange={(e) => setETags(e.target.value)} placeholder="tags, separated, by, commas"
          className="w-full bg-transparent text-sm text-accent outline-none" />
        <textarea value={eContent} onChange={(e) => setEContent(e.target.value)} rows={10}
          className="w-full resize-none bg-transparent leading-relaxed outline-none" />
        <div className="flex justify-end gap-2">
          <button onClick={() => setEditing(false)} className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm">
            <X className="size-4" /> Cancel
          </button>
          <button
            onClick={() => { onSave?.({ title: eTitle, content: eContent, tags: eTags }); setEditing(false); }}
            className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
          >
            <Check className="size-4" /> Save
          </button>
        </div>
      </article>
    );
  }

  return (
    <article className="paper-card p-6">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3">
        <button onClick={() => setOpen((o) => !o)} className="min-w-0 text-left font-serif text-2xl text-primary hover:underline underline-offset-4">
          <span className="break-words">{p.title}</span>
        </button>
        <div className="flex shrink-0 items-center gap-3">
          <span className="font-hand text-sepia">{new Date(p.created_at).toLocaleDateString()}</span>
          {isOwner && (
            <>
              <button onClick={startEdit} className="text-muted-foreground hover:text-primary" aria-label="Edit">
                <Pencil className="size-4" />
              </button>
              <button onClick={onDelete} className="text-muted-foreground hover:text-destructive" aria-label="Delete">
                <Trash2 className="size-4" />
              </button>
            </>
          )}
        </div>
      </header>
      {author && <p className="mt-1 text-sm text-accent">by {author}</p>}
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
