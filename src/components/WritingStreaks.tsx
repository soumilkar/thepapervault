import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Flame, Trophy, PenLine, TrendingUp } from "lucide-react";

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

function getStreaks(dates: string[]) {
  const sorted = Array.from(new Set(dates)).sort();
  if (!sorted.length) return { current: 0, longest: 0 };

  let longest = 1;
  let current = 1;
  let run = 1;

  const today = isoDay(new Date());
  const yesterday = isoDay(new Date(Date.now() - 86400000));

  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1]);
    const curr = new Date(sorted[i]);
    const diff = (curr.getTime() - prev.getTime()) / 86400000;
    if (diff === 1) {
      run++;
      longest = Math.max(longest, run);
    } else {
      run = 1;
    }
  }

  // Current streak from today/yesterday backwards
  const last = sorted[sorted.length - 1];
  if (last !== today && last !== yesterday) {
    current = 0;
  } else {
    current = 1;
    for (let i = sorted.length - 2; i >= 0; i--) {
      const a = new Date(sorted[i + 1]);
      const b = new Date(sorted[i]);
      if ((a.getTime() - b.getTime()) / 86400000 === 1) current++;
      else break;
    }
  }

  return { current, longest };
}

function wordCount(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function WritingStreaks({ userId }: { userId: string }) {
  const diary = useQuery({
    queryKey: ["streak-diary", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("diary_entries")
        .select("entry_date,word_count")
        .eq("user_id", userId)
        .order("entry_date", { ascending: true });
      if (error) throw error;
      return (data ?? []) as { entry_date: string; word_count: number | null }[];
    },
  });

  const dates = (diary.data ?? []).map((d) => d.entry_date);
  const streaks = getStreaks(dates);

  const wordsThisMonth = (diary.data ?? []).reduce((sum, d) => {
    const date = new Date(d.entry_date);
    const now = new Date();
    if (date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear()) {
      return sum + (d.word_count ?? 0);
    }
    return sum;
  }, 0);

  const totalWords = (diary.data ?? []).reduce((sum, d) => sum + (d.word_count ?? 0), 0);
  const totalEntries = dates.length;

  const items = [
    { icon: <Flame className="size-5 text-orange-400" />, value: streaks.current, label: "current streak" },
    { icon: <Trophy className="size-5 text-amber-500" />, value: streaks.longest, label: "best streak" },
    { icon: <PenLine className="size-5 text-sepia" />, value: totalEntries, label: "total entries" },
    { icon: <TrendingUp className="size-5 text-green-500" />, value: totalWords.toLocaleString(), label: "words written" },
  ];

  return (
    <div className="paper-card p-5">
      <div className="flex items-center gap-2 text-accent mb-4">
        <Flame className="size-5" />
        <h3 className="font-serif text-xl text-primary">Writing streaks</h3>
      </div>
      {diary.isLoading ? (
        <p className="text-sm text-muted-foreground">crunching numbers...</p>
      ) : totalEntries === 0 ? (
        <p className="text-sm text-muted-foreground">Start writing to see your streaks grow.</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {items.map((it) => (
            <div key={it.label} className="rounded-lg bg-secondary/40 p-3 text-center">
              <div className="flex justify-center mb-1">{it.icon}</div>
              <div className="font-serif text-2xl text-primary">{it.value}</div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{it.label}</div>
            </div>
          ))}
        </div>
      )}
      {wordsThisMonth > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          {wordsThisMonth.toLocaleString()} words written this month.
        </p>
      )}
    </div>
  );
}
