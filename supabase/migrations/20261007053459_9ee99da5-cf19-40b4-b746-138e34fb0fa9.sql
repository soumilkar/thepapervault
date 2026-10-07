ALTER TABLE public.diary_entries ADD COLUMN IF NOT EXISTS is_pinned boolean NOT NULL DEFAULT false;
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS is_pinned boolean NOT NULL DEFAULT false;

CREATE TABLE public.diary_entry_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES public.diary_entries(id) ON DELETE CASCADE,
  folder_id uuid NOT NULL REFERENCES public.diary_folders(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(entry_id, folder_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.diary_entry_folders TO authenticated;
GRANT ALL ON public.diary_entry_folders TO service_role;
ALTER TABLE public.diary_entry_folders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own diary entry folders" ON public.diary_entry_folders FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.note_folder_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  note_id uuid NOT NULL REFERENCES public.notes(id) ON DELETE CASCADE,
  folder_id uuid NOT NULL REFERENCES public.note_folders(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(note_id, folder_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.note_folder_memberships TO authenticated;
GRANT ALL ON public.note_folder_memberships TO service_role;
ALTER TABLE public.note_folder_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own note folder memberships" ON public.note_folder_memberships FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

INSERT INTO public.diary_entry_folders (user_id, entry_id, folder_id)
SELECT user_id, id, folder_id FROM public.diary_entries WHERE folder_id IS NOT NULL
ON CONFLICT (entry_id, folder_id) DO NOTHING;
INSERT INTO public.note_folder_memberships (user_id, note_id, folder_id)
SELECT user_id, id, folder_id FROM public.notes WHERE folder_id IS NOT NULL
ON CONFLICT (note_id, folder_id) DO NOTHING;