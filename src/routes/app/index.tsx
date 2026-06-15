import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { BookOpen, Image as ImageIcon, PenLine, Sparkles } from "lucide-react";

export const Route = createFileRoute("/app/")({
  component: Dashboard,
});

function Dashboard() {
  const { user } = Route.useRouteContext();

  const counts = useQuery({
    queryKey: ["dashboard-counts", user.id],
    queryFn: async () => {
      const [d, b, g] = await Promise.all([
        supabase.from("diary_entries").select("id", { count: "exact", head: true }),
        supabase.from("blog_posts").select("id", { count: "exact", head: true }),
        supabase.from("gallery_images").select("id", { count: "exact", head: true }),
      ]);
      return { diary: d.count ?? 0, blog: b.count ?? 0, gallery: g.count ?? 0 };
    },
  });

  const recent = useQuery({
    queryKey: ["recent-diary", user.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("diary_entries")
        .select("id, title, content, entry_date, mood")
        .order("created_at", { ascending: false })
        .limit(3);
      return data ?? [];
    },
  });

  const name = user.user_metadata?.display_name || user.email?.split("@")[0] || "friend";

  return (
    <div className="space-y-10">
      <div>
        <p className="font-hand text-2xl text-sepia">hello again</p>
        <h1 className="font-serif text-5xl text-primary">Welcome back, {name}.</h1>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard to="/app/diary" icon={<PenLine className="size-5" />} label="Diary entries" value={counts.data?.diary ?? 0} />
        <StatCard to="/app/blog" icon={<BookOpen className="size-5" />} label="Blog posts" value={counts.data?.blog ?? 0} />
        <StatCard to="/app/gallery" icon={<ImageIcon className="size-5" />} label="Gallery photos" value={counts.data?.gallery ?? 0} />
        <StatCard to="/app/chat" icon={<Sparkles className="size-5" />} label="Talk to companion" value="→" />
      </div>

      <section>
        <h2 className="font-serif text-2xl text-primary">Recent diary entries</h2>
        <div className="mt-4 space-y-3">
          {recent.data?.length === 0 && (
            <p className="text-muted-foreground">No entries yet. <Link to="/app/diary" className="text-primary underline">Write your first one</Link>.</p>
          )}
          {recent.data?.map((e) => (
            <div key={e.id} className="paper-card p-5">
              <div className="flex items-baseline justify-between">
                <h3 className="font-serif text-xl">{e.title || "Untitled"}</h3>
                <span className="font-hand text-sepia">{new Date(e.entry_date).toLocaleDateString()}</span>
              </div>
              {e.mood && <p className="mt-1 text-sm text-accent">Feeling: {e.mood}</p>}
              <p className="mt-2 line-clamp-2 text-muted-foreground">{e.content}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function StatCard({ to, icon, label, value }: { to: string; icon: React.ReactNode; label: string; value: number | string }) {
  return (
    <Link to={to} className="paper-card block p-5 transition hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-center gap-2 text-accent">{icon}<span className="text-sm text-muted-foreground">{label}</span></div>
      <div className="mt-2 font-serif text-3xl text-primary">{value}</div>
    </Link>
  );
}
