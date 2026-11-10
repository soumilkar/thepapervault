import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useVault } from "@/lib/vault";
import { decryptText, encryptText } from "@/lib/crypto";
import { getFreshAccessToken } from "@/lib/offline-supabase";

export type MoodLevel = 1 | 2 | 3 | 4 | 5;

export type MoodLogItem = {
  id: string;
  date: string; // YYYY-MM-DD
  level: MoodLevel;
  note: string;
  created_at: string;
  updated_at?: string;
};

export type GoalHorizon = "daily" | "weekly" | "monthly" | "long-term";

export type GoalItem = {
  id: string;
  title: string;
  horizon: GoalHorizon;
  progress: number; // 0 to 100
  completed: boolean;
  created_at: string;
  updated_at?: string;
};

export type VaultTrackersData = {
  moods: MoodLogItem[];
  goals: GoalItem[];
  updated_at: string;
  deleted_ids?: Record<string, string>;
};

const EMPTY_TRACKERS: VaultTrackersData = {
  moods: [],
  goals: [],
  updated_at: new Date(0).toISOString(),
  deleted_ids: {},
};

const BUCKET = "media";
const storagePath = (userId: string) => `${userId}/vault-trackers.bin`;
const localCacheKey = (userId: string) => `papervault:trackers:v1:${userId}`;

