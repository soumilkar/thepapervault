DROP POLICY IF EXISTS "media anon read" ON storage.objects;
DROP POLICY IF EXISTS "media authenticated read" ON storage.objects;
CREATE POLICY "media users read own" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'media' AND auth.uid()::text = (storage.foldername(name))[1]);