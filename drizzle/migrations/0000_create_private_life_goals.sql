CREATE TABLE public.life_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  progress smallint NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  deadline date,
  mood text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.life_goals TO authenticated;
GRANT ALL ON public.life_goals TO service_role;
ALTER TABLE public.life_goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage their own life goals"
  ON public.life_goals
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
CREATE INDEX life_goals_user_updated_idx ON public.life_goals (user_id, updated_at DESC);
CREATE TRIGGER life_goals_touch_updated_at
  BEFORE UPDATE ON public.life_goals
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();