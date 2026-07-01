
DROP POLICY IF EXISTS "media authenticated read" ON storage.objects;
CREATE POLICY "media authenticated read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'media');

DROP POLICY IF EXISTS "media anon read" ON storage.objects;
CREATE POLICY "media anon read" ON storage.objects
  FOR SELECT TO anon
  USING (bucket_id = 'media');

DROP POLICY IF EXISTS "media users insert own" ON storage.objects;
CREATE POLICY "media users insert own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'media' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "media users update own" ON storage.objects;
CREATE POLICY "media users update own" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'media' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "media users delete own" ON storage.objects;
CREATE POLICY "media users delete own" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'media' AND auth.uid()::text = (storage.foldername(name))[1]);
