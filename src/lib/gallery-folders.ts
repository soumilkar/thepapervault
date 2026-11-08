import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useVault } from "@/lib/vault";
import { decryptText, encryptText } from "@/lib/crypto";

export type GalleryFolder = {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
};

const BUCKET = "gallery";
const storagePath = (userId: string) => `${userId}/gallery-folders.bin`;
const localCacheKey = (userId: string) => `papervault:gallery-folders:v1:${userId}`;

async function readLocalEncrypted(
  userId: string,
  key: CryptoKey,
): Promise<{ folders: GalleryFolder[]; updated_at: string } | null> {
  try {
    const raw = window.localStorage.getItem(localCacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ct?: string; iv?: string };
    if (!parsed?.ct || !parsed?.iv) return null;
    const plain = await decryptText(key, parsed.ct, parsed.iv);
    const decoded = JSON.parse(plain) as {
      folders: GalleryFolder[];
      updated_at: string;
      uid?: string;
    };
    if (decoded.uid && decoded.uid !== userId) return null;
    return decoded;
  } catch {
    return null;
  }
}

async function writeEncrypted(
  userId: string,
  key: CryptoKey,
  folders: GalleryFolder[],
): Promise<void> {
  const payload = {
    uid: userId,
    folders,
    updated_at: new Date().toISOString(),
  };
  const enc = await encryptText(key, JSON.stringify(payload));
  const serialized = JSON.stringify(enc);

  try {
    window.localStorage.setItem(localCacheKey(userId), serialized);
  } catch {
    // ignore quota
  }

  const blob = new Blob([serialized], { type: "application/octet-stream" });
  await supabase.storage
    .from(BUCKET)
    .upload(storagePath(userId), blob, { contentType: "application/octet-stream", upsert: true });
}

async function fetchRemoteGalleryFolders(
  userId: string,
  key: CryptoKey,
  local: { folders: GalleryFolder[]; updated_at: string } | null,
): Promise<{ folders: GalleryFolder[]; updated_at: string } | null> {
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
          const remote = JSON.parse(plain) as {
            folders: GalleryFolder[];
            updated_at: string;
            uid?: string;
          };
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
              folders: remote.folders ?? [],
              updated_at: remote.updated_at || new Date().toISOString(),
            };
          }
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
      const local = await readLocalEncrypted(userId, key);
      if (local) {
        // Revalidate remote in background without blocking Gallery render
        void fetchRemoteGalleryFolders(userId, key, local).then((remote) => {
          if (remote && remote.updated_at !== local.updated_at) {
            qc.setQueryData(["gallery-folders", userId], remote.folders);
          }
        });
        return local.folders ?? [];
      }

      const remote = await fetchRemoteGalleryFolders(userId, key, null);
      if (remote) return remote.folders;

      // Seed local encrypted empty state so future Gallery loads are <1ms
      try {
        const emptyPayload = { folders: [], updated_at: new Date(0).toISOString() };
        const enc = await encryptText(key, JSON.stringify(emptyPayload));
        window.localStorage.setItem(localCacheKey(userId), JSON.stringify(enc));
      } catch {
        // ignore
      }
      return [];
    },
    staleTime: 1000 * 60 * 10,
  });

  const mutation = useMutation({
    mutationFn: async (updater: (prev: GalleryFolder[]) => GalleryFolder[]) => {
      if (!key) throw new Error("Vault is locked");
      const current = query.data ?? [];
      const updated = updater(current);
      await writeEncrypted(userId, key, updated);
      return updated;
    },
    onMutate: async (updater) => {
      await qc.cancelQueries({ queryKey: ["gallery-folders", userId] });
      const prev = qc.getQueryData<GalleryFolder[]>(["gallery-folders", userId]) ?? [];
      const next = updater(prev);
      qc.setQueryData<GalleryFolder[]>(["gallery-folders", userId], next);
      return { prev };
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
    const newFolder: GalleryFolder = {
      id: crypto.randomUUID(),
      name: name.trim(),
      parent_id: parentId,
      created_at: new Date().toISOString(),
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
    await mutation.mutateAsync((prev) =>
      prev.map((f) => (f.id === folderId ? { ...f, name: newName.trim() } : f)),
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
