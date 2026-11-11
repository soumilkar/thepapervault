import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { memo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  BookOpen,
  Image as ImageIcon,
  PenLine,
  ShieldCheck,
  Sparkles,
  StickyNote,
  Users,
} from "lucide-react";
import { WelcomeTour } from "@/components/WelcomeTour";
import { Markdown } from "@/components/Markdown";
import { MusicPlayer } from "@/components/MusicSearch";
import { WritingStreaks } from "@/components/WritingStreaks";
import { EntryHeatmap } from "@/components/EntryHeatmap";
import { MoodTracker } from "@/components/MoodTracker";
import { GoalsTracker } from "@/components/GoalsTracker";
import { useDiaryMetrics } from "@/lib/diary-metrics";
import { requestOpenSecurityDialog, type SecurityTab } from "@/components/SecuritySettingsDialog";

export const Route = createFileRoute("/app/")({
  component: Dashboard,
});

type PublicDiary = {
  id: string;
  title: string | null;
  content: string;
  mood: string | null;
  entry_date: string;
  music_track_name: string | null;
  music_artist: string | null;
  music_preview_url: string | null;
  music_artwork_url: string | null;
};

function Dashboard() {
  const { user, profileDisplayName } = Route.useRouteContext();
  const diaryMetrics = useDiaryMetrics(user.id);

  const openSecurityAt = (targetTab: SecurityTab) => {
    requestOpenSecurityDialog(targetTab);
  };

  const profileQuery = useQuery({
    queryKey: ["user-profile", user.id],
    placeholderData: profileDisplayName
      ? { id: user.id, display_name: profileDisplayName }
      : undefined,
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("id, display_name")
        .eq("id", user.id)
        .maybeSingle();
      if (data?.display_name?.trim() && typeof window !== "undefined") {
        try {
          window.localStorage.setItem(
            `papervault:profile_name:${user.id}`,
            data.display_name.trim(),
          );
        } catch {
          // ignore
        }
      }
      return data;
    },
  });

  const counts = useQuery({
    queryKey: ["dashboard-counts", user.id],
    queryFn: async () => {
      const [n, b, g, d, u] = await Promise.all([
        supabase.from("notes").select("id,image_urls").eq("user_id", user.id),
        supabase.from("blog_posts").select("id").eq("user_id", user.id),
        supabase.from("gallery_images").select("id,storage_path").eq("user_id", user.id),
        supabase.from("diary_entries").select("id,image_urls").eq("user_id", user.id),
        supabase.from("profiles").select("id"),
      ]);

      const uniquePhotoPaths = new Set<string>();
      for (const img of (g.data ?? []) as { id: string; storage_path?: string }[]) {
        uniquePhotoPaths.add(img.storage_path || img.id);
      }
      for (const entry of (d.data ?? []) as { image_urls?: string[] | null }[]) {
        for (const p of entry.image_urls ?? []) {
          if (p) uniquePhotoPaths.add(p);
        }
      }
      for (const note of (n.data ?? []) as { image_urls?: string[] | null }[]) {
        for (const p of note.image_urls ?? []) {
          if (p) uniquePhotoPaths.add(p);
        }
      }

      return {
        notes: n.data?.length ?? 0,
        blog: b.data?.length ?? 0,
        gallery: uniquePhotoPaths.size,
        totalUsers: u.data?.length ?? 0,
      };
    },
  });

  const feed = useQuery({
    queryKey: ["public-diary-feed"],
    queryFn: async (): Promise<PublicDiary[]> => {
      const { data, error } = await supabase
        .from("diary_entries")
        .select(
          "id,title,content,mood,entry_date,music_track_name,music_artist,music_preview_url,music_artwork_url" as never,
        )
        .eq("is_public", true)
        .neq("user_id", user.id)
        .order("entry_date", { ascending: false })
        .limit(40);
      if (error) throw error;
      return (data ?? []) as unknown as PublicDiary[];
    },
  });

  const emailPrefix = user.email?.split("@")[0] ?? "";
  const candidates = [
    profileQuery.data?.display_name,
    profileDisplayName,
    user.user_metadata?.display_name as string | undefined,
    user.user_metadata?.full_name as string | undefined,
    user.user_metadata?.name as string | undefined,
  ]
    .map((c) => c?.trim())
    .filter((c): c is string => Boolean(c));

  const nonEmailCandidate = candidates.find((c) => c.toLowerCase() !== emailPrefix.toLowerCase());
  const name = nonEmailCandidate || (profileQuery.isLoading ? "" : "friend");

  return (
    <div className="space-y-10">
      <WelcomeTour userId={user.id} />

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-hand text-2xl text-sepia">hello again</p>
          <h1 className="font-serif text-5xl text-primary">
            Welcome back{name ? `, ${name}` : ""}.
          </h1>
        </div>
        <div className="flex flex-wrap items-stretch gap-3">
          <button
            type="button"
            onClick={() => openSecurityAt("account")}
            className="flex w-[144px] items-center gap-3 rounded-full border border-border bg-card/80 px-4 py-2 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-accent/60 hover:shadow-md"
          >
            <ShieldCheck className="size-5 shrink-0 text-accent" />
            <div className="leading-tight">
              <div className="font-serif text-xl leading-[1.05] text-primary">
                Security &amp; Vault
              </div>
            </div>
          </button>

          <div className="flex w-[144px] items-center gap-3 rounded-full border border-border bg-card/70 px-4 py-2 shadow-sm">
            <Users className="size-5 text-accent" />
            <div className="leading-tight">
              <div className="font-serif text-2xl text-primary">
                {counts.data?.totalUsers ?? "—"}
              </div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                writers here
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          to="/app/diary"
          icon={<PenLine className="size-5" />}
          label="Your diary entries"
          value={diaryMetrics.data?.length ?? 0}
        />
        <StatCard
          to="/app/notes"
          icon={<StickyNote className="size-5" />}
          label="Your notes"
          value={counts.data?.notes ?? 0}
        />
        <StatCard
          to="/app/blog"
          icon={<BookOpen className="size-5" />}
          label="Your blog posts"
          value={counts.data?.blog ?? 0}
        />
        <StatCard
          to="/app/gallery"
          icon={<ImageIcon className="size-5" />}
          label="Your gallery photos"
          value={counts.data?.gallery ?? 0}
        />
        <StatCard
          to="/app/chat"
          icon={<Sparkles className="size-5" />}
          label="Talk to companion"
          value="→"
          className="sm:col-span-2 lg:col-span-1"
        />
      </div>

      <div className="space-y-6">
        <WritingStreaks userId={user.id} />
        <EntryHeatmap userId={user.id} />
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="min-w-0">
            <GoalsTracker userId={user.id} />
          </div>
          <div className="min-w-0">
            <MoodTracker userId={user.id} />
          </div>
        </div>
      </div>

      <section className="space-y-4">
        <div>
          <p className="font-hand text-2xl text-sepia">shared, softly</p>
          <h2 className="font-serif text-3xl text-primary">Notes from strangers</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Anonymous public diary entries from the community.
          </p>
        </div>
        <div className="space-y-4">
          {feed.isLoading && <p className="font-hand text-sepia">listening for strangers...</p>}
          {feed.data?.length === 0 && (
            <p className="text-muted-foreground">
              No public entries yet. Be the first from your Diary tab.
            </p>
          )}
          {feed.data?.map((e) => (
            <FeedCard key={e.id} entry={e} />
          ))}
        </div>
      </section>
    </div>
  );
}

