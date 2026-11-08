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
    const decoded = JSON.parse(plain) as VaultTrackersData & { uid?: string };
    if (decoded.uid && decoded.uid !== userId) return null;
    return decoded;
  } catch {
    return null;
  }
}

async function writeEncrypted(
  userId: string,
  key: CryptoKey,
  data: VaultTrackersData,
): Promise<void> {
  const payload = {
    ...data,
    uid: userId,
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

async function fetchRemoteTrackers(
  userId: string,
  key: CryptoKey,
  local: VaultTrackersData | null,
): Promise<VaultTrackersData | null> {
  try {
    const { data: signed } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(storagePath(userId), 60 * 10);
    if (signed?.signedUrl) {
      const res = await fetch(signed.signedUrl, { cache: "no-store" });
      if (res.ok) {
        const text = await res.text();
        const parsed = JSON.parse(text) as { ct?: string; iv?: string };
        if (parsed?.ct && parsed?.iv) {
          const plain = await decryptText(key, parsed.ct, parsed.iv);
          const remote = JSON.parse(plain) as VaultTrackersData & { uid?: string };
          if (remote.uid && remote.uid !== userId) return null;
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
  return null;
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
      const local = await readLocalEncrypted(userId, key);
      if (local) {
        const normalizedLocal: VaultTrackersData = {
          moods: Array.isArray(local.moods) ? local.moods : [],
          goals: Array.isArray(local.goals) ? local.goals : [],
          updated_at: local.updated_at || new Date().toISOString(),
        };
        // Revalidate remote in background without blocking UI
        void fetchRemoteTrackers(userId, key, normalizedLocal).then((remote) => {
          if (remote && remote.updated_at !== normalizedLocal.updated_at) {
            qc.setQueryData(queryKey, remote);
          }
        });
        return normalizedLocal;
      }

      const remote = await fetchRemoteTrackers(userId, key, null);
      if (remote) return remote;

      // Seed local encrypted empty state so future loads are <1ms
      try {
        const enc = await encryptText(key, JSON.stringify(EMPTY_TRACKERS));
        window.localStorage.setItem(localCacheKey(userId), JSON.stringify(enc));
      } catch {
        // ignore
      }
      return EMPTY_TRACKERS;
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
      await writeEncrypted(userId, key, next);
      return next;
    },
    onMutate: async (updater) => {
      await qc.cancelQueries({ queryKey });
      const prev = qc.getQueryData<VaultTrackersData>(queryKey) ?? query.data ?? EMPTY_TRACKERS;
      const optimisticNext: VaultTrackersData = {
        ...updater(prev),
        updated_at: new Date().toISOString(),
      };
      qc.setQueryData<VaultTrackersData>(queryKey, optimisticNext);
      return { prev };
    },
    onError: (_err, _updater, context) => {
      if (context?.prev) {
        qc.setQueryData<VaultTrackersData>(queryKey, context.prev);
      }
    },
  });

  return {
    data: query.data ?? EMPTY_TRACKERS,
    isLoading: query.isLoading,
    updateTrackers: saveMutation.mutate,
    isSaving: saveMutation.isPending,
  };
}
