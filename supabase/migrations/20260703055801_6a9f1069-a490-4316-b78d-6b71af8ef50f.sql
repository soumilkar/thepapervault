
ALTER TABLE public.diary_entries
  ADD COLUMN IF NOT EXISTS word_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mood_score smallint;

CREATE INDEX IF NOT EXISTS diary_entries_user_date_idx
  ON public.diary_entries (user_id, entry_date);
