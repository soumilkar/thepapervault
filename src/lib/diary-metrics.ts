import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useVault } from "@/lib/vault";
import { decryptText } from "@/lib/crypto";
import { moodScore } from "@/lib/mood-sentiment";

export type DiaryMetricRow = {
  entry_date: string;
  word_count: number | null;
  mood_score: number | null;
};

type RawMetricRow = {
  entry_date: string;
  content: string;
  iv: string | null;
  is_public: boolean;
  word_count: number | null;
  mood_score: number | null;
  mood: string | null;
};

function countWords(s: string) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export function useDiaryMetrics(userId: string) {
  const { key } = useVault();
  return useQuery({
    enabled: !!key,
    queryKey: ["diary-metrics", userId],
    queryFn: async (): Promise<DiaryMetricRow[]> => {
      const { data, error } = await supabase
        .from("diary_entries")
        .select("entry_date,content,iv,is_public,word_count,mood_score,mood")
        .eq("user_id", userId)
        .order("entry_date", { ascending: true });
      if (error) throw error;
      const rows = (data ?? []) as RawMetricRow[];

      return Promise.all(
        rows.map(async (r) => {
          if (r.iv && key) {
            try {
              const plain = await decryptText(key, r.content, r.iv);
              const obj = JSON.parse(plain) as {
                c?: string;
                m?: string;
                wc?: number;
                ms?: number | null;
              };
              const wc = typeof obj.wc === "number" ? obj.wc : countWords(obj.c ?? "");
              const ms =
                obj.ms !== undefined
                  ? obj.ms
                  : obj.m
                    ? moodScore(obj.m)
                    : r.mood_score;
              return {
                entry_date: r.entry_date,
                word_count: wc,
                mood_score: ms ?? null,
              };
            } catch {
              return {
                entry_date: r.entry_date,
                word_count: r.word_count ?? 0,
                mood_score: r.mood_score ?? null,
              };
            }
          }
          return {
            entry_date: r.entry_date,
            word_count: r.word_count || countWords(r.content || ""),
            mood_score: r.mood_score ?? (r.mood ? moodScore(r.mood) : null),
          };
        }),
      );
    },
  });
}
