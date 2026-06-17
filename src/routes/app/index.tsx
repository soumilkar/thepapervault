import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BookOpen, Image as ImageIcon, PenLine, Sparkles, Users } from "lucide-react";
import { WelcomeTour } from "@/components/WelcomeTour";

export const Route = createFileRoute("/app/")({
  component: Dashboard,
});

function Dashboard() {
  const { user } = Route.useRouteContext();

  const counts = useQuery({
    queryKey: ["dashboard-counts", user.id],
    queryFn: async () => {
      const [d, b, g] = await Promise.all([
        supabase.from("diary_entries").select("id", { count: "exact", head: true }).eq("user_id", user.id),
        supabase.from("blog_posts").select("id", { count: "exact", head: true }).eq("user_id", user.id),
        supabase.from("gallery_images").select("id", { count: "exact", head: true }).eq("user_id", user.id),
      ]);
      return { diary: d.count ?? 0, blog: b.count ?? 0, gallery: g.count ?? 0 };
    },
  });

  const totalUsers = useQuery({
    queryKey: ["total-users"],
    queryFn: async () => {
      const { count } = await supabase.from("profiles").select("id", { count: "exact", head: true });
      return count ?? 0;
    },
  });

  const publicDiaries = useQuery({
    queryKey: ["public-diaries"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("diary_entries")
        .select("id, title, content, mood, entry_date, created_at, image_path")
        .eq("visibility", "public_anon")
        .neq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(30);
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

  const name = user.user_metadata?.display_name || user.email?.split("@")[0] || "friend";

  return (
    <div className="space-y-10">
      <WelcomeTour userId={user.id} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-hand text-2xl text-sepia">hello again</p>
          <h1 className="font-serif text-5xl text-primary">Welcome back, {name}.</h1>
        </div>
        <div className="flex items-center gap-3 rounded-full border border-border bg-card/70 px-4 py-2 shadow-sm">
          <Users className="size-5 text-accent" />
          <div className="leading-tight">
            <div className="font-serif text-2xl text-primary">{totalUsers.data ?? "—"}</div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">writers in the vault</div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard to="/app/diary" icon={<PenLine className="size-5" />} label="Your diary entries" value={counts.data?.diary ?? 0} />
        <StatCard to="/app/blog" icon={<BookOpen className="size-5" />} label="Your blog posts" value={counts.data?.blog ?? 0} />
        <StatCard to="/app/gallery" icon={<ImageIcon className="size-5" />} label="Your gallery photos" value={counts.data?.gallery ?? 0} />
        <StatCard to="/app/chat" icon={<Sparkles className="size-5" />} label="Talk to companion" value="→" />
      </div>

      <section>
        <div>
          <p className="font-hand text-xl text-sepia">whispers from the vault</p>
          <h2 className="font-serif text-3xl text-primary">Notes from strangers</h2>
        </div>
        <div className="mt-4 space-y-3">
          {publicDiaries.isLoading && <p className="text-muted-foreground">Loading whispers...</p>}
          {publicDiaries.data?.length === 0 && (
            <p className="text-muted-foreground">No public diary entries yet. Be the first to share one.</p>
          )}
          {publicDiaries.data?.map((e) => <PublicDiaryCard key={e.id} entry={e} />)}
        </div>
      </section>
    </div>
  );
}

function PublicDiaryCard({ entry: e }: { entry: any }) {
  const [open, setOpen] = useState(false);
  const long = e.content.length > 220 || !!e.image_url;
  const preview = e.content.length > 220 ? e.content.slice(0, 220).trimEnd() + "…" : e.content;
  return (
    <article className="paper-card p-6">
      <header className="flex items-baseline justify-between">
        <button onClick={() => setOpen((o) => !o)} className="text-left font-hand text-2xl text-sepia hover:text-primary">
          notes from a stranger
        </button>
        <span className="font-hand text-sepia">{new Date(e.entry_date).toLocaleDateString(undefined, { month: "long", day: "numeric" })}</span>
      </header>
      {e.title && <p className="mt-2 font-serif text-xl text-primary">{e.title}</p>}
      {e.mood && <p className="mt-1 text-sm text-accent">Feeling: {e.mood}</p>}
      <p className="mt-3 whitespace-pre-wrap leading-relaxed">{open ? e.content : preview}</p>
      {open && e.image_url && (
        <img src={e.image_url} alt="" className="mt-4 max-h-96 rounded-md border border-border" loading="lazy" />
      )}
      {long && (
        <button onClick={() => setOpen((o) => !o)} className="mt-2 text-sm text-accent hover:text-primary">
          {open ? "Show less" : "Read more"}
        </button>
      )}
    </article>
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