function itemTimestamp(item: { updated_at?: string; created_at?: string }): number {
  const ts = item.updated_at || item.created_at;
  if (!ts) return 0;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function mergeTrackersData(
  a: VaultTrackersData | null,
  b: VaultTrackersData | null,
): { merged: VaultTrackersData; needsPush: boolean } {
  if (!a && !b) return { merged: EMPTY_TRACKERS, needsPush: false };
  if (!a) {
    return {
      merged: {
        moods: Array.isArray(b?.moods) ? b.moods : [],
        goals: Array.isArray(b?.goals) ? b.goals : [],
        updated_at: b?.updated_at || new Date(0).toISOString(),
        deleted_ids: b?.deleted_ids ?? {},
      },
      needsPush: false,
    };
  }
  if (!b) {
    const hasLocalItems =
      (a.moods?.length ?? 0) > 0 ||
      (a.goals?.length ?? 0) > 0 ||
      Object.keys(a.deleted_ids ?? {}).length > 0;
    return {
      merged: {
        moods: Array.isArray(a.moods) ? a.moods : [],
        goals: Array.isArray(a.goals) ? a.goals : [],
        updated_at: a.updated_at || new Date(0).toISOString(),
        deleted_ids: a.deleted_ids ?? {},
      },
      needsPush: hasLocalItems,
    };
  }

  // Merge deletion tombstones (a = local, b = remote)
  const deletedIds: Record<string, string> = { ...(b.deleted_ids ?? {}) };
  for (const [id, ts] of Object.entries(a.deleted_ids ?? {})) {
    const existing = deletedIds[id];
    if (!existing || Date.parse(ts) > Date.parse(existing)) {
      deletedIds[id] = ts;
    }
  }

  // Merge moods by date and ID (keeping newer timestamp, respecting deleted_ids)
  const moodByDate = new Map<string, MoodLogItem>();
  for (const m of [...(b.moods ?? []), ...(a.moods ?? [])]) {
    if (!m || !m.id) continue;
    const delTs = deletedIds[m.id];
    if (delTs && Date.parse(delTs) >= itemTimestamp(m)) continue;
    const key = m.date || m.id;
    const existing = moodByDate.get(key);
    if (!existing || itemTimestamp(m) >= itemTimestamp(existing)) {
      moodByDate.set(key, m);
    }
  }

  // Merge goals by ID (keeping newer timestamp, respecting deleted_ids)
  const goalById = new Map<string, GoalItem>();
  for (const g of [...(b.goals ?? []), ...(a.goals ?? [])]) {
    if (!g || !g.id) continue;
    const delTs = deletedIds[g.id];
    if (delTs && Date.parse(delTs) >= itemTimestamp(g)) continue;
    const existing = goalById.get(g.id);
    if (!existing || itemTimestamp(g) >= itemTimestamp(existing)) {
      goalById.set(g.id, g);
    }
  }

  const mergedMoods = Array.from(moodByDate.values());
  const mergedGoals = Array.from(goalById.values());
  const maxUpdated =
    Date.parse(a.updated_at || "") > Date.parse(b.updated_at || "")
      ? a.updated_at
      : b.updated_at || new Date().toISOString();

  // Check if merged differs from remote (b) so we know whether to push merged back to server
  const remoteMoodIds = new Set((b.moods ?? []).map((m) => `${m.id}:${m.level}:${m.note}`));
  const remoteGoalIds = new Set(
    (b.goals ?? []).map((g) => `${g.id}:${g.title}:${g.progress}:${g.completed}`),
  );
  const needsPush =
    mergedMoods.length !== (b.moods ?? []).length ||
    mergedGoals.length !== (b.goals ?? []).length ||
    mergedMoods.some((m) => !remoteMoodIds.has(`${m.id}:${m.level}:${m.note}`)) ||
    mergedGoals.some((g) => !remoteGoalIds.has(`${g.id}:${g.title}:${g.progress}:${g.completed}`));

  return {
    merged: {
      moods: mergedMoods,
      goals: mergedGoals,
      updated_at: maxUpdated,
      deleted_ids: deletedIds,
    },
    needsPush,
  };
}

function applyDiffMetadata(prev: VaultTrackersData, next: VaultTrackersData): VaultTrackersData {
  const nowIso = new Date().toISOString();
  const deletedIds: Record<string, string> = {
    ...(prev.deleted_ids ?? {}),
    ...(next.deleted_ids ?? {}),
  };

  const nextMoodIds = new Set((next.moods ?? []).map((m) => m.id));
  for (const m of prev.moods ?? []) {
    if (m.id && !nextMoodIds.has(m.id)) {
      deletedIds[m.id] = nowIso;
    }
  }

  const nextGoalIds = new Set((next.goals ?? []).map((g) => g.id));
  for (const g of prev.goals ?? []) {
    if (g.id && !nextGoalIds.has(g.id)) {
      deletedIds[g.id] = nowIso;
    }
  }

  const prevMoodMap = new Map((prev.moods ?? []).map((m) => [m.id, m]));
  const updatedMoods = (next.moods ?? []).map((m) => {
    const old = prevMoodMap.get(m.id);
    if (!old || old.level !== m.level || old.note !== m.note || old.date !== m.date) {
      return { ...m, updated_at: nowIso };
    }
    return m;
  });

  const prevGoalMap = new Map((prev.goals ?? []).map((g) => [g.id, g]));
  const updatedGoals = (next.goals ?? []).map((g) => {
    const old = prevGoalMap.get(g.id);
    if (
      !old ||
      old.title !== g.title ||
      old.horizon !== g.horizon ||
      old.progress !== g.progress ||
      old.completed !== g.completed
    ) {
      return { ...g, updated_at: nowIso };
    }
    return g;
  });

  return {
    moods: updatedMoods,
    goals: updatedGoals,
    updated_at: nowIso,
    deleted_ids: deletedIds,
  };
}

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
    return {
      moods: Array.isArray(decoded.moods) ? decoded.moods : [],
      goals: Array.isArray(decoded.goals) ? decoded.goals : [],
      updated_at: decoded.updated_at || new Date(0).toISOString(),
      deleted_ids: decoded.deleted_ids ?? {},
    };
  } catch {
    return null;
  }
}

async function saveLocalEncrypted(
  userId: string,
  key: CryptoKey,
  data: VaultTrackersData,
): Promise<string> {
  const payload = {
    ...data,
    uid: userId,
    updated_at: data.updated_at || new Date().toISOString(),
  };
  const enc = await encryptText(key, JSON.stringify(payload));
  const serialized = JSON.stringify(enc);
  try {
    window.localStorage.setItem(localCacheKey(userId), serialized);
  } catch {
    // ignore localStorage quota errors
  }
  return serialized;
}

