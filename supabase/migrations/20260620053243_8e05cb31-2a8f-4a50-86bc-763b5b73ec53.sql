
-- Tighten gallery storage policies
DROP POLICY IF EXISTS "authenticated read gallery objects" ON storage.objects;

CREATE POLICY "users update own gallery objects"
ON storage.objects
FOR UPDATE
TO authenticated
USING (bucket_id = 'gallery' AND (auth.uid())::text = (storage.foldername(name))[1])
WITH CHECK (bucket_id = 'gallery' AND (auth.uid())::text = (storage.foldername(name))[1]);

-- Scope owner-ALL policies to authenticated role only (anon was a no-op but cleaner)
DROP POLICY IF EXISTS "own diary" ON public.diary_entries;
CREATE POLICY "own diary" ON public.diary_entries
FOR ALL TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "own gallery" ON public.gallery_images;
CREATE POLICY "own gallery" ON public.gallery_images
FOR ALL TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "own blog" ON public.blog_posts;
CREATE POLICY "own blog" ON public.blog_posts
FOR ALL TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "own profile" ON public.profiles;
CREATE POLICY "own profile" ON public.profiles
FOR ALL TO authenticated
USING (auth.uid() = id)
WITH CHECK (auth.uid() = id);
