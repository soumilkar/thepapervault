import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useVault } from "@/lib/vault";
import { decryptText, encryptText } from "@/lib/crypto";

export type MoodLevel = 1 | 2 | 3 | 4 | 5;

export type MoodLogItem = {
  id: string;
  date: string; // YYYY-MM-DD
  level: MoodLevel;
  note: string;
  created_at: string;
};

export type GoalHorizon = "daily" | "weekly" | "monthly" | "long-term";

export type GoalItem = {
  id: string;
  title: string;
  horizon: GoalHorizon;
  progress: number; // 0 to 100
  completed: boolean;
  created_at: string;
};

export type VaultTrackersData = {
  moods: MoodLogItem[];
  goals: GoalItem[];
  updated_at: string;
};

const EMPTY_TRACKERS: VaultTrackersData = {
  moods: [],
  goals: [],
  updated_at: new Date(0).toISOString(),
};

const BUCKET = "media";
const storagePath = (userId: string) => `${userId}/vault-trackers.bin`;
const localCacheKey = (userId: string) => `papervault:trackers:v1:${userId}`;

async function readLocalEncrypted(
  userId: string,
  key: CryptoKey,
): Promise<VaultTrackersData | null> {
  try {
    const raw = window.localStorage.getItem(localCacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ct?: string; iv?: string };
    if (!parsed?.ct || !parsed?.iv) return null;
    const plain = await decryptText(key, parsed.ct, parsed.iv);
    return JSON.parse(plain) as VaultTrackersData;
  } catch {
    return null;
  }
}

async function writeEncrypted(
  userId: string,
  key: CryptoKey,
  data: VaultTrackersData,
): Promise<void> {
  const payload: VaultTrackersData = {
    ...data,
    updated_at: new Date().toISOString(),
  };
  const enc = await encryptText(key, JSON.stringify(payload));
  const serialized = JSON.stringify(enc);

  try {
    window.localStorage.setItem(localCacheKey(userId), serialized);
  } catch {
    // ignore localStorage quota errors
  }

  const blob = new Blob([serialized], { type: "application/octet-stream" });
  await supabase.storage
    .from(BUCKET)
    .upload(storagePath(userId), blob, { contentType: "application/octet-stream", upsert: true });
}

async function loadEncryptedTrackers(userId: string, key: CryptoKey): Promise<VaultTrackersData> {
  const local = await readLocalEncrypted(userId, key);

  try {
    const { data: signed } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(storagePath(userId), 60 * 10);
    if (signed?.signedUrl) {
      const res = await fetch(signed.signedUrl);
      if (res.ok) {
        const text = await res.text();
        const parsed = JSON.parse(text) as { ct?: string; iv?: string };
        if (parsed?.ct && parsed?.iv) {
          const plain = await decryptText(key, parsed.ct, parsed.iv);
          const remote = JSON.parse(plain) as VaultTrackersData;
          if (
            !local ||
            new Date(remote.updated_at).getTime() >= new Date(local.updated_at).getTime()
          ) {
            try {
              window.localStorage.setItem(localCacheKey(userId), text);
            } catch {
              // ignore
            }
            return {
              moods: Array.isArray(remote.moods) ? remote.moods : [],
              goals: Array.isArray(remote.goals) ? remote.goals : [],
              updated_at: remote.updated_at || new Date().toISOString(),
            };
          }
        }
      }
    }
  } catch {
    // fallback to local encrypted copy if remote object doesn't exist yet
  }

  if (local) {
    return {
      moods: Array.isArray(local.moods) ? local.moods : [],
      goals: Array.isArray(local.goals) ? local.goals : [],
      updated_at: local.updated_at || new Date().toISOString(),
    };
  }

  return EMPTY_TRACKERS;
}

export function useVaultTrackers(userId: string) {
  const { key } = useVault();
  const qc = useQueryClient();
  const queryKey = ["vault-trackers", userId];

  const query = useQuery({
    enabled: !!key,
    queryKey,
    queryFn: async () => {
      if (!key) return EMPTY_TRACKERS;
      return loadEncryptedTrackers(userId, key);
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (updater: (prev: VaultTrackersData) => VaultTrackersData) => {
      if (!key) throw new Error("Vault is locked");
      const current = qc.getQueryData<VaultTrackersData>(queryKey) ?? query.data ?? EMPTY_TRACKERS;
      const next: VaultTrackersData = {
        ...updater(current),
        updated_at: new Date().toISOString(),
      };
      qc.setQueryData(queryKey, next);
      await writeEncrypted(userId, key, next);
      return next;
    },
  });

  return {
    data: query.data ?? EMPTY_TRACKERS,
    isLoading: query.isLoading,
    updateTrackers: saveMutation.mutate,
    isSaving: saveMutation.isPending,
  };
}
