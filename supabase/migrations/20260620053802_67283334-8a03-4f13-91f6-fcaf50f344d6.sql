
-- Vault key material (no actual key is ever stored server-side)
CREATE TABLE public.vault_keys (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  kdf_salt text NOT NULL,         -- base64; used with PBKDF2 to derive the data key
  verifier text NOT NULL,         -- base64; PBKDF2(passphrase, verifier_salt) for unlock check
  verifier_salt text NOT NULL,    -- base64; salt for the verifier hash
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.vault_keys TO authenticated;
GRANT ALL ON public.vault_keys TO service_role;

ALTER TABLE public.vault_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own vault key"
ON public.vault_keys
FOR ALL TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER vault_keys_touch
BEFORE UPDATE ON public.vault_keys
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Encrypted-content metadata
ALTER TABLE public.diary_entries
  ADD COLUMN IF NOT EXISTS iv text;

ALTER TABLE public.gallery_images
  ADD COLUMN IF NOT EXISTS iv text,
  ADD COLUMN IF NOT EXISTS caption_iv text,
  ADD COLUMN IF NOT EXISTS mime text;
