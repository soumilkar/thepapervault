
DROP POLICY IF EXISTS "public diary entries are readable by anyone" ON public.diary_entries;
DROP POLICY IF EXISTS "read public or own diary entries" ON public.diary_entries;

CREATE POLICY "diary entries visible when public and owned"
ON public.diary_entries
FOR SELECT
TO anon, authenticated
USING (
  (is_public = true AND visibility = 'public_anon')
  OR (auth.uid() IS NOT NULL AND auth.uid() = user_id)
);
