import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useState } from "react";
import { BookOpen, NotebookPen } from "lucide-react";

export const Route = createFileRoute("/app/foryou")({
  component: ForYouPage,
});

type Tab = "blogs" | "diaries";

function ForYouPage() {
  const { user } = Route.useRouteContext();
  const [tab, setTab] = useState<Tab>("blogs");

  return (
    <div className="space-y-8">
      <div>
        <p className="font-hand text-2xl text-sepia">stories from the community</p>
        <h1 className="font-serif text-4xl text-primary">For You</h1>
      </div>

      <div className="flex gap-2 border-b border-border">
        <TabBtn active={tab === "blogs"} onClick={() => setTab("blogs")} icon={<BookOpen className="size-4" />} label="Blogs" />
        <TabBtn active={tab === "diaries"} onClick={() => setTab("diaries")} icon={<NotebookPen className="size-4" />} label="Diaries" />
      </div>

      {tab === "blogs" ? <BlogsFeed selfId={user.id} /> : <DiariesFeed selfId={user.id} />}
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

function BlogsFeed({ selfId }: { selfId: string }) {
  const q = useQuery({
    queryKey: ["foryou-blogs"],
    queryFn: async () => {
      const { data: posts, error } = await supabase.from("blog_posts").select("*")
        .neq("user_id", selfId).order("created_at", { ascending: false }).limit(50);
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

  if (q.isLoading) return <p className="text-muted-foreground">Loading stories...</p>;
  if (!q.data?.length) return <p className="text-muted-foreground">No blog posts from others yet.</p>;

  return (
    <div className="space-y-4">
      {q.data.map((p) => (
        <article key={p.id} className="paper-card p-6">
          <header className="flex items-baseline justify-between">
            <h3 className="font-serif text-2xl text-primary">{p.title}</h3>
            <span className="font-hand text-sepia">{new Date(p.created_at).toLocaleDateString()}</span>
          </header>
          <p className="mt-1 text-sm text-accent">by {p.author}</p>
          {p.tags && p.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {p.tags.map((t: string) => <span key={t} className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">#{t}</span>)}
            </div>
          )}
          <p className="mt-3 whitespace-pre-wrap leading-relaxed">{p.content}</p>
        </article>
      ))}
    </div>
  );
}

function DiariesFeed({ selfId }: { selfId: string }) {
  const q = useQuery({
    queryKey: ["foryou-diaries"],
    queryFn: async () => {
      const { data, error } = await supabase.from("diary_entries")
        .select("id, title, content, mood, entry_date, created_at, image_path")
        .neq("user_id", selfId).order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      const rows = data ?? [];
      const withUrls = await Promise.all(rows.map(async (e) => {
        if (!e.image_path) return { ...e, image_url: null as string | null };
        const { data: signed } = await supabase.storage.from("gallery").createSignedUrl(e.image_path, 60 * 60);
        return { ...e, image_url: signed?.signedUrl ?? null };
      }));
      return withUrls;
    },
  });

  if (q.isLoading) return <p className="text-muted-foreground">Loading whispers...</p>;
  if (!q.data?.length) return <p className="text-muted-foreground">No diary entries from others yet.</p>;

  return (
    <div className="space-y-4">
      {q.data.map((e) => (
        <article key={e.id} className="paper-card p-6">
          <header className="flex items-baseline justify-between">
            <h3 className="font-hand text-2xl text-sepia">notes from a stranger</h3>
            <span className="font-hand text-sepia">{new Date(e.entry_date).toLocaleDateString(undefined, { month: "long", day: "numeric" })}</span>
          </header>
          {e.title && <p className="mt-2 font-serif text-xl text-primary">{e.title}</p>}
          {e.mood && <p className="mt-1 text-sm text-accent">Feeling: {e.mood}</p>}
          <p className="mt-3 whitespace-pre-wrap leading-relaxed">{e.content}</p>
          {e.image_url && (
            <img src={e.image_url} alt="" className="mt-4 max-h-96 rounded-md border border-border" loading="lazy" />
          )}
        </article>
      ))}
    </div>
  );
}
