import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { moodLabel, moodColor } from "@/lib/mood-sentiment";

export function MoodTimeline({ userId }: { userId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["mood-timeline", userId],
    refetchOnMount: "always",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("diary_entries")
        .select("entry_date,mood_score")
        .eq("user_id", userId)
        .not("mood_score", "is", null)
        .order("entry_date", { ascending: true })
        .limit(90);
      if (error) throw error;
      return (data ?? []) as { entry_date: string; mood_score: number }[];
    },
  });

  const chartData = useMemo(() => {
    if (!data?.length) return [];
    return data.map((d) => ({
      date: new Date(d.entry_date).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      score: d.mood_score,
      label: moodLabel(d.mood_score),
      fullDate: d.entry_date,
    }));
  }, [data]);

  const hasMoods = chartData.length > 0;

  return (
    <div className="paper-card p-5 overflow-hidden">
      <div className="flex items-center gap-2 text-accent mb-4">
        <h3 className="font-serif text-xl text-primary">Mood over time</h3>
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">reading between the lines...</p>
      ) : !hasMoods ? (
        <p className="text-sm text-muted-foreground">Add moods to your diary entries and a chart will appear here.</p>
      ) : (
        <div className="space-y-3">
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="moodGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="var(--accent)" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} interval="preserveStartEnd" minTickGap={20} />
                <YAxis domain={[0.5, 5.5]} tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} ticks={[1, 2, 3, 4, 5]} tickFormatter={(v) => moodLabel(v)} />
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
                    return [p.label, "mood"];
                  }}
                  labelFormatter={(label) => label}
                />
                <Area
                  type="monotone"
                  dataKey="score"
                  stroke="var(--accent)"
                  strokeWidth={2}
                  fill="url(#moodGrad)"
                  dot={({ cx, cy, payload }: any) => {
                    const color = moodColor(payload.score);
                    return <circle cx={cx} cy={cy} r={4} fill={color} stroke="var(--card)" strokeWidth={1.5} />;
                  }}
                  activeDot={{ r: 6, stroke: "var(--card)", strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs text-muted-foreground">
            Showing the last {chartData.length} entries with moods. Hover a dot to see the entry.
          </p>
        </div>
      )}
    </div>
  );
}
