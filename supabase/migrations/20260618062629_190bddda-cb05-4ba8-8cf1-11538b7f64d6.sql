
-- Comment threading
ALTER TABLE public.blog_comments ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES public.blog_comments(id) ON DELETE CASCADE;

-- Comment votes
CREATE TABLE IF NOT EXISTS public.comment_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id uuid NOT NULL REFERENCES public.blog_comments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  value smallint NOT NULL CHECK (value IN (-1, 1)),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (comment_id, user_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.comment_votes TO authenticated;
GRANT ALL ON public.comment_votes TO service_role;

ALTER TABLE public.comment_votes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read all comment votes" ON public.comment_votes FOR SELECT TO authenticated USING (true);
CREATE POLICY "vote as self" ON public.comment_votes FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "update own vote" ON public.comment_votes FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "delete own vote" ON public.comment_votes FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Email notification preference per blog
ALTER TABLE public.blog_posts ADD COLUMN IF NOT EXISTS notify_on_comment boolean NOT NULL DEFAULT true;
