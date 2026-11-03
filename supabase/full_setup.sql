-- =============================================================================
-- The PaperVault — Complete Supabase Setup Script (Idempotent & Cleaned)
-- Run this in your Supabase project's SQL Editor.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Drop Legacy / Unused Objects (Idempotent Cleanup)
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.set_item_folders(uuid, uuid[], text);
DROP FUNCTION IF EXISTS public.delete_owned_folder(uuid, text, boolean);
DROP TABLE IF EXISTS public.life_goals CASCADE;
DROP TABLE IF EXISTS public.diary_entry_folders CASCADE;
DROP TABLE IF EXISTS public.note_folder_memberships CASCADE;

-- -----------------------------------------------------------------------------
-- 1. Helper Trigger Functions
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data->>'display_name',
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      split_part(NEW.email, '@', 1)
    )
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.touch_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------

-- 2.1 profiles
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text,
  tour_completed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles DROP COLUMN IF EXISTS bio;

-- 2.2 vault_keys (E2EE PBKDF2 salts + verifier; never stores actual vault key)
CREATE TABLE IF NOT EXISTS public.vault_keys (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  kdf_salt text NOT NULL,
  verifier text NOT NULL,
  verifier_salt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2.3 diary_folders (supports nested subfolders via parent_id)
CREATE TABLE IF NOT EXISTS public.diary_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  parent_id uuid REFERENCES public.diary_folders(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2.4 diary_entries (private E2EE entries + anonymous public community entries)
CREATE TABLE IF NOT EXISTS public.diary_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  folder_id uuid REFERENCES public.diary_folders(id) ON DELETE SET NULL,
  title text,
  content text NOT NULL,
  mood text,
  mood_score smallint,
  word_count integer NOT NULL DEFAULT 0,
  entry_date date NOT NULL DEFAULT CURRENT_DATE,
  image_path text,
  iv text,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public_anon')),
  is_public boolean NOT NULL DEFAULT false,
  music_track_id text,
  music_track_name text,
  music_artist text,
  music_preview_url text,
  music_artwork_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.diary_entries DROP COLUMN IF EXISTS is_pinned;

-- 2.5 note_folders (supports nested subfolders via parent_id)
CREATE TABLE IF NOT EXISTS public.note_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  parent_id uuid REFERENCES public.note_folders(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2.6 notes (E2EE notes)
CREATE TABLE IF NOT EXISTS public.notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  folder_id uuid REFERENCES public.note_folders(id) ON DELETE SET NULL,
  title text,
  content text NOT NULL DEFAULT '',
  tags text[],
  image_url text,
  iv text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.notes DROP COLUMN IF EXISTS is_pinned;

-- 2.7 blog_posts
CREATE TABLE IF NOT EXISTS public.blog_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  content text NOT NULL,
  tags text[],
  image_url text,
  notify_on_comment boolean NOT NULL DEFAULT true,
  music_track_id text,
  music_track_name text,
  music_artist text,
  music_preview_url text,
  music_artwork_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2.8 blog_likes
CREATE TABLE IF NOT EXISTS public.blog_likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES public.blog_posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, user_id)
);

-- 2.9 blog_comments (supports nested replies via parent_id)
CREATE TABLE IF NOT EXISTS public.blog_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES public.blog_posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES public.blog_comments(id) ON DELETE CASCADE,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2.10 comment_votes (upvotes/downvotes on blog comments)
CREATE TABLE IF NOT EXISTS public.comment_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id uuid NOT NULL REFERENCES public.blog_comments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  value smallint NOT NULL CHECK (value IN (-1, 1)),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (comment_id, user_id)
);

-- 2.11 gallery_images (E2EE gallery photos + encrypted captions)
CREATE TABLE IF NOT EXISTS public.gallery_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  caption text,
  caption_iv text,
  iv text,
  mime text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 2.12 chat_sessions (E2EE companion chat sessions)
CREATE TABLE IF NOT EXISTS public.chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New conversation',
  title_iv text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now()
);

-- 2.13 chat_messages (E2EE companion chat messages)
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  iv text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 3. Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS diary_entries_user_date_idx
  ON public.diary_entries (user_id, entry_date DESC);

CREATE INDEX IF NOT EXISTS diary_entries_public_date_idx
  ON public.diary_entries (is_public, entry_date DESC)
  WHERE is_public = true;

CREATE INDEX IF NOT EXISTS diary_folders_user_idx
  ON public.diary_folders (user_id);

