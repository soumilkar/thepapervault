import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

function getLast52Weeks(): Date[] {
  const days: Date[] = [];
  const today = new Date();
  // Align to Sunday
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay() - 52 * 7 + 1);
  start.setHours(0, 0, 0, 0);
  for (let i = 0; i < 52 * 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(d);
  }
  return days;
}

function monthLabel(d: Date) {
  return d.toLocaleDateString(undefined, { month: "short" });
}

export function EntryHeatmap({ userId }: { userId: string }) {
  const diary = useQuery({
    queryKey: ["heatmap-diary", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("diary_entries")
        .select("entry_date")
        .eq("user_id", userId);
      if (error) throw error;
      return (data ?? []).map((d) => d.entry_date as string);
    },
  });

  const blog = useQuery({
    queryKey: ["heatmap-blog", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("blog_posts")
        .select("created_at")
        .eq("user_id", userId);
      if (error) throw error;
      return (data ?? []).map((d) => isoDay(new Date(d.created_at as string)));
    },
  });

  const notes = useQuery({
    queryKey: ["heatmap-notes", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notes")
        .select("created_at")
        .eq("user_id", userId);
      if (error) throw error;
      return (data ?? []).map((d) => isoDay(new Date(d.created_at as string)));
    },
  });

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    (diary.data ?? []).forEach((d) => map.set(d, (map.get(d) ?? 0) + 1));
    (blog.data ?? []).forEach((d) => map.set(d, (map.get(d) ?? 0) + 1));
    (notes.data ?? []).forEach((d) => map.set(d, (map.get(d) ?? 0) + 1));
    return map;
  }, [diary.data, blog.data, notes.data]);

  const days = getLast52Weeks();
  const weeks: Date[][] = [];
  for (let i = 0; i < days.length; i += 7) {
    weeks.push(days.slice(i, i + 7));
  }

  const maxCount = Math.max(1, ...Array.from(counts.values()));

  const intensity = (c: number) => {
    if (c === 0) return "oklch(0.90 0.02 80 / 0.35)";
    const t = c / maxCount;
    // interpolate toward sepia-accented green
    return `oklch(${0.75 + t * 0.18} ${0.06 + t * 0.12} ${55 + t * 35} / ${0.35 + t * 0.65})`;
  };

  const isLoading = diary.isLoading || blog.isLoading || notes.isLoading;

  return (
    <div className="paper-card p-5 overflow-hidden">
      <div className="flex items-center gap-2 text-accent mb-4">
        <h3 className="font-serif text-xl text-primary">Your year in writing</h3>
      </div>
      <div className="flex items-center gap-2 text-accent mb-4">
        <h3 className="font-serif text-xl text-primary">Your year in writing</h3>
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">gathering days...</p>
      ) : counts.size === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet. Every blank square is waiting for you.</p>
      ) : (
        <div className="overflow-x-auto">
          <div className="flex gap-1 min-w-max">
            {/* Month labels */}
            <div className="flex flex-col gap-1 mr-2">
              <div className="h-3" />
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="h-3 w-8 text-[9px] text-muted-foreground text-right leading-3">
                  {i === 1 ? "Mon" : i === 3 ? "Wed" : i === 5 ? "Fri" : ""}
                </div>
              ))}
            </div>
            {weeks.map((week, wi) => {
              const firstDay = week[0];
              const showMonth = firstDay.getDate() <= 7;
              return (
                <div key={wi} className="flex flex-col gap-1">
                  {showMonth && (
                    <div className="h-3 text-[9px] text-muted-foreground leading-3">{monthLabel(firstDay)}</div>
                  )}
                  {!showMonth && <div className="h-3" />}
                  {week.map((day, di) => {
                    const key = isoDay(day);
                    const c = counts.get(key) ?? 0;
                    return (
                      <div
                        key={di}
                        title={`${key} — ${c} entries`}
                        className="h-3 w-3 rounded-sm"
                        style={{ backgroundColor: intensity(c) }}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
