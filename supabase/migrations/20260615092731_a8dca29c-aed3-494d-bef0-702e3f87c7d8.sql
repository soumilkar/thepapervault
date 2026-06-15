
ALTER TABLE public.diary_entries ADD COLUMN IF NOT EXISTS image_path TEXT;

-- Public-within-app read policies
CREATE POLICY "read all blog posts" ON public.blog_posts FOR SELECT TO authenticated USING (true);
CREATE POLICY "read all diary entries" ON public.diary_entries FOR SELECT TO authenticated USING (true);
CREATE POLICY "read all profiles" ON public.profiles FOR SELECT TO authenticated USING (true);

-- Allow authenticated to read any gallery object (paths are uuid-based)
CREATE POLICY "authenticated read gallery objects" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'gallery');
