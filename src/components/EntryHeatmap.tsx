import { memo, useMemo, useState } from "react";
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
const DAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];

const LEVEL_CLASSES = [
  "bg-secondary/75 dark:bg-secondary/45 border border-border/40",
  "bg-[oklch(0.83_0.085_64)] dark:bg-[oklch(0.36_0.065_56)]",
  "bg-[oklch(0.71_0.115_56)] dark:bg-[oklch(0.49_0.095_58)]",
  "bg-[oklch(0.57_0.115_46)] dark:bg-[oklch(0.64_0.115_62)]",
  "bg-primary dark:bg-[oklch(0.78_0.125_66)]",
] as const;

function getIntensityLevel(count: number, maxCount: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (maxCount <= 1) return 4;
  const ratio = count / maxCount;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

function formatReadableDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export const EntryHeatmap = memo(function EntryHeatmap({ userId }: { userId: string }) {
  const now = new Date();
  const year = now.getFullYear();
  const todayIso = isoDay(now);
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const [activeDayIso, setActiveDayIso] = useState<string | null>(null);

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

  const { counts, totalEntries, activeDays } = useMemo(() => {
    const map = new Map<string, number>();
    let total = 0;
    for (const d of diary.data ?? []) {
      if (d.entry_date >= yearStart && d.entry_date <= yearEnd) {
        map.set(d.entry_date, (map.get(d.entry_date) ?? 0) + 1);
        total++;
      }
    }
    for (const d of otherActivity.data?.blog ?? []) {
      map.set(d, (map.get(d) ?? 0) + 1);
      total++;
    }
    for (const d of otherActivity.data?.notes ?? []) {
      map.set(d, (map.get(d) ?? 0) + 1);
      total++;
    }
    return { counts: map, totalEntries: total, activeDays: map.size };
  }, [diary.data, otherActivity.data, yearStart, yearEnd]);

  const weeks = useMemo(() => getYearGrid(year), [year]);
  const maxCount = Math.max(1, ...Array.from(counts.values()));

  const monthColLabels = useMemo(() => {
    const seen = new Set<number>();
    return weeks.map((week) => {
      const firstOfMonthDay = week.find((d) => d.getFullYear() === year && d.getDate() <= 7);
      if (!firstOfMonthDay) return "";
      const m = firstOfMonthDay.getMonth();
      if (seen.has(m)) return "";
      seen.add(m);
      return MONTHS[m];
    });
  }, [weeks, year]);

  // Split weeks into H1 (Jan–Jun) and H2 (Jul–Dec) for clean 2-row mobile layout without horizontal scrolling
  const { firstHalfWeeks, secondHalfWeeks } = useMemo(() => {
    const splitIndex = Math.ceil(weeks.length / 2);
    return {
      firstHalfWeeks: weeks.slice(0, splitIndex).map((w, idx) => ({ week: w, wi: idx })),
      secondHalfWeeks: weeks.slice(splitIndex).map((w, idx) => ({ week: w, wi: splitIndex + idx })),
    };
  }, [weeks]);

  const inspectedIso = activeDayIso ?? todayIso;
  const inspectedCount = counts.get(inspectedIso) ?? 0;

  return (
    <div className="paper-card p-5 sm:p-6">
      {/* Header Row */}
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border/60 pb-3.5">
        <div>
          <div className="flex items-baseline gap-2.5">
            <h3 className="font-serif text-xl text-primary sm:text-2xl">Your year in writing</h3>
            <span className="font-hand text-lg text-sepia">{year}</span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
            <span>
              {totalEntries} {totalEntries === 1 ? "entry" : "entries"}
            </span>
            <span className="mx-1.5" aria-hidden="true">
              ·
            </span>
            <span>
              {activeDays} active {activeDays === 1 ? "day" : "days"}
            </span>
          </p>
        </div>

        {/* Active / Hovered Day Readout */}
        <div className="text-xs text-muted-foreground tabular-nums">
          <span className="font-medium text-foreground">{formatReadableDay(inspectedIso)}</span>
          <span className="mx-1.5" aria-hidden="true">
            ·
          </span>
          <span className={inspectedCount > 0 ? "font-medium text-primary" : ""}>
            {inspectedCount} {inspectedCount === 1 ? "entry" : "entries"}
          </span>
        </div>
      </div>

      {/* Desktop / Tablet Full-Year Matrix (Zero Scrollbar, Edge-to-Edge Proportional Grid) */}
      <div className="mt-4 hidden md:block" onMouseLeave={() => setActiveDayIso(null)}>
        {/* Month Headers */}
        <div
          className="mb-1.5 grid items-center gap-[3px]"
          style={{
            gridTemplateColumns: `26px repeat(${weeks.length}, minmax(0, 1fr))`,
          }}
        >
          <div />
          {weeks.map((_, wi) => (
            <div
              key={wi}
              className="text-[10px] font-medium leading-none text-muted-foreground select-none"
            >
              {monthColLabels[wi]}
            </div>
          ))}
        </div>

        {/* 7 Weekday Rows x 53 Week Columns */}
        <div className="space-y-[3px]">
          {Array.from({ length: 7 }).map((_, dayIdx) => (
            <div
              key={dayIdx}
              className="grid items-center gap-[3px]"
              style={{
                gridTemplateColumns: `26px repeat(${weeks.length}, minmax(0, 1fr))`,
              }}
            >
              <div className="pr-1.5 text-right text-[10px] leading-none text-muted-foreground/80 select-none">
                {DAY_LABELS[dayIdx]}
              </div>
              {weeks.map((week, wi) => {
                const day = week[dayIdx];
                const inYear = day.getFullYear() === year;
                if (!inYear) {
                  return <div key={wi} className="aspect-square w-full rounded-[3px] opacity-0" />;
                }
                const key = isoDay(day);
                const c = counts.get(key) ?? 0;
                const lvl = getIntensityLevel(c, maxCount);
                const isToday = key === todayIso;
                const isSelected = key === activeDayIso;
                return (
                  <button
                    key={wi}
                    type="button"
                    onMouseEnter={() => setActiveDayIso(key)}
                    onFocus={() => setActiveDayIso(key)}
                    onClick={() => setActiveDayIso(key)}
                    aria-label={`${formatReadableDay(key)}: ${c} ${c === 1 ? "entry" : "entries"}`}
                    className={`aspect-square w-full rounded-[3px] transition-transform duration-150 ${LEVEL_CLASSES[lvl]} ${
                      isSelected
                        ? "scale-125 ring-1.5 ring-primary z-10"
                        : isToday
                          ? "ring-1 ring-sepia/80"
                          : "hover:scale-110"
                    }`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Mobile Two-Row Split Matrix (Jan–Jun & Jul–Dec, Zero Horizontal Scrollbar) */}
      <div className="mt-4 space-y-4 md:hidden">
        {[
          { label: "Jan – Jun", slice: firstHalfWeeks },
          { label: "Jul – Dec", slice: secondHalfWeeks },
        ].map(({ label, slice }) => (
          <div key={label} className="space-y-1">
            <div
              className="grid items-center gap-[3px]"
              style={{
                gridTemplateColumns: `repeat(${slice.length}, minmax(0, 1fr))`,
              }}
            >
              {slice.map(({ wi }) => (
                <div
                  key={wi}
                  className="text-[9px] font-medium leading-none text-muted-foreground select-none"
                >
                  {monthColLabels[wi]}
                </div>
              ))}
            </div>

            <div className="space-y-[3px]">
              {Array.from({ length: 7 }).map((_, dayIdx) => (
                <div
                  key={dayIdx}
                  className="grid items-center gap-[3px]"
                  style={{
                    gridTemplateColumns: `repeat(${slice.length}, minmax(0, 1fr))`,
                  }}
                >
                  {slice.map(({ week, wi }) => {
                    const day = week[dayIdx];
                    const inYear = day.getFullYear() === year;
                    if (!inYear) {
                      return (
                        <div key={wi} className="aspect-square w-full rounded-[2px] opacity-0" />
                      );
                    }
                    const key = isoDay(day);
                    const c = counts.get(key) ?? 0;
                    const lvl = getIntensityLevel(c, maxCount);
                    const isToday = key === todayIso;
                    const isSelected = key === activeDayIso;
                    return (
                      <button
                        key={wi}
                        type="button"
                        onClick={() => setActiveDayIso(key)}
                        aria-label={`${formatReadableDay(key)}: ${c} ${c === 1 ? "entry" : "entries"}`}
                        className={`aspect-square w-full rounded-[2px] ${LEVEL_CLASSES[lvl]} ${
                          isSelected
                            ? "ring-1.5 ring-primary z-10"
                            : isToday
                              ? "ring-1 ring-sepia/80"
                              : ""
                        }`}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Footer Legend */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-3 text-[11px] text-muted-foreground">
        <span>Diary · Notes · Blog</span>
        <div className="flex items-center gap-1.5">
          <span>Less</span>
          {LEVEL_CLASSES.map((cls, idx) => (
            <span key={idx} className={`size-2.5 rounded-[2px] ${cls}`} aria-hidden="true" />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
});
