
-- 1. diary_entries: add public flag, music, folder
ALTER TABLE public.diary_entries
  ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS music_track_id text,
  ADD COLUMN IF NOT EXISTS music_track_name text,
  ADD COLUMN IF NOT EXISTS music_artist text,
  ADD COLUMN IF NOT EXISTS music_preview_url text,
  ADD COLUMN IF NOT EXISTS music_artwork_url text,
  ADD COLUMN IF NOT EXISTS folder_id uuid;

-- allow anonymous read of public diary entries
DROP POLICY IF EXISTS "public diary entries are readable by anyone" ON public.diary_entries;
CREATE POLICY "public diary entries are readable by anyone"
  ON public.diary_entries FOR SELECT
  TO anon, authenticated
  USING (is_public = true);

GRANT SELECT ON public.diary_entries TO anon;

-- 2. blog_posts: image attachment
ALTER TABLE public.blog_posts
  ADD COLUMN IF NOT EXISTS image_url text;

-- 3. diary_folders
CREATE TABLE IF NOT EXISTS public.diary_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.diary_folders TO authenticated;
GRANT ALL ON public.diary_folders TO service_role;
ALTER TABLE public.diary_folders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own diary folders" ON public.diary_folders;
CREATE POLICY "own diary folders" ON public.diary_folders
  FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- FK for diary_entries.folder_id
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'diary_entries_folder_id_fkey'
  ) THEN
    ALTER TABLE public.diary_entries
      ADD CONSTRAINT diary_entries_folder_id_fkey
      FOREIGN KEY (folder_id) REFERENCES public.diary_folders(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 4. note_folders
CREATE TABLE IF NOT EXISTS public.note_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.note_folders TO authenticated;
GRANT ALL ON public.note_folders TO service_role;
ALTER TABLE public.note_folders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own note folders" ON public.note_folders;
CREATE POLICY "own note folders" ON public.note_folders
  FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- 5. notes
CREATE TABLE IF NOT EXISTS public.notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  folder_id uuid REFERENCES public.note_folders(id) ON DELETE SET NULL,
  title text,
  content text NOT NULL DEFAULT '',
  tags text[],
  image_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notes TO authenticated;
GRANT ALL ON public.notes TO service_role;
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own notes" ON public.notes;
CREATE POLICY "own notes" ON public.notes
  FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- 6. updated_at triggers
DROP TRIGGER IF EXISTS notes_touch ON public.notes;
CREATE TRIGGER notes_touch BEFORE UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS note_folders_touch ON public.note_folders;
CREATE TRIGGER note_folders_touch BEFORE UPDATE ON public.note_folders
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS diary_folders_touch ON public.diary_folders;
CREATE TRIGGER diary_folders_touch BEFORE UPDATE ON public.diary_folders
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS diary_entries_touch ON public.diary_entries;
CREATE TRIGGER diary_entries_touch BEFORE UPDATE ON public.diary_entries
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS blog_posts_touch ON public.blog_posts;
CREATE TRIGGER blog_posts_touch BEFORE UPDATE ON public.blog_posts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS blog_comments_touch ON public.blog_comments;
CREATE TRIGGER blog_comments_touch BEFORE UPDATE ON public.blog_comments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
