// One-time background maintenance: encrypt any pre-existing plaintext rows/metadata across all private tables
// and prune unallocated / excess chat sessions belonging to the current user.
import { supabase } from "@/integrations/supabase/client";
import {
  decryptText,
  encryptBlob,
  encryptField,
  encryptText,
  isEncryptedField,
} from "@/lib/crypto";

let migrationRunning = false;

function countWords(s: string) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export async function runVaultMigration(userId: string, key: CryptoKey) {
  if (!key || migrationRunning || typeof window === "undefined") return;

  const storageFlag = `papervault:migrated:v2:${userId}`;
  try {
    if (
      window.localStorage.getItem(storageFlag) === "1" ||
      window.sessionStorage.getItem(storageFlag) === "1"
    ) {
      return;
    }
  } catch {
    // ignore storage errors
  }

  // Defer background maintenance by 25s so initial page data loads with zero contention
  await new Promise<void>((resolve) => {
    window.setTimeout(() => {
      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(() => resolve(), { timeout: 10000 });
      } else {
        resolve();
      }
    }, 25000);
  });

  if (migrationRunning) return;
  migrationRunning = true;
  try {
    await migrateDiary(userId, key);
    await migrateFolders("diary_folders", userId, key);
    await migrateNotes(userId, key);
    await migrateFolders("note_folders", userId, key);
    await migrateGallery(userId, key);
    await migrateChatSessions(userId, key);
    await migrateChatMessages(userId, key);
    try {
      window.localStorage.setItem(storageFlag, "1");
      window.sessionStorage.setItem(storageFlag, "1");
    } catch {
      // ignore
    }
  } finally {
    migrationRunning = false;
  }
}

type DiaryRow = {
  id: string;
  title: string | null;
  content: string;
  mood: string | null;
  iv: string | null;
  word_count: number | null;
  music_track_id: string | null;
  music_track_name: string | null;
  music_artist: string | null;
  music_preview_url: string | null;
  music_artwork_url: string | null;
};

type GalleryRow = {
  id: string;
  storage_path: string;
  caption: string | null;
  iv: string | null;
  caption_iv: string | null;
  mime: string | null;
};

async function migrateDiary(userId: string, key: CryptoKey) {
  const { data } = await supabase
    .from("diary_entries")
    .select(
      "id,title,content,mood,iv,word_count,music_track_id,music_track_name,music_artist,music_preview_url,music_artwork_url",
    )
    .eq("user_id", userId)
    .eq("is_public", false);
  const rows = (data ?? []) as DiaryRow[];
  await Promise.all(
    rows.map(async (row) => {
      const hasPlainCols =
        !row.iv ||
        row.title !== null ||
        row.mood !== null ||
        (row.word_count !== null && row.word_count !== 0) ||
        row.music_preview_url !== null;
      if (!hasPlainCols) return;

      let t = row.title ?? "";
      let c = row.content;
      let m = row.mood ?? "";
      let mu = row.music_preview_url
        ? {
            music_track_id: row.music_track_id ?? "",
            music_track_name: row.music_track_name ?? "",
            music_artist: row.music_artist ?? "",
            music_preview_url: row.music_preview_url,
            music_artwork_url: row.music_artwork_url ?? "",
          }
        : null;

      if (row.iv) {
        try {
          const plain = await decryptText(key, row.content, row.iv);
          const obj = JSON.parse(plain) as {
            t?: string;
            c?: string;
            m?: string;
            mu?: typeof mu;
          };
          t = obj.t ?? t;
          c = obj.c ?? c;
          m = obj.m ?? m;
          if (obj.mu) mu = obj.mu;
        } catch {
          return;
        }
      }

      const payload = JSON.stringify({
        t,
        c,
        m,
        wc: countWords(c),
        mu,
      });
      const { ct, iv } = await encryptText(key, payload);
      await supabase
        .from("diary_entries")
        .update({
          title: null,
          content: ct,
          mood: null,
          iv,
          word_count: 0,
          music_track_id: null,
          music_track_name: null,
          music_artist: null,
          music_preview_url: null,
          music_artwork_url: null,
        })
        .eq("id", row.id);
    }),
  );
}

