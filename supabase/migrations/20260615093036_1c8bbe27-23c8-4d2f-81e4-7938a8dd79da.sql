
ALTER TABLE public.diary_entries ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';
ALTER TABLE public.diary_entries ADD CONSTRAINT diary_visibility_chk CHECK (visibility IN ('private','public_anon'));

DROP POLICY IF EXISTS "read all diary entries" ON public.diary_entries;
CREATE POLICY "read public or own diary entries" ON public.diary_entries FOR SELECT TO authenticated
  USING (visibility = 'public_anon' OR auth.uid() = user_id);
