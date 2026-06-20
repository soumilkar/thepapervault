// One-time migration: encrypt any pre-existing plaintext diary entries and gallery files
// belonging to the current user. Runs after the vault is unlocked.
import { supabase } from "@/integrations/supabase/client";
import { encryptBlob, encryptText } from "@/lib/crypto";

// Re-typed Supabase client to avoid TS strict-checking the new columns until the generated
// types catch up with the migration.
const db = supabase as unknown as {
  from: (t: string) => {
    select: (cols: string) => { eq: (col: string, v: string) => Promise<{ data: unknown[] | null }> };
    update: (vals: Record<string, unknown>) => { eq: (col: string, v: string) => Promise<{ error: unknown }> };
  };
};

let migrationRunning = false;
export async function runVaultMigration(userId: string) {
  const key = (window as unknown as { __vaultKey?: CryptoKey }).__vaultKey;
  if (!key) return;
  if (migrationRunning) return;
  migrationRunning = true;
  try {
    await migrateDiary(userId, key);
    await migrateGallery(userId, key);
  } finally {
    migrationRunning = false;
  }
}

type DiaryRow = { id: string; title: string | null; content: string; mood: string | null; iv: string | null };
type GalleryRow = { id: string; storage_path: string; caption: string | null; iv: string | null; caption_iv: string | null; mime: string | null };

async function migrateDiary(userId: string, key: CryptoKey) {
  const { data } = await db.from("diary_entries").select("id,title,content,mood,iv").eq("user_id", userId);
  const rows = (data ?? []) as DiaryRow[];
  for (const row of rows) {
    if (row.iv) continue;
    const plaintext = JSON.stringify({ t: row.title ?? "", c: row.content, m: row.mood ?? "" });
    const { ct, iv } = await encryptText(key, plaintext);
    await db.from("diary_entries").update({ title: null, content: ct, mood: null, iv }).eq("id", row.id);
  }
}

async function migrateGallery(userId: string, key: CryptoKey) {
  const { data } = await db.from("gallery_images").select("id,storage_path,caption,iv,caption_iv,mime").eq("user_id", userId);
  const rows = (data ?? []) as GalleryRow[];
  for (const row of rows) {
    const updates: Record<string, unknown> = {};
    if (!row.iv) {
      const { data: signed } = await supabase.storage.from("gallery").createSignedUrl(row.storage_path, 60 * 10);
      if (signed?.signedUrl) {
        const res = await fetch(signed.signedUrl);
        const blob = await res.blob();
        const mime = blob.type || "image/jpeg";
        const { blob: encBlob, iv } = await encryptBlob(key, blob);
        const { error: upErr } = await supabase.storage.from("gallery").upload(row.storage_path, encBlob, { contentType: "application/octet-stream", upsert: true });
        if (!upErr) {
          updates.iv = iv;
          updates.mime = mime;
        }
      }
    }
    if (row.caption && !row.caption_iv) {
      const { ct, iv } = await encryptText(key, row.caption);
      updates.caption = ct;
      updates.caption_iv = iv;
    }
    if (Object.keys(updates).length) {
      await db.from("gallery_images").update(updates).eq("id", row.id);
    }
  }
}