async function migrateFolders(
  table: "diary_folders" | "note_folders",
  userId: string,
  key: CryptoKey,
) {
  const { data } = await supabase.from(table).select("id,name").eq("user_id", userId);
  const rows = data ?? [];
  await Promise.all(
    rows.map(async (f) => {
      if (!f.name || isEncryptedField(f.name)) return;
      const encName = await encryptField(key, f.name);
      await supabase.from(table).update({ name: encName }).eq("id", f.id);
    }),
  );
}

async function migrateNotes(userId: string, key: CryptoKey) {
  const { data } = await supabase
    .from("notes")
    .select("id,title,content,tags,iv")
    .eq("user_id", userId);
  const rows = data ?? [];
  await Promise.all(
    rows.map(async (r) => {
      if (!r.iv) {
        const payload = JSON.stringify({ t: r.title ?? "", c: r.content, g: r.tags ?? [] });
        const { ct, iv } = await encryptText(key, payload);
        await supabase
          .from("notes")
          .update({ content: ct, iv, title: null, tags: null })
          .eq("id", r.id);
      } else if (r.title !== null || r.tags !== null) {
        await supabase.from("notes").update({ title: null, tags: null }).eq("id", r.id);
      }
    }),
  );
}

async function migrateGallery(userId: string, key: CryptoKey) {
  const { data } = await supabase
    .from("gallery_images")
    .select("id,storage_path,caption,iv,caption_iv,mime")
    .eq("user_id", userId)
    .or("iv.is.null,and(caption.not.is.null,caption_iv.is.null)");
  const rows = (data ?? []) as GalleryRow[];
  for (const row of rows) {
    const updates: Record<string, unknown> = {};
    if (!row.iv) {
      const { data: signed } = await supabase.storage
        .from("gallery")
        .createSignedUrl(row.storage_path, 60 * 10);
      if (signed?.signedUrl) {
        const res = await fetch(signed.signedUrl);
        const blob = await res.blob();
        const mime = blob.type || "image/jpeg";
        const { blob: encBlob, iv } = await encryptBlob(key, blob);
        const { error: upErr } = await supabase.storage
          .from("gallery")
          .upload(row.storage_path, encBlob, {
            contentType: "application/octet-stream",
            upsert: true,
          });
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
      await supabase.from("gallery_images").update(updates).eq("id", row.id);
    }
  }
}

async function migrateChatSessions(userId: string, key: CryptoKey) {
  const { data: sessions } = await supabase
    .from("chat_sessions")
    .select("id,title,title_iv,last_message_at")
    .eq("user_id", userId)
    .order("last_message_at", { ascending: false });

  if (!sessions || sessions.length === 0) return;

  const kept = sessions.slice(0, 7);
  const excessIds = sessions.slice(7).map((s) => s.id);
  if (excessIds.length > 0) {
    await supabase.from("chat_sessions").delete().in("id", excessIds);
  }

  await Promise.all(
    kept.map(async (s) => {
      if (!s.title_iv && s.title) {
        const enc = await encryptText(key, s.title);
        await supabase
          .from("chat_sessions")
          .update({ title: enc.ct, title_iv: enc.iv })
          .eq("id", s.id);
      }
    }),
  );
}

async function migrateChatMessages(userId: string, key: CryptoKey) {
  const { data } = await supabase
    .from("chat_messages")
    .select("id,content,iv")
    .eq("user_id", userId)
    .is("iv", null);
  const rows = data ?? [];
  await Promise.all(
    rows.map(async (m) => {
      if (m.iv) return;
      const enc = await encryptText(key, m.content);
      await supabase.from("chat_messages").update({ content: enc.ct, iv: enc.iv }).eq("id", m.id);
    }),
  );
}
