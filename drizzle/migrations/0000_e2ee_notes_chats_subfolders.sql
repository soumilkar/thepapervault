ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS iv text;
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS iv text;
ALTER TABLE public.chat_sessions ADD COLUMN IF NOT EXISTS title_iv text;
ALTER TABLE public.note_folders ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES public.note_folders(id) ON DELETE CASCADE;
ALTER TABLE public.diary_folders ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES public.diary_folders(id) ON DELETE CASCADE;