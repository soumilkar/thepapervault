import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
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
