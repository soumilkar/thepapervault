import { supabase } from "@/integrations/supabase/client";
import {
  decryptBytes,
  decryptField,
  decryptText,
  deriveDataKey,
  encryptField,
  encryptText,
  isEncryptedField,
  randomBytes,
  toB64,
} from "@/lib/crypto";
import { getFreshAccessToken } from "@/lib/offline-supabase";

export type RecoveryEnvelope = {
  salt: string;
  iv: string;
  ct: string;
  created_at: string;
};

export type VaultMetaRecord = {
  user_id: string;
  kdf_salt: string;
  verifier: string;
  verifier_salt: string;
  updated_at: string;
  recovery_envelope?: RecoveryEnvelope | null;
  encrypted_recovery_key?: { ct: string; iv: string } | null;
};

const RECOVERY_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 32 unambiguous chars
const VAULT_META_BUCKET = "media";
const vaultMetaStoragePath = (userId: string) => `${userId}/vault-meta.bin`;

export function generateRecoveryKey(): string {
  const bytes = randomBytes(24);
  const groups: string[] = [];
  for (let g = 0; g < 6; g++) {
    let part = "";
    for (let i = 0; i < 4; i++) {
      const idx = bytes[g * 4 + i] % RECOVERY_ALPHABET.length;
      part += RECOVERY_ALPHABET[idx];
    }
    groups.push(part);
  }
  return `PV-${groups.join("-")}`;
}

export function normalizeRecoveryKey(raw: string): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^PV/, "");
  return `PV:${cleaned}`;
}

export async function createRecoveryEnvelope(
  passphrase: string,
  recoveryKey: string,
): Promise<RecoveryEnvelope> {
  const salt = toB64(randomBytes(16));
  const wrappingKey = await deriveDataKey(normalizeRecoveryKey(recoveryKey), salt);
  const { ct, iv } = await encryptText(wrappingKey, passphrase);
  return {
    salt,
    iv,
    ct,
    created_at: new Date().toISOString(),
  };
}

export async function unwrapRecoveryEnvelope(
  envelope: RecoveryEnvelope,
  recoveryKey: string,
): Promise<string> {
  const wrappingKey = await deriveDataKey(normalizeRecoveryKey(recoveryKey), envelope.salt);
  try {
    return await decryptText(wrappingKey, envelope.ct, envelope.iv);
  } catch {
    throw new Error("Invalid Recovery Key. Please check the code and try again.");
  }
}

export async function fetchRemoteVaultMeta(userId: string): Promise<VaultMetaRecord | null> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return null;
  try {
    const token = await getFreshAccessToken();
    if (token) {
      const res = await fetch(
        `/api/storage-proxy?action=download&bucket=${encodeURIComponent(VAULT_META_BUCKET)}&path=${encodeURIComponent(vaultMetaStoragePath(userId))}&_t=${Date.now()}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        },
      );
      if (res.ok) {
        const text = await res.text();
        const parsed = JSON.parse(text) as VaultMetaRecord;
        if (
          parsed &&
          parsed.user_id === userId &&
          typeof parsed.kdf_salt === "string" &&
          typeof parsed.verifier === "string" &&
          typeof parsed.verifier_salt === "string"
        ) {
          return parsed;
        }
      }
    }
  } catch {
    // ignore network errors
  }
  return null;
}

export async function writeRemoteVaultMeta(record: VaultMetaRecord): Promise<void> {
  const serialized = JSON.stringify(record);
  const blob = new Blob([serialized], { type: "application/octet-stream" });

  if (typeof navigator !== "undefined" && navigator.onLine) {
    try {
      const token = await getFreshAccessToken();
      if (token) {
        const res = await fetch(
          `/api/storage-proxy?action=upload&bucket=${encodeURIComponent(VAULT_META_BUCKET)}&path=${encodeURIComponent(vaultMetaStoragePath(record.user_id))}&upsert=true`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/octet-stream",
            },
            body: blob,
          },
        );
        if (res.ok) return;
      }
    } catch {
      // fall through to supabase.storage
    }
  }

  await supabase.storage
    .from(VAULT_META_BUCKET)
    .upload(vaultMetaStoragePath(record.user_id), blob, {
      contentType: "application/octet-stream",
      upsert: true,
    });
}

async function encryptRawBytes(
  key: CryptoKey,
  plainBuffer: ArrayBuffer,
): Promise<{ blob: Blob; iv: string }> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource, tagLength: 128 },
    key,
    plainBuffer,
  );
  return {
    blob: new Blob([ct], { type: "application/octet-stream" }),
    iv: toB64(iv),
  };
}

async function reencryptStorageJsonFile(
  userId: string,
  bucket: "media" | "gallery",
  path: string,
  localKey: string,
  oldKey: CryptoKey,
  newKey: CryptoKey,
): Promise<void> {
  let plainJson: string | null = null;

  // 1. Try remote first when online
  if (typeof navigator !== "undefined" && navigator.onLine) {
    try {
      const token = await getFreshAccessToken();
      if (token) {
        const res = await fetch(
          `/api/storage-proxy?action=download&bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}&_t=${Date.now()}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            cache: "no-store",
          },
        );
        if (res.ok) {
          const text = await res.text();
          const parsed = JSON.parse(text) as { ct?: string; iv?: string };
          if (parsed?.ct && parsed?.iv) {
            plainJson = await decryptText(oldKey, parsed.ct, parsed.iv);
          }
        }
      }
    } catch {
      // fallback to localStorage
    }
  }

  // 2. Try localStorage if remote didn't yield plaintext
  if (!plainJson && typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(localKey);
      if (raw) {
        const parsed = JSON.parse(raw) as { ct?: string; iv?: string };
        if (parsed?.ct && parsed?.iv) {
          plainJson = await decryptText(oldKey, parsed.ct, parsed.iv);
        }
      }
    } catch {
      // ignore
    }
  }

  if (!plainJson) return;

  const reencrypted = await encryptText(newKey, plainJson);
  const serialized = JSON.stringify(reencrypted);

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(localKey, serialized);
    } catch {
      // ignore
    }
  }

  const blob = new Blob([serialized], { type: "application/octet-stream" });
  if (typeof navigator !== "undefined" && navigator.onLine) {
    try {
      const token = await getFreshAccessToken();
      if (token) {
        const res = await fetch(
          `/api/storage-proxy?action=upload&bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}&upsert=true`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/octet-stream",
            },
            body: blob,
          },
        );
        if (res.ok) return;
      }
    } catch {
      // fallback
    }
  }

  await supabase.storage
    .from(bucket)
    .upload(path, blob, { contentType: "application/octet-stream", upsert: true });
}

