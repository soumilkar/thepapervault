import { memo, useMemo, useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { CloudRain, Cloud, Minus, Sun, Sparkles, Plus, Trash2 } from "lucide-react";
import { useVaultTrackers, type MoodLevel } from "@/lib/vault-trackers";

const MOOD_LEVELS: {
  level: MoodLevel;
  label: string;
  color: string;
  icon: typeof Sun;
}[] = [
  { level: 1, label: "Heavy", color: "oklch(0.55 0.14 25)", icon: CloudRain },
  { level: 2, label: "Uneasy", color: "oklch(0.62 0.12 50)", icon: Cloud },
  { level: 3, label: "Steady", color: "oklch(0.65 0.08 85)", icon: Minus },
  { level: 4, label: "Warm", color: "oklch(0.68 0.13 135)", icon: Sun },
  { level: 5, label: "Radiant", color: "oklch(0.72 0.15 75)", icon: Sparkles },
];

function moodMeta(level: MoodLevel) {
  return MOOD_LEVELS.find((m) => m.level === level) ?? MOOD_LEVELS[2];
}

function isoToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export const MoodTracker = memo(function MoodTracker({ userId }: { userId: string }) {
  const { data, isLoading, updateTrackers } = useVaultTrackers(userId);
  const [selectedLevel, setSelectedLevel] = useState<MoodLevel>(4);
  const [note, setNote] = useState("");
  const [date, setDate] = useState<string>(isoToday);

  const sortedMoods = useMemo(() => {
    return [...(data.moods ?? [])].sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.created_at.localeCompare(b.created_at);
    });
  }, [data.moods]);

  const chartData = useMemo(() => {
    return sortedMoods.slice(-30).map((m) => {
      const meta = moodMeta(m.level);
      return {
        id: m.id,
        date: new Date(`${m.date}T00:00:00`).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        }),
        score: m.level,
        label: meta.label,
        note: m.note,
      };
    });
  }, [sortedMoods]);

  const recentLogs = useMemo(() => {
    return [...sortedMoods].reverse().slice(0, 5);
  }, [sortedMoods]);

  const logMood = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanNote = note.trim();
    const targetDate = date || isoToday();
    updateTrackers((prev) => {
      const existingIdx = prev.moods.findIndex((m) => m.date === targetDate);
      const entry = {
        id: existingIdx >= 0 ? prev.moods[existingIdx].id : crypto.randomUUID(),
        date: targetDate,
        level: selectedLevel,
        note: cleanNote,
        created_at: new Date().toISOString(),
      };
      const nextMoods =
        existingIdx >= 0
          ? prev.moods.map((m, i) => (i === existingIdx ? entry : m))
          : [...prev.moods, entry];
      return {
        ...prev,
        moods: nextMoods,
      };
    });
    setNote("");
  };

  const removeMood = (id: string) => {
    updateTrackers((prev) => ({
      ...prev,
      moods: prev.moods.filter((m) => m.id !== id),
    }));
  };

  return (
    <div className="paper-card flex h-full flex-col justify-between p-5 overflow-hidden">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="font-serif text-xl text-primary">Mood tracker</h3>
            <p className="text-xs text-muted-foreground">Log how you feel day by day</p>
          </div>
          <span className="font-hand text-lg text-sepia">{moodMeta(selectedLevel).label}</span>
        </div>

        <form onSubmit={logMood} className="space-y-3 rounded-lg bg-secondary/35 p-3">
          <div className="grid grid-cols-5 gap-1.5">
            {MOOD_LEVELS.map((m) => {
              const Icon = m.icon;
              const active = selectedLevel === m.level;
              return (
                <button
                  key={m.level}
                  type="button"
                  onClick={() => setSelectedLevel(m.level)}
                  className={`flex flex-col items-center gap-1 rounded-md border px-2 py-2 text-xs transition ${
                    active
                      ? "border-primary bg-primary text-primary-foreground shadow-sm"
                      : "border-border/70 bg-card/70 text-foreground/80 hover:bg-secondary"
                  }`}
                >
                  <Icon className="size-4" />
                  <span className="truncate text-[11px] font-medium">{m.label}</span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              value={date}
              max={isoToday()}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-md border border-input bg-card px-2.5 py-1.5 text-xs outline-none focus:border-ring"
            />
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Short note"
              className="min-w-0 flex-1 rounded-md border border-input bg-card px-2.5 py-1.5 text-xs outline-none focus:border-ring"
            />
            <button
              type="submit"
              className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:opacity-90"
            >
              <Plus className="size-3.5" /> Log
            </button>
          </div>
        </form>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">loading mood logs...</p>
        ) : chartData.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No moods logged yet. Check in above to start tracking your rhythm.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="h-44 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 6, right: 10, left: -16, bottom: 0 }}>
                  <defs>
                    <linearGradient id="moodTrackerGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="var(--accent)" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                    interval="preserveStartEnd"
                    minTickGap={20}
                  />
                  <YAxis
                    domain={[0.5, 5.5]}
                    ticks={[1, 2, 3, 4, 5]}
                    tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                    tickFormatter={(v) => moodMeta(v as MoodLevel).label}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--card)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius)",
                      fontSize: 12,
                      color: "var(--foreground)",
                    }}
                    formatter={(_, __, props: any) => {
                      const p = props?.payload;
                      if (!p) return [];
                      return [p.note ? `${p.label} — ${p.note}` : p.label, "Mood"];
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="score"
                    stroke="var(--accent)"
                    strokeWidth={2}
                    fill="url(#moodTrackerGrad)"
                    dot={({ cx, cy, payload }: any) => {
                      const color = moodMeta(payload.score as MoodLevel).color;
                      return (
                        <circle
                          key={`${cx}-${cy}`}
                          cx={cx}
                          cy={cy}
                          r={4}
                          fill={color}
                          stroke="var(--card)"
                          strokeWidth={1.5}
                        />
                      );
                    }}
                    activeDot={{ r: 6, stroke: "var(--card)", strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <ul className="space-y-1.5 border-t border-border/60 pt-2">
              {recentLogs.map((m) => {
                const meta = moodMeta(m.level);
                const Icon = meta.icon;
                return (
                  <li
                    key={m.id}
                    className="flex items-center justify-between gap-2 rounded-md bg-secondary/25 px-2.5 py-1.5 text-xs"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Icon className="size-3.5 shrink-0 text-accent" />
                      <span className="font-medium text-primary">{meta.label}</span>
                      <span className="text-muted-foreground">{m.date}</span>
                      {m.note && <span className="truncate text-foreground/80">· {m.note}</span>}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeMood(m.id)}
                      aria-label="Delete mood log"
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
});
