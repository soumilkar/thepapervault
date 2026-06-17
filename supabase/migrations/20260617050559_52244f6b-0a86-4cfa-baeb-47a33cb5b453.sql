
-- Tour completion flag
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS tour_completed boolean NOT NULL DEFAULT false;

-- Music fields on blog_posts
ALTER TABLE public.blog_posts
  ADD COLUMN IF NOT EXISTS music_track_id text,
  ADD COLUMN IF NOT EXISTS music_track_name text,
  ADD COLUMN IF NOT EXISTS music_artist text,
  ADD COLUMN IF NOT EXISTS music_preview_url text,
  ADD COLUMN IF NOT EXISTS music_artwork_url text;

-- Likes
CREATE TABLE IF NOT EXISTS public.blog_likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES public.blog_posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, user_id)
);
GRANT SELECT, INSERT, DELETE ON public.blog_likes TO authenticated;
GRANT ALL ON public.blog_likes TO service_role;
ALTER TABLE public.blog_likes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read all likes" ON public.blog_likes FOR SELECT TO authenticated USING (true);
CREATE POLICY "like as self" ON public.blog_likes FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "unlike own" ON public.blog_likes FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Comments
CREATE TABLE IF NOT EXISTS public.blog_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES public.blog_posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.blog_comments TO authenticated;
GRANT ALL ON public.blog_comments TO service_role;
ALTER TABLE public.blog_comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read all comments" ON public.blog_comments FOR SELECT TO authenticated USING (true);
CREATE POLICY "comment as self" ON public.blog_comments FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "edit own comment" ON public.blog_comments FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "delete own comment" ON public.blog_comments FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER touch_blog_comments BEFORE UPDATE ON public.blog_comments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