async function writeEncrypted(
  userId: string,
  key: CryptoKey,
  data: VaultTrackersData,
): Promise<void> {
  const serialized = await saveLocalEncrypted(userId, key, data);
  const blob = new Blob([serialized], { type: "application/octet-stream" });

  if (typeof navigator !== "undefined" && navigator.onLine) {
    try {
      const token = await getFreshAccessToken();
      if (token) {
        const res = await fetch(
          `/api/storage-proxy?action=upload&bucket=${encodeURIComponent(BUCKET)}&path=${encodeURIComponent(storagePath(userId))}&upsert=true`,
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
    .from(BUCKET)
    .upload(storagePath(userId), blob, { contentType: "application/octet-stream", upsert: true });
}

async function fetchRemoteTrackers(
  userId: string,
  key: CryptoKey,
): Promise<VaultTrackersData | null> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return null;
  try {
    const token = await getFreshAccessToken();
    if (token) {
      const directRes = await fetch(
        `/api/storage-proxy?action=download&bucket=${encodeURIComponent(BUCKET)}&path=${encodeURIComponent(storagePath(userId))}&_t=${Date.now()}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        },
      );
      if (directRes.ok) {
        const text = await directRes.text();
        const parsed = JSON.parse(text) as { ct?: string; iv?: string };
        if (parsed?.ct && parsed?.iv) {
          const plain = await decryptText(key, parsed.ct, parsed.iv);
          const remote = JSON.parse(plain) as VaultTrackersData & { uid?: string };
          if (remote.uid && remote.uid !== userId) return null;
          return {
            moods: Array.isArray(remote.moods) ? remote.moods : [],
            goals: Array.isArray(remote.goals) ? remote.goals : [],
            updated_at: remote.updated_at || new Date(0).toISOString(),
            deleted_ids: remote.deleted_ids ?? {},
          };
        }
      } else if (directRes.status === 400 || directRes.status === 404) {
        return null;
      }
    }

    const { data: signed } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(storagePath(userId), 60 * 10);
    if (signed?.signedUrl) {
      const sep = signed.signedUrl.includes("?") ? "&" : "?";
      const res = await fetch(`${signed.signedUrl}${sep}_t=${Date.now()}`, { cache: "no-store" });
      if (res.ok) {
        const text = await res.text();
        const parsed = JSON.parse(text) as { ct?: string; iv?: string };
        if (parsed?.ct && parsed?.iv) {
          const plain = await decryptText(key, parsed.ct, parsed.iv);
          const remote = JSON.parse(plain) as VaultTrackersData & { uid?: string };
          if (remote.uid && remote.uid !== userId) return null;
          return {
            moods: Array.isArray(remote.moods) ? remote.moods : [],
            goals: Array.isArray(remote.goals) ? remote.goals : [],
            updated_at: remote.updated_at || new Date(0).toISOString(),
            deleted_ids: remote.deleted_ids ?? {},
          };
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
    enabled: !!key && !!userId,
    queryKey,
    queryFn: async () => {
      if (!key) return EMPTY_TRACKERS;
      const [local, remote] = await Promise.all([
        readLocalEncrypted(userId, key),
        fetchRemoteTrackers(userId, key),
      ]);

      const { merged, needsPush } = mergeTrackersData(local, remote);
      await saveLocalEncrypted(userId, key, merged);

      if (needsPush && typeof navigator !== "undefined" && navigator.onLine) {
        void writeEncrypted(userId, key, merged).catch(() => {});
      }

      return merged;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (updater: (prev: VaultTrackersData) => VaultTrackersData) => {
      if (!key) throw new Error("Vault is locked");
      const current = qc.getQueryData<VaultTrackersData>(queryKey) ?? query.data ?? EMPTY_TRACKERS;
      const rawNext = updater(current);
      const diffedNext = applyDiffMetadata(current, rawNext);

      const remote = await fetchRemoteTrackers(userId, key);
      const { merged } = mergeTrackersData(diffedNext, remote);
      const finalNext: VaultTrackersData = {
        ...merged,
        updated_at: new Date().toISOString(),
      };
      await writeEncrypted(userId, key, finalNext);
      return finalNext;
    },
    onMutate: async (updater) => {
      await qc.cancelQueries({ queryKey });
      const prev = qc.getQueryData<VaultTrackersData>(queryKey) ?? query.data ?? EMPTY_TRACKERS;
      const rawNext = updater(prev);
      const optimisticNext = applyDiffMetadata(prev, rawNext);
      qc.setQueryData<VaultTrackersData>(queryKey, optimisticNext);
      return { prev };
    },
    onSuccess: (saved) => {
      qc.setQueryData<VaultTrackersData>(queryKey, saved);
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
