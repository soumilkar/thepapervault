-- =============================================================================
-- Drop unused / unallocated database tables, functions, columns, and orphan rows
-- =============================================================================

BEGIN;

-- 1. Drop unused RPC functions
DROP FUNCTION IF EXISTS public.set_item_folders(uuid, uuid[], text);
DROP FUNCTION IF EXISTS public.delete_owned_folder(uuid, text, boolean);

-- 2. Drop unused tables
DROP TABLE IF EXISTS public.life_goals CASCADE;
DROP TABLE IF EXISTS public.diary_entry_folders CASCADE;
DROP TABLE IF EXISTS public.note_folder_memberships CASCADE;

-- 3. Drop unused columns
ALTER TABLE public.profiles DROP COLUMN IF EXISTS bio;
ALTER TABLE public.diary_entries DROP COLUMN IF EXISTS is_pinned;
ALTER TABLE public.diary_entries DROP COLUMN IF EXISTS mood_score;
ALTER TABLE public.notes DROP COLUMN IF EXISTS is_pinned;

-- 4. Clean up unallocated / orphaned data
-- Clear diary_entries.image_path that no longer match an existing gallery_images row
UPDATE public.diary_entries d
SET image_path = NULL
WHERE d.image_path IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.gallery_images g
    WHERE g.storage_path = d.image_path AND g.user_id = d.user_id
  );

-- Delete abandoned empty chat_sessions with no messages
DELETE FROM public.chat_sessions s
WHERE NOT EXISTS (
  SELECT 1 FROM public.chat_messages m WHERE m.session_id = s.id
)
AND s.created_at < now() - interval '1 hour';

-- 5. Restrict encrypted .bin note attachments in 'media' bucket to owner-only read
DROP POLICY IF EXISTS "media authenticated read" ON storage.objects;
CREATE POLICY "media authenticated read" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'media'
    AND (
      auth.uid()::text = (storage.foldername(name))[1]
      OR name NOT LIKE '%.bin'
    )
  );

-- 6. Scrub any residual plaintext metadata columns on encrypted rows
UPDATE public.diary_entries
SET
  title = NULL,
  mood = NULL,
  word_count = 0,
  music_track_id = NULL,
  music_track_name = NULL,
  music_artist = NULL,
  music_preview_url = NULL,
  music_artwork_url = NULL
WHERE is_public = false AND iv IS NOT NULL;

UPDATE public.notes
SET
  title = NULL,
  tags = NULL
WHERE iv IS NOT NULL;

COMMIT;
