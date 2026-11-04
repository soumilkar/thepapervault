import { memo, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useDiaryMetrics } from "@/lib/diary-metrics";

function isoDay(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getYearGrid(year: number) {
  const jan1 = new Date(year, 0, 1);
  const dec31 = new Date(year, 11, 31);
  const start = new Date(jan1);
  start.setDate(jan1.getDate() - jan1.getDay());
  const end = new Date(dec31);
  end.setDate(dec31.getDate() + (6 - dec31.getDay()));

  const weeks: Date[][] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const EntryHeatmap = memo(function EntryHeatmap({ userId }: { userId: string }) {
  const year = new Date().getFullYear();
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const diary = useDiaryMetrics(userId);

  const otherActivity = useQuery({
    queryKey: ["heatmap-activity", userId, year],
    queryFn: async () => {
      const [b, n] = await Promise.all([
        supabase
          .from("blog_posts")
          .select("created_at")
          .eq("user_id", userId)
          .gte("created_at", `${yearStart}T00:00:00Z`)
          .lte("created_at", `${yearEnd}T23:59:59Z`),
        supabase
          .from("notes")
          .select("created_at")
          .eq("user_id", userId)
          .gte("created_at", `${yearStart}T00:00:00Z`)
          .lte("created_at", `${yearEnd}T23:59:59Z`),
      ]);
      return {
        blog: (b.data ?? []).map((d) => isoDay(new Date(d.created_at as string))),
        notes: (n.data ?? []).map((d) => isoDay(new Date(d.created_at as string))),
      };
    },
  });

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of diary.data ?? []) {
      if (d.entry_date >= yearStart && d.entry_date <= yearEnd) {
        map.set(d.entry_date, (map.get(d.entry_date) ?? 0) + 1);
      }
    }
    for (const d of otherActivity.data?.blog ?? []) {
      map.set(d, (map.get(d) ?? 0) + 1);
    }
    for (const d of otherActivity.data?.notes ?? []) {
      map.set(d, (map.get(d) ?? 0) + 1);
    }
    return map;
  }, [diary.data, otherActivity.data, yearStart, yearEnd]);

  const weeks = useMemo(() => getYearGrid(year), [year]);
  const maxCount = Math.max(1, ...Array.from(counts.values()));

  const intensity = (c: number, inYear: boolean) => {
    if (!inYear) return "transparent";
    if (c === 0) return "oklch(0.90 0.02 80 / 0.35)";
    const t = c / maxCount;
    return `oklch(${0.75 + t * 0.18} ${0.06 + t * 0.12} ${55 + t * 35} / ${0.35 + t * 0.65})`;
  };

  const monthColLabels = useMemo(() => {
    const seen = new Set<number>();
    return weeks.map((week) => {
      const first = week[0];
      if (first.getFullYear() !== year) return "";
      const m = first.getMonth();
      if (seen.has(m)) return "";
      const containsFirstOfMonth = week.some(
        (d) => d.getFullYear() === year && d.getDate() <= 7 && d.getMonth() === m,
      );
      if (!containsFirstOfMonth) return "";
      seen.add(m);
      return MONTHS[m];
    });
  }, [weeks, year]);

  const isLoading = diary.isLoading || otherActivity.isLoading;

  return (
    <div className="paper-card p-5 overflow-hidden">
      <div className="flex items-center justify-between gap-2 text-accent mb-4">
        <h3 className="font-serif text-xl text-primary">Your year in writing</h3>
        <span className="font-hand text-lg text-sepia">{year}</span>
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">gathering days...</p>
      ) : counts.size === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing yet in {year}. Every blank square is waiting for you.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <div className="flex gap-1 min-w-max">
            <div className="flex flex-col gap-1 mr-2">
              <div className="h-3" />
              {Array.from({ length: 7 }).map((_, i) => (
                <div
                  key={i}
                  className="h-3 w-8 text-[9px] text-muted-foreground text-right leading-3"
                >
                  {i === 1 ? "Mon" : i === 3 ? "Wed" : i === 5 ? "Fri" : ""}
                </div>
              ))}
            </div>
            {weeks.map((week, wi) => (
              <div key={wi} className="flex flex-col gap-1">
                <div className="h-3 text-[9px] text-muted-foreground leading-3">
                  {monthColLabels[wi]}
                </div>
                {week.map((day, di) => {
                  const inYear = day.getFullYear() === year;
                  const key = isoDay(day);
                  const c = inYear ? (counts.get(key) ?? 0) : 0;
                  return (
                    <div
                      key={di}
                      title={inYear ? `${key} — ${c} ${c === 1 ? "entry" : "entries"}` : ""}
                      className="h-3 w-3 rounded-sm"
                      style={{ backgroundColor: intensity(c, inYear) }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});
