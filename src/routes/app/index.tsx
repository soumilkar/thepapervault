import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BookOpen, Image as ImageIcon, PenLine, Sparkles, Users } from "lucide-react";
import { WelcomeTour } from "@/components/WelcomeTour";
import { Markdown } from "@/components/Markdown";
import { MusicPlayer } from "@/components/MusicSearch";

export const Route = createFileRoute("/app/")({
  component: Dashboard,
});

type PublicDiary = {
  id: string; title: string | null; content: string; mood: string | null; entry_date: string;
  music_track_name: string | null; music_artist: string | null;
  music_preview_url: string | null; music_artwork_url: string | null;
};

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

  const feed = useQuery({
    queryKey: ["public-diary-feed"],
    queryFn: async (): Promise<PublicDiary[]> => {
      const { data, error } = await supabase.from("diary_entries")
        .select("id,title,content,mood,entry_date,music_track_name,music_artist,music_preview_url,music_artwork_url" as never)
        .eq("is_public", true).neq("user_id", user.id)
        .order("entry_date", { ascending: false }).limit(40);
      if (error) throw error;
      return (data ?? []) as unknown as PublicDiary[];
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
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">writers here</div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard to="/app/diary" icon={<PenLine className="size-5" />} label="Your diary entries" value={counts.data?.diary ?? 0} />
        <StatCard to="/app/blog" icon={<BookOpen className="size-5" />} label="Your blog posts" value={counts.data?.blog ?? 0} />
        <StatCard to="/app/gallery" icon={<ImageIcon className="size-5" />} label="Your gallery photos" value={counts.data?.gallery ?? 0} />
        <StatCard to="/app/chat" icon={<Sparkles className="size-5" />} label="Talk to companion" value="→" />
      </div>

      <section className="space-y-4">
        <div>
          <p className="font-hand text-2xl text-sepia">shared, softly</p>
          <h2 className="font-serif text-3xl text-primary">Notes from strangers</h2>
          <p className="mt-1 text-sm text-muted-foreground">Anonymous public diary entries from the community.</p>
        </div>
        <div className="space-y-4">
          {feed.isLoading && <p className="font-hand text-sepia">listening for strangers...</p>}
          {feed.data?.length === 0 && <p className="text-muted-foreground">No public entries yet. Be the first from your Diary tab.</p>}
          {feed.data?.map((e) => <FeedCard key={e.id} entry={e} />)}
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

function FeedCard({ entry: e }: { entry: PublicDiary }) {
  const [open, setOpen] = useState(false);
  const long = e.content.length > 220;
  const preview = long ? e.content.slice(0, 220).trimEnd() + "…" : e.content;
  return (
    <article className="paper-card p-6">
      <header className="flex items-baseline justify-between gap-3">
        <button onClick={() => setOpen((o) => !o)} className="text-left font-serif text-xl text-primary hover:underline underline-offset-4">
          {e.title || "Untitled"}
        </button>
        <span className="font-hand text-sepia">{new Date(e.entry_date).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}</span>
      </header>
      <p className="mt-1 text-sm text-accent">notes from a stranger{e.mood ? ` · feeling ${e.mood}` : ""}</p>
      {open ? <Markdown>{e.content}</Markdown> : <p className="mt-3 whitespace-pre-wrap leading-relaxed">{preview}</p>}
      {e.music_preview_url && (
        <MusicPlayer track={{
          music_track_name: e.music_track_name, music_artist: e.music_artist,
          music_preview_url: e.music_preview_url, music_artwork_url: e.music_artwork_url,
        }} />
      )}
      {long && (
        <button onClick={() => setOpen((o) => !o)} className="mt-2 text-sm text-accent hover:text-primary">
          {open ? "Show less" : "Read more"}
        </button>
      )}
    </article>
  );
}