CREATE INDEX IF NOT EXISTS notes_user_updated_idx
  ON public.notes (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS note_folders_user_idx
  ON public.note_folders (user_id);

CREATE INDEX IF NOT EXISTS blog_posts_user_created_idx
  ON public.blog_posts (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS blog_posts_created_idx
  ON public.blog_posts (created_at DESC);

CREATE INDEX IF NOT EXISTS blog_likes_post_idx
  ON public.blog_likes (post_id);

CREATE INDEX IF NOT EXISTS blog_comments_post_created_idx
  ON public.blog_comments (post_id, created_at ASC);

CREATE INDEX IF NOT EXISTS comment_votes_comment_idx
  ON public.comment_votes (comment_id);

CREATE INDEX IF NOT EXISTS gallery_images_user_created_idx
  ON public.gallery_images (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS gallery_images_storage_path_idx
  ON public.gallery_images (storage_path);

CREATE INDEX IF NOT EXISTS chat_sessions_user_last
  ON public.chat_sessions (user_id, last_message_at DESC);

CREATE INDEX IF NOT EXISTS chat_messages_session
  ON public.chat_messages (session_id, created_at ASC);

-- -----------------------------------------------------------------------------
-- 4. Triggers
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

DROP TRIGGER IF EXISTS t_profiles_updated ON public.profiles;
CREATE TRIGGER t_profiles_updated
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS vault_keys_touch ON public.vault_keys;
CREATE TRIGGER vault_keys_touch
  BEFORE UPDATE ON public.vault_keys
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS diary_folders_touch ON public.diary_folders;
CREATE TRIGGER diary_folders_touch
  BEFORE UPDATE ON public.diary_folders
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS diary_entries_touch ON public.diary_entries;
CREATE TRIGGER diary_entries_touch
  BEFORE UPDATE ON public.diary_entries
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS note_folders_touch ON public.note_folders;
CREATE TRIGGER note_folders_touch
  BEFORE UPDATE ON public.note_folders
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS notes_touch ON public.notes;
CREATE TRIGGER notes_touch
  BEFORE UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS blog_posts_touch ON public.blog_posts;
CREATE TRIGGER blog_posts_touch
  BEFORE UPDATE ON public.blog_posts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS blog_comments_touch ON public.blog_comments;
CREATE TRIGGER blog_comments_touch
  BEFORE UPDATE ON public.blog_comments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 5. Table Grants & Row Level Security (RLS)
-- -----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.profiles,
  public.vault_keys,
  public.diary_folders,
  public.diary_entries,
  public.note_folders,
  public.notes,
  public.blog_posts,
  public.blog_likes,
  public.blog_comments,
  public.comment_votes,
  public.gallery_images,
  public.chat_sessions,
  public.chat_messages
TO authenticated;

GRANT SELECT ON public.diary_entries TO anon;

GRANT ALL ON
  public.profiles,
  public.vault_keys,
  public.diary_folders,
  public.diary_entries,
  public.note_folders,
  public.notes,
  public.blog_posts,
  public.blog_likes,
  public.blog_comments,
  public.comment_votes,
  public.gallery_images,
  public.chat_sessions,
  public.chat_messages
TO service_role;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vault_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diary_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diary_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comment_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gallery_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

-- profiles policies
DROP POLICY IF EXISTS "read all profiles" ON public.profiles;
CREATE POLICY "read all profiles" ON public.profiles
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "own profile" ON public.profiles;
CREATE POLICY "own profile" ON public.profiles
  FOR ALL TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- vault_keys policies
DROP POLICY IF EXISTS "own vault key" ON public.vault_keys;
CREATE POLICY "own vault key" ON public.vault_keys
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- diary_folders policies
DROP POLICY IF EXISTS "own diary folders" ON public.diary_folders;
CREATE POLICY "own diary folders" ON public.diary_folders
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- diary_entries policies
DROP POLICY IF EXISTS "own diary" ON public.diary_entries;
CREATE POLICY "own diary" ON public.diary_entries
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "diary entries visible when public and owned" ON public.diary_entries;
CREATE POLICY "diary entries visible when public and owned" ON public.diary_entries
  FOR SELECT TO anon, authenticated
  USING (
    (is_public = true AND visibility = 'public_anon')
    OR (auth.uid() IS NOT NULL AND auth.uid() = user_id)
  );

-- note_folders policies
DROP POLICY IF EXISTS "own note folders" ON public.note_folders;
CREATE POLICY "own note folders" ON public.note_folders
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- notes policies
DROP POLICY IF EXISTS "own notes" ON public.notes;
CREATE POLICY "own notes" ON public.notes
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- blog_posts policies
DROP POLICY IF EXISTS "read all blog posts" ON public.blog_posts;
CREATE POLICY "read all blog posts" ON public.blog_posts
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "own blog" ON public.blog_posts;
CREATE POLICY "own blog" ON public.blog_posts
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- blog_likes policies
DROP POLICY IF EXISTS "read all likes" ON public.blog_likes;
CREATE POLICY "read all likes" ON public.blog_likes
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "like as self" ON public.blog_likes;
CREATE POLICY "like as self" ON public.blog_likes
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "unlike own" ON public.blog_likes;
CREATE POLICY "unlike own" ON public.blog_likes
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- blog_comments policies
DROP POLICY IF EXISTS "read all comments" ON public.blog_comments;
CREATE POLICY "read all comments" ON public.blog_comments
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "comment as self" ON public.blog_comments;
CREATE POLICY "comment as self" ON public.blog_comments
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "edit own comment" ON public.blog_comments;
CREATE POLICY "edit own comment" ON public.blog_comments
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "delete own comment" ON public.blog_comments;
CREATE POLICY "delete own comment" ON public.blog_comments
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- comment_votes policies
DROP POLICY IF EXISTS "read all comment votes" ON public.comment_votes;
CREATE POLICY "read all comment votes" ON public.comment_votes
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "vote as self" ON public.comment_votes;
CREATE POLICY "vote as self" ON public.comment_votes
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "update own vote" ON public.comment_votes;
CREATE POLICY "update own vote" ON public.comment_votes
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "delete own vote" ON public.comment_votes;
CREATE POLICY "delete own vote" ON public.comment_votes
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- gallery_images policies
DROP POLICY IF EXISTS "own gallery" ON public.gallery_images;
CREATE POLICY "own gallery" ON public.gallery_images
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- chat_sessions policies
DROP POLICY IF EXISTS "own sessions" ON public.chat_sessions;
CREATE POLICY "own sessions" ON public.chat_sessions
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- chat_messages policies
DROP POLICY IF EXISTS "own messages" ON public.chat_messages;
CREATE POLICY "own messages" ON public.chat_messages
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- 6. Storage Buckets & Storage RLS Policies
-- -----------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public)
VALUES
  ('gallery', 'gallery', false),
  ('media', 'media', false)
ON CONFLICT (id) DO NOTHING;

-- 'gallery' bucket policies (strictly owner-only; files are E2EE blobs)
DROP POLICY IF EXISTS "users read own gallery objects" ON storage.objects;
CREATE POLICY "users read own gallery objects" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'gallery' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "users upload own gallery objects" ON storage.objects;
CREATE POLICY "users upload own gallery objects" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'gallery' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "users update own gallery objects" ON storage.objects;
CREATE POLICY "users update own gallery objects" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'gallery' AND auth.uid()::text = (storage.foldername(name))[1])
  WITH CHECK (bucket_id = 'gallery' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "users delete own gallery objects" ON storage.objects;
CREATE POLICY "users delete own gallery objects" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'gallery' AND auth.uid()::text = (storage.foldername(name))[1]);

-- 'media' bucket policies (encrypted .bin Note attachments are strictly owner-only; Blog images readable by authenticated users)
DROP POLICY IF EXISTS "media users read own" ON storage.objects;
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

DROP POLICY IF EXISTS "media users insert own" ON storage.objects;
CREATE POLICY "media users insert own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'media' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "media users update own" ON storage.objects;
CREATE POLICY "media users update own" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'media' AND auth.uid()::text = (storage.foldername(name))[1])
  WITH CHECK (bucket_id = 'media' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "media users delete own" ON storage.objects;
CREATE POLICY "media users delete own" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'media' AND auth.uid()::text = (storage.foldername(name))[1]);

-- -----------------------------------------------------------------------------
-- 7. Data Hygiene & E2EE Metadata Scrubbing
-- -----------------------------------------------------------------------------
UPDATE public.diary_entries d
SET image_path = NULL
WHERE d.image_path IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.gallery_images g
    WHERE g.storage_path = d.image_path AND g.user_id = d.user_id
  );

-- Scrub any residual plaintext metadata columns on encrypted private diary entries
UPDATE public.diary_entries
SET
  title = NULL,
  mood = NULL,
  word_count = 0,
  mood_score = NULL,
  music_track_id = NULL,
  music_track_name = NULL,
  music_artist = NULL,
  music_preview_url = NULL,
  music_artwork_url = NULL
WHERE is_public = false AND iv IS NOT NULL;

-- Scrub any residual plaintext columns on encrypted notes
UPDATE public.notes
SET
  title = NULL,
  tags = NULL
WHERE iv IS NOT NULL;

DELETE FROM public.chat_sessions s
WHERE NOT EXISTS (
  SELECT 1 FROM public.chat_messages m WHERE m.session_id = s.id
)
AND s.created_at < now() - interval '1 hour';

COMMIT;
