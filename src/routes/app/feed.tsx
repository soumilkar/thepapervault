import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Markdown } from "@/components/Markdown";
import { MusicPlayer } from "@/components/MusicSearch";

export const Route = createFileRoute("/app/feed")({
  component: FeedPage,
});

type PublicDiary = {
  id: string; title: string | null; content: string; mood: string | null; entry_date: string;
  music_track_name: string | null; music_artist: string | null;
  music_preview_url: string | null; music_artwork_url: string | null;
};

function FeedPage() {
  const { user } = Route.useRouteContext();
  const feed = useQuery({
    queryKey: ["public-diary-feed"],
    queryFn: async (): Promise<PublicDiary[]> => {
      const { data, error } = await supabase.from("diary_entries")
        .select("id,title,content,mood,entry_date,music_track_name,music_artist,music_preview_url,music_artwork_url" as never)
        .eq("is_public", true).neq("user_id", user.id)
        .order("entry_date", { ascending: false }).limit(80);
      if (error) throw error;
      return (data ?? []) as unknown as PublicDiary[];
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <p className="font-hand text-2xl text-sepia">shared, softly</p>
        <h1 className="font-serif text-4xl text-primary">Feed</h1>
        <p className="mt-1 text-sm text-muted-foreground">Anonymous diary entries from other writers.</p>
      </div>
      <div className="space-y-4">
        {feed.isLoading && <p className="font-hand text-sepia">listening for strangers...</p>}
        {feed.data?.length === 0 && <p className="text-muted-foreground">No public entries yet. Be the first.</p>}
        {feed.data?.map((e) => <FeedCard key={e.id} entry={e} />)}
      </div>
    </div>
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
