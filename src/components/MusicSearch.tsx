import { useEffect, useRef, useState } from "react";
import { Music, Search, X } from "lucide-react";

export type SelectedTrack = {
  music_track_id: string;
  music_track_name: string;
  music_artist: string;
  music_preview_url: string;
  music_artwork_url: string;
};

type Result = {
  trackId: number;
  trackName: string;
  artistName: string;
  previewUrl: string;
  artworkUrl100: string;
};

export function MusicSearch({
  selected, onChange,
}: { selected: SelectedTrack | null; onChange: (t: SelectedTrack | null) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debounce = useRef<number | null>(null);

  useEffect(() => {
    if (debounce.current) window.clearTimeout(debounce.current);
    if (!q.trim()) { setResults([]); return; }
    debounce.current = window.setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`https://itunes.apple.com/search?media=music&entity=song&limit=8&term=${encodeURIComponent(q)}`);
        const json = await res.json();
        setResults(json.results ?? []);
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 350);
  }, [q]);

  if (selected) {
    return (
      <div className="flex items-center gap-3 rounded-md border border-border bg-secondary/40 p-2">
        {selected.music_artwork_url && (
          <img src={selected.music_artwork_url} alt="" className="size-10 rounded" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{selected.music_track_name}</p>
          <p className="truncate text-xs text-muted-foreground">{selected.music_artist}</p>
        </div>
        <button type="button" onClick={() => onChange(null)} aria-label="Remove music" className="text-muted-foreground hover:text-destructive">
          <X className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-dashed border-border p-3">
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-2 text-sm text-accent hover:text-primary">
        <Music className="size-4" /> {open ? "Hide music search" : "Add a song (optional)"}
      </button>
      {open && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2 rounded-md border border-input bg-card px-2">
            <Search className="size-4 text-muted-foreground" />
            <input
              value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search songs (e.g. Bon Iver, Skinny Love)"
              className="w-full bg-transparent py-2 text-sm outline-none"
            />
          </div>
          {loading && <p className="text-xs text-muted-foreground">Searching…</p>}
          <ul className="max-h-64 space-y-1 overflow-y-auto">
            {results.map((r) => (
              <li key={r.trackId}>
                <button
                  type="button"
                  onClick={() => {
                    onChange({
                      music_track_id: String(r.trackId),
                      music_track_name: r.trackName,
                      music_artist: r.artistName,
                      music_preview_url: r.previewUrl,
                      music_artwork_url: r.artworkUrl100,
                    });
                    setOpen(false); setQ(""); setResults([]);
                  }}
                  className="flex w-full items-center gap-3 rounded-md p-2 text-left hover:bg-secondary"
                >
                  <img src={r.artworkUrl100} alt="" className="size-10 rounded" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{r.trackName}</p>
                    <p className="truncate text-xs text-muted-foreground">{r.artistName}</p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Powered by iTunes Search — 30-second previews.</p>
        </div>
      )}
    </div>
  );
}

export function MusicPlayer({ track }: {
  track: { music_track_name: string | null; music_artist: string | null; music_preview_url: string | null; music_artwork_url: string | null } }) {
  if (!track.music_preview_url) return null;
  return (
    <div className="mt-3 flex items-center gap-3 rounded-md border border-border bg-secondary/40 p-2">
      {track.music_artwork_url && <img src={track.music_artwork_url} alt="" className="size-12 rounded" />}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{track.music_track_name}</p>
        <p className="truncate text-xs text-muted-foreground">{track.music_artist}</p>
        <audio controls src={track.music_preview_url} className="mt-1 w-full" preload="none" />
      </div>
    </div>
  );
}