function StatCard({
  to,
  icon,
  label,
  value,
  className = "",
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  value: number | string;
  className?: string;
}) {
  return (
    <Link
      to={to}
      className={`paper-card flex flex-col justify-between p-5 transition hover:-translate-y-0.5 hover:shadow-md min-h-[104px] ${className}`}
    >
      <div className="flex items-center gap-2 text-accent">
        {icon}
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
      </div>
      <div className="mt-2 font-serif text-3xl text-primary tabular-nums">{value}</div>
    </Link>
  );
}

const FeedCard = memo(function FeedCard({ entry: e }: { entry: PublicDiary }) {
  const [open, setOpen] = useState(false);
  const long = e.content.length > 220;
  const preview = long ? e.content.slice(0, 220).trimEnd() + "…" : e.content;
  return (
    <article className="paper-card p-6">
      <header className="flex items-baseline justify-between gap-3">
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-left font-serif text-xl text-primary hover:underline underline-offset-4"
        >
          {e.title || "Untitled"}
        </button>
        <span className="font-hand text-sepia">
          {new Date(e.entry_date).toLocaleDateString(undefined, {
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        </span>
      </header>
      <p className="mt-1 text-sm text-accent">
        notes from a stranger{e.mood ? ` · feeling ${e.mood}` : ""}
      </p>
      {open ? (
        <Markdown>{e.content}</Markdown>
      ) : (
        <p className="mt-3 whitespace-pre-wrap leading-relaxed">{preview}</p>
      )}
      {e.music_preview_url && (
        <MusicPlayer
          track={{
            music_track_name: e.music_track_name,
            music_artist: e.music_artist,
            music_preview_url: e.music_preview_url,
            music_artwork_url: e.music_artwork_url,
          }}
        />
      )}
      {long && (
        <button
          onClick={() => setOpen((o) => !o)}
          className="mt-2 text-sm text-accent hover:text-primary"
        >
          {open ? "Show less" : "Read more"}
        </button>
      )}
    </article>
  );
});