export async function reencryptUserVaultData(
  userId: string,
  oldKey: CryptoKey,
  newKey: CryptoKey,
  onProgress?: (label: string) => void,
): Promise<void> {
  // 1. Diary entries (private encrypted rows)
  onProgress?.("Re-encrypting diary entries...");
  const { data: diaryRows } = await supabase
    .from("diary_entries")
    .select("id,content,iv,is_public")
    .eq("user_id", userId);
  for (const row of (diaryRows ?? []) as {
    id: string;
    content: string;
    iv: string | null;
    is_public: boolean;
  }[]) {
    if (row.is_public || !row.iv || !row.content) continue;
    try {
      const plain = await decryptText(oldKey, row.content, row.iv);
      const { ct, iv } = await encryptText(newKey, plain);
      await supabase
        .from("diary_entries")
        .update({ content: ct, iv })
        .eq("id", row.id)
        .eq("user_id", userId);
    } catch {
      // skip rows that cannot be decrypted with oldKey
    }
  }

  // 2. Diary folders & Note folders
  onProgress?.("Re-encrypting folders...");
  for (const table of ["diary_folders", "note_folders"] as const) {
    const { data: folders } = await supabase.from(table).select("id,name").eq("user_id", userId);
    for (const f of (folders ?? []) as { id: string; name: string }[]) {
      if (!f.name || !isEncryptedField(f.name)) continue;
      try {
        const { plaintext } = await decryptField(oldKey, f.name);
        const encName = await encryptField(newKey, plaintext);
        await supabase.from(table).update({ name: encName }).eq("id", f.id).eq("user_id", userId);
      } catch {
        // skip
      }
    }
  }

  // 3. Notes
  onProgress?.("Re-encrypting notes...");
  const { data: noteRows } = await supabase
    .from("notes")
    .select("id,content,iv")
    .eq("user_id", userId);
  for (const row of (noteRows ?? []) as { id: string; content: string; iv: string | null }[]) {
    if (!row.iv || !row.content) continue;
    try {
      const plain = await decryptText(oldKey, row.content, row.iv);
      const { ct, iv } = await encryptText(newKey, plain);
      await supabase
        .from("notes")
        .update({ content: ct, iv })
        .eq("id", row.id)
        .eq("user_id", userId);
    } catch {
      // skip
    }
  }

  // 4. Companion Chat Sessions & Messages
  onProgress?.("Re-encrypting companion chats...");
  const { data: chatSessions } = await supabase
    .from("chat_sessions")
    .select("id,title,title_iv")
    .eq("user_id", userId);
  for (const s of (chatSessions ?? []) as {
    id: string;
    title: string;
    title_iv: string | null;
  }[]) {
    if (!s.title_iv || !s.title) continue;
    try {
      const plain = await decryptText(oldKey, s.title, s.title_iv);
      const { ct, iv } = await encryptText(newKey, plain);
      await supabase
        .from("chat_sessions")
        .update({ title: ct, title_iv: iv })
        .eq("id", s.id)
        .eq("user_id", userId);
    } catch {
      // skip
    }
  }

  const { data: chatMessages } = await supabase
    .from("chat_messages")
    .select("id,content,iv")
    .eq("user_id", userId);
  for (const m of (chatMessages ?? []) as { id: string; content: string; iv: string | null }[]) {
    if (!m.iv || !m.content) continue;
    try {
      const plain = await decryptText(oldKey, m.content, m.iv);
      const { ct, iv } = await encryptText(newKey, plain);
      await supabase
        .from("chat_messages")
        .update({ content: ct, iv })
        .eq("id", m.id)
        .eq("user_id", userId);
    } catch {
      // skip
    }
  }

  // 5. Gallery images (captions + encrypted image binaries)
  onProgress?.("Re-encrypting gallery photos...");
  const { data: galleryRows } = await supabase
    .from("gallery_images")
    .select("id,storage_path,caption,iv,caption_iv")
    .eq("user_id", userId);
  const token = await getFreshAccessToken();
  for (const g of (galleryRows ?? []) as {
    id: string;
    storage_path: string;
    caption: string | null;
    iv: string | null;
    caption_iv: string | null;
  }[]) {
    const updates: Record<string, unknown> = {};
    if (g.caption && g.caption_iv) {
      try {
        const plainCap = await decryptText(oldKey, g.caption, g.caption_iv);
        const { ct, iv } = await encryptText(newKey, plainCap);
        updates.caption = ct;
        updates.caption_iv = iv;
      } catch {
        // skip caption
      }
    }
    if (g.iv && g.storage_path && token) {
      try {
        const dlRes = await fetch(
          `/api/storage-proxy?action=download&bucket=gallery&path=${encodeURIComponent(g.storage_path)}&_t=${Date.now()}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            cache: "no-store",
          },
        );
        if (dlRes.ok) {
          const encBuf = await dlRes.arrayBuffer();
          const plainBuf = await decryptBytes(oldKey, encBuf, g.iv);
          const { blob: newEncBlob, iv: newIv } = await encryptRawBytes(newKey, plainBuf);
          const upRes = await fetch(
            `/api/storage-proxy?action=upload&bucket=gallery&path=${encodeURIComponent(g.storage_path)}&upsert=true`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/octet-stream",
              },
              body: newEncBlob,
            },
          );
          if (upRes.ok) {
            updates.iv = newIv;
          }
        }
      } catch {
        // skip binary if unreachable
      }
    }
    if (Object.keys(updates).length > 0) {
      await supabase.from("gallery_images").update(updates).eq("id", g.id).eq("user_id", userId);
    }
  }

  // 6. Trackers & Gallery Folders .bin blobs
  onProgress?.("Re-encrypting trackers and gallery folders...");
  await reencryptStorageJsonFile(
    userId,
    "media",
    `${userId}/vault-trackers.bin`,
    `papervault:trackers:v1:${userId}`,
    oldKey,
    newKey,
  );
  await reencryptStorageJsonFile(
    userId,
    "gallery",
    `${userId}/gallery-folders.bin`,
    `papervault:gallery-folders:v1:${userId}`,
    oldKey,
    newKey,
  );

  // 7. Browser drafts in localStorage
  if (typeof window !== "undefined") {
    try {
      const keysToCheck: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && (k.includes("draft") || k.startsWith("pv:")) && k.includes(userId)) {
          keysToCheck.push(k);
        }
      }
      for (const k of keysToCheck) {
        try {
          const raw = window.localStorage.getItem(k);
          if (!raw) continue;
          const parsed = JSON.parse(raw) as { ct?: string; iv?: string };
          if (parsed?.ct && parsed?.iv) {
            const plain = await decryptText(oldKey, parsed.ct, parsed.iv);
            const reenc = await encryptText(newKey, plain);
            window.localStorage.setItem(k, JSON.stringify(reenc));
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }
}

export async function wipeAndResetUserVault(userId: string): Promise<void> {
  // Remove unreadable encrypted user data when the user explicitly resets a forgotten vault without a recovery key
  await Promise.allSettled([
    supabase.from("diary_entries").delete().eq("user_id", userId).eq("is_public", false),
    supabase.from("diary_folders").delete().eq("user_id", userId),
    supabase.from("notes").delete().eq("user_id", userId),
    supabase.from("note_folders").delete().eq("user_id", userId),
    supabase.from("gallery_images").delete().eq("user_id", userId),
    supabase.from("chat_messages").delete().eq("user_id", userId),
    supabase.from("chat_sessions").delete().eq("user_id", userId),
    supabase.from("vault_keys").delete().eq("user_id", userId),
  ]);

  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(`papervault:trackers:v1:${userId}`);
      window.localStorage.removeItem(`papervault:gallery-folders:v1:${userId}`);
      window.localStorage.removeItem(`papervault:vault_meta:${userId}`);
    } catch {
      // ignore
    }
  }
}
