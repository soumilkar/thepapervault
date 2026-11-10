import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useVault } from "@/lib/vault";
import { decryptText, encryptText } from "@/lib/crypto";
import { getFreshAccessToken } from "@/lib/offline-supabase";

export type GalleryFolder = {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
  updated_at?: string;
};

type GalleryFoldersPayload = {
  folders: GalleryFolder[];
  updated_at: string;
  deleted_ids?: Record<string, string>;
};

const BUCKET = "gallery";
const storagePath = (userId: string) => `${userId}/gallery-folders.bin`;
const localCacheKey = (userId: string) => `papervault:gallery-folders:v1:${userId}`;

function folderTimestamp(f: GalleryFolder): number {
  const ts = f.updated_at || f.created_at;
  if (!ts) return 0;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function mergeGalleryFoldersPayload(
  local: GalleryFoldersPayload | null,
  remote: GalleryFoldersPayload | null,
): { merged: GalleryFoldersPayload; needsPush: boolean } {
  if (!local && !remote) {
    return {
      merged: { folders: [], updated_at: new Date(0).toISOString(), deleted_ids: {} },
      needsPush: false,
    };
  }
  if (!local) {
    return {
      merged: {
        folders: Array.isArray(remote?.folders) ? remote.folders : [],
        updated_at: remote?.updated_at || new Date(0).toISOString(),
        deleted_ids: remote?.deleted_ids ?? {},
      },
      needsPush: false,
    };
  }
  if (!remote) {
    const hasLocal =
      (local.folders?.length ?? 0) > 0 || Object.keys(local.deleted_ids ?? {}).length > 0;
    return {
      merged: {
        folders: Array.isArray(local.folders) ? local.folders : [],
        updated_at: local.updated_at || new Date(0).toISOString(),
        deleted_ids: local.deleted_ids ?? {},
      },
      needsPush: hasLocal,
    };
  }

  const deletedIds: Record<string, string> = { ...(remote.deleted_ids ?? {}) };
  for (const [id, ts] of Object.entries(local.deleted_ids ?? {})) {
    const existing = deletedIds[id];
    if (!existing || Date.parse(ts) > Date.parse(existing)) {
      deletedIds[id] = ts;
    }
  }

  const byId = new Map<string, GalleryFolder>();
  for (const f of [...(remote.folders ?? []), ...(local.folders ?? [])]) {
    if (!f || !f.id) continue;
    const delTs = deletedIds[f.id];
    if (delTs && Date.parse(delTs) >= folderTimestamp(f)) continue;
    const existing = byId.get(f.id);
    if (!existing || folderTimestamp(f) >= folderTimestamp(existing)) {
      byId.set(f.id, f);
    }
  }

  const mergedFolders = Array.from(byId.values());
  const maxUpdated =
    Date.parse(local.updated_at || "") > Date.parse(remote.updated_at || "")
      ? local.updated_at
      : remote.updated_at || new Date().toISOString();

  const remoteKeys = new Set(
    (remote.folders ?? []).map((f) => `${f.id}:${f.name}:${f.parent_id ?? ""}`),
  );
  const needsPush =
    mergedFolders.length !== (remote.folders ?? []).length ||
    mergedFolders.some((f) => !remoteKeys.has(`${f.id}:${f.name}:${f.parent_id ?? ""}`));

  return {
    merged: {
      folders: mergedFolders,
      updated_at: maxUpdated,
      deleted_ids: deletedIds,
    },
    needsPush,
  };
}

async function readLocalEncrypted(
  userId: string,
  key: CryptoKey,
): Promise<GalleryFoldersPayload | null> {
  try {
    const raw = window.localStorage.getItem(localCacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ct?: string; iv?: string };
    if (!parsed?.ct || !parsed?.iv) return null;
    const plain = await decryptText(key, parsed.ct, parsed.iv);
    const decoded = JSON.parse(plain) as GalleryFoldersPayload & { uid?: string };
    if (decoded.uid && decoded.uid !== userId) return null;
    return {
      folders: Array.isArray(decoded.folders) ? decoded.folders : [],
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
  payloadData: GalleryFoldersPayload,
): Promise<string> {
  const payload = {
    uid: userId,
    folders: payloadData.folders,
    updated_at: payloadData.updated_at || new Date().toISOString(),
    deleted_ids: payloadData.deleted_ids ?? {},
  };
  const enc = await encryptText(key, JSON.stringify(payload));
  const serialized = JSON.stringify(enc);

  try {
    window.localStorage.setItem(localCacheKey(userId), serialized);
  } catch {
    // ignore quota
  }
  return serialized;
}

async function writeEncrypted(
  userId: string,
  key: CryptoKey,
  payloadData: GalleryFoldersPayload,
): Promise<void> {
  const serialized = await saveLocalEncrypted(userId, key, payloadData);
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

async function fetchRemoteGalleryFolders(
  userId: string,
  key: CryptoKey,
): Promise<GalleryFoldersPayload | null> {
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
          const remote = JSON.parse(plain) as GalleryFoldersPayload & { uid?: string };
          if (remote.uid && remote.uid !== userId) return null;
          return {
            folders: Array.isArray(remote.folders) ? remote.folders : [],
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
          const remote = JSON.parse(plain) as GalleryFoldersPayload & { uid?: string };
          if (remote.uid && remote.uid !== userId) return null;
          return {
            folders: Array.isArray(remote.folders) ? remote.folders : [],
            updated_at: remote.updated_at || new Date(0).toISOString(),
            deleted_ids: remote.deleted_ids ?? {},
          };
        }
      }
    }
  } catch {
    // Offline or network error: rely on local
  }
  return null;
}

export function useGalleryFolders(userId: string) {
  const { key } = useVault();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ["gallery-folders", userId],
    enabled: !!key && !!userId,
    queryFn: async () => {
      if (!key) return [];
      const [local, remote] = await Promise.all([
        readLocalEncrypted(userId, key),
        fetchRemoteGalleryFolders(userId, key),
      ]);

      const { merged, needsPush } = mergeGalleryFoldersPayload(local, remote);
      await saveLocalEncrypted(userId, key, merged);

      if (needsPush && typeof navigator !== "undefined" && navigator.onLine) {
        void writeEncrypted(userId, key, merged).catch(() => {});
      }

      return merged.folders;
    },
  });

  const mutation = useMutation({
    mutationFn: async (updater: (prev: GalleryFolder[]) => GalleryFolder[]) => {
      if (!key) throw new Error("Vault is locked");
      const current = query.data ?? [];
      const updated = updater(current);
      const nowIso = new Date().toISOString();

      const localPayload = await readLocalEncrypted(userId, key);
      const deletedIds: Record<string, string> = { ...(localPayload?.deleted_ids ?? {}) };
      const updatedIds = new Set(updated.map((f) => f.id));
      for (const oldFolder of current) {
        if (oldFolder.id && !updatedIds.has(oldFolder.id)) {
          deletedIds[oldFolder.id] = nowIso;
        }
      }

      const prevById = new Map(current.map((f) => [f.id, f]));
      const stampedFolders = updated.map((f) => {
        const old = prevById.get(f.id);
        if (!old || old.name !== f.name || old.parent_id !== f.parent_id) {
          return { ...f, updated_at: nowIso };
        }
        return f;
      });

      const localCandidate: GalleryFoldersPayload = {
        folders: stampedFolders,
        updated_at: nowIso,
        deleted_ids: deletedIds,
      };

      const remote = await fetchRemoteGalleryFolders(userId, key);
      const { merged } = mergeGalleryFoldersPayload(localCandidate, remote);
      const finalPayload: GalleryFoldersPayload = {
        ...merged,
        updated_at: nowIso,
      };

      await writeEncrypted(userId, key, finalPayload);
      return finalPayload.folders;
    },
    onMutate: async (updater) => {
      await qc.cancelQueries({ queryKey: ["gallery-folders", userId] });
      const prev = qc.getQueryData<GalleryFolder[]>(["gallery-folders", userId]) ?? [];
      const next = updater(prev);
      qc.setQueryData<GalleryFolder[]>(["gallery-folders", userId], next);
      return { prev };
    },
    onSuccess: (savedFolders) => {
      qc.setQueryData<GalleryFolder[]>(["gallery-folders", userId], savedFolders);
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) {
        qc.setQueryData(["gallery-folders", userId], context.prev);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["gallery-folders", userId] });
    },
  });

  const createFolder = async (name: string, parentId: string | null = null) => {
    const nowIso = new Date().toISOString();
    const newFolder: GalleryFolder = {
      id: crypto.randomUUID(),
      name: name.trim(),
      parent_id: parentId,
      created_at: nowIso,
      updated_at: nowIso,
    };
    await mutation.mutateAsync((prev) => [...prev, newFolder]);
    return newFolder;
  };

  const deleteFolder = async (folderId: string) => {
    // Delete folder and all its descendant subfolders
    const toDelete = new Set<string>();
    const collectDescendants = (id: string, all: GalleryFolder[]) => {
      toDelete.add(id);
      for (const f of all) {
        if (f.parent_id === id) {
          collectDescendants(f.id, all);
        }
      }
    };
    collectDescendants(folderId, query.data ?? []);

    await mutation.mutateAsync((prev) => prev.filter((f) => !toDelete.has(f.id)));
  };

  const renameFolder = async (folderId: string, newName: string) => {
    const nowIso = new Date().toISOString();
    await mutation.mutateAsync((prev) =>
      prev.map((f) => (f.id === folderId ? { ...f, name: newName.trim(), updated_at: nowIso } : f)),
    );
  };

  return {
    folders: query.data ?? [],
    isLoading: query.isLoading,
    createFolder,
    deleteFolder,
    renameFolder,
  };
}
