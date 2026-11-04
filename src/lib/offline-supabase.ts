// Offline-first persistence & background sync engine for The PaperVault.
// All encrypted tables (notes, private diary_entries, chat_messages, chat_sessions, gallery_images, vault_keys)
// are already encrypted client-side with the AES-GCM vault key before reaching Supabase.
// This layer caches only those encrypted rows/blobs in IndexedDB and queues offline mutations
// so the entire app works 100% offline (except live AI generation, which requires internet).

const DB_NAME = "papervault_offline_v1";
const DB_VERSION = 1;

const TABLES = [
  "vault_keys",
  "notes",
  "note_folders",
  "diary_entries",
  "diary_folders",
  "blog_posts",
  "blog_comments",
  "blog_likes",
  "comment_votes",
  "gallery_images",
  "chat_sessions",
  "chat_messages",
  "profiles",
] as const;

type TableName = (typeof TABLES)[number];

export interface SyncQueueItem {
  queueId: string;
  table?: string;
  kind: "rest" | "storage";
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  storageBucket?: string;
  storagePath?: string;
  contentType?: string;
  createdAt: number;
}

export interface OfflineSyncState {
  isOnline: boolean;
  isSyncing: boolean;
  pendingCount: number;
  lastSyncedAt: number | null;
}

export const OFFLINE_SYNC_EVENT = "papervault:offline-sync-state";
const OFFLINE_AUTH_SESSION_KEY = "papervault:offline-cached-session:v1";

let dbPromise: Promise<IDBDatabase> | null = null;
let syncInProgress = false;
let currentSyncState: OfflineSyncState = {
  isOnline: typeof navigator !== "undefined" ? navigator.onLine : true,
  isSyncing: false,
  pendingCount: 0,
  lastSyncedAt: null,
};

function notifySyncState(patch: Partial<OfflineSyncState>) {
  currentSyncState = { ...currentSyncState, ...patch };
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<OfflineSyncState>(OFFLINE_SYNC_EVENT, { detail: currentSyncState }));
  }
}

export function getOfflineSyncState(): OfflineSyncState {
  return currentSyncState;
}

function getPrimaryKey(table: string): string {
  return table === "vault_keys" ? "user_id" : "id";
}

function openOfflineDB(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const table of TABLES) {
        if (!db.objectStoreNames.contains(table)) {
          db.createObjectStore(table, { keyPath: getPrimaryKey(table) });
        }
      }
      if (!db.objectStoreNames.contains("sync_queue")) {
        db.createObjectStore("sync_queue", { keyPath: "queueId" });
      }
      if (!db.objectStoreNames.contains("storage_blobs")) {
        db.createObjectStore("storage_blobs", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

async function idbGetAll<T = Record<string, unknown>>(storeName: string): Promise<T[]> {
  try {
    const db = await openOfflineDB();
    return await new Promise<T[]>((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result ?? []) as T[]);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

async function idbPutMany(storeName: string, rows: Record<string, unknown>[]): Promise<void> {
  if (!rows.length) return;
  try {
    const db = await openOfflineDB();
    const pk = getPrimaryKey(storeName);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      for (const row of rows) {
        if (row && typeof row === "object" && row[pk] !== undefined && row[pk] !== null) {
          store.put(row);
        }
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore IDB errors
  }
}

async function idbDeleteKeys(storeName: string, keys: (string | number)[]): Promise<void> {
  if (!keys.length) return;
  try {
    const db = await openOfflineDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      for (const k of keys) {
        store.delete(k);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore IDB errors
  }
}

async function saveStorageBlob(bucket: string, path: string, blob: Blob, contentType?: string): Promise<void> {
  try {
    const db = await openOfflineDB();
    const buffer = await blob.arrayBuffer();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("storage_blobs", "readwrite");
      tx.objectStore("storage_blobs").put({
        key: `${bucket}/${path}`,
        bucket,
        path,
        buffer,
        contentType: contentType || blob.type || "application/octet-stream",
        updatedAt: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
}

const blobUrlCache = new Map<string, string>();

async function getStorageBlobUrl(bucket: string, path: string): Promise<string | null> {
  const key = `${bucket}/${path}`;
  try {
    const db = await openOfflineDB();
    const record = await new Promise<
      { key: string; buffer: ArrayBuffer; contentType: string } | undefined
    >((resolve, reject) => {
      const tx = db.transaction("storage_blobs", "readonly");
      const req = tx.objectStore("storage_blobs").get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!record?.buffer) return null;
    const existing = blobUrlCache.get(key);
    if (existing) URL.revokeObjectURL(existing);
    const blob = new Blob([record.buffer], { type: record.contentType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    blobUrlCache.set(key, url);
    return url;
  } catch {
    return null;
  }
}

async function enqueueSyncItem(item: Omit<SyncQueueItem, "queueId" | "createdAt">): Promise<void> {
  try {
    const db = await openOfflineDB();
    const full: SyncQueueItem = {
      ...item,
      queueId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      createdAt: Date.now(),
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("sync_queue", "readwrite");
      tx.objectStore("sync_queue").put(full);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const all = await idbGetAll<SyncQueueItem>("sync_queue");
    notifySyncState({ pendingCount: all.length });
  } catch {
    // ignore
  }
}

async function removeSyncItem(queueId: string): Promise<void> {
  try {
    const db = await openOfflineDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("sync_queue", "readwrite");
      tx.objectStore("sync_queue").delete(queueId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
}

function parseScalar(raw: string): unknown {
  if (raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

function matchesCondition(row: Record<string, unknown>, col: string, expr: string): boolean {
  const val = row[col];
  if (expr.startsWith("not.")) {
    return !matchesCondition(row, col, expr.slice(4));
  }
  if (expr.startsWith("eq.")) {
    const target = parseScalar(expr.slice(3));
    return String(val ?? "") === String(target ?? "");
  }
  if (expr.startsWith("neq.")) {
    const target = parseScalar(expr.slice(4));
    return String(val ?? "") !== String(target ?? "");
  }
  if (expr.startsWith("is.")) {
    const target = parseScalar(expr.slice(3));
    return (val ?? null) === target;
  }
  if (expr.startsWith("gte.")) {
    const target = expr.slice(4);
    if (val === null || val === undefined) return false;
    return String(val) >= target;
  }
  if (expr.startsWith("lte.")) {
    const target = expr.slice(4);
    if (val === null || val === undefined) return false;
    return String(val) <= target;
  }
  if (expr.startsWith("lt.")) {
    const target = expr.slice(3);
    if (val === null || val === undefined) return false;
    return String(val) < target;
  }
  if (expr.startsWith("in.(") && expr.endsWith(")")) {
    const inner = expr.slice(4, -1);
    if (!inner.trim()) return false;
    const items = inner.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
    return items.includes(String(val ?? ""));
  }
  return true;
}

// Supports PostgREST `or=(...)` and nested `and(...)`
function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function evaluateGroupExpr(row: Record<string, unknown>, group: string, mode: "or" | "and"): boolean {
  const inner = group.startsWith("(") && group.endsWith(")") ? group.slice(1, -1) : group;
  const clauses = splitTopLevelCommas(inner);
  const results = clauses.map((clause) => {
    if (clause.startsWith("and(") && clause.endsWith(")")) {
      return evaluateGroupExpr(row, clause.slice(3), "and");
    }
    if (clause.startsWith("or(") && clause.endsWith(")")) {
      return evaluateGroupExpr(row, clause.slice(2), "or");
    }
    const dotIdx = clause.indexOf(".");
    if (dotIdx === -1) return true;
    const col = clause.slice(0, dotIdx);
    const expr = clause.slice(dotIdx + 1);
    return matchesCondition(row, col, expr);
  });
  return mode === "or" ? results.some(Boolean) : results.every(Boolean);
}

function filterAndSortRows(rows: Record<string, unknown>[], searchParams: URLSearchParams): Record<string, unknown>[] {
  let result = rows.filter((row) => {
    for (const [key, value] of searchParams.entries()) {
      if (key === "select" || key === "order" || key === "limit" || key === "offset" || key === "on_conflict") {
        continue;
      }
      if (key === "or") {
        if (!evaluateGroupExpr(row, value, "or")) return false;
        continue;
      }
      if (key === "and") {
        if (!evaluateGroupExpr(row, value, "and")) return false;
        continue;
      }
      if (!matchesCondition(row, key, value)) return false;
    }
    return true;
  });

  const orderParam = searchParams.get("order");
  if (orderParam) {
    const specs = orderParam.split(",").map((s) => {
      const parts = s.trim().split(".");
      return {
        col: parts[0],
        asc: parts[1] !== "desc",
      };
    });
    result = [...result].sort((a, b) => {
      for (const { col, asc } of specs) {
        const va = a[col];
        const vb = b[col];
        if (va === vb) continue;
        if (va === null || va === undefined) return asc ? 1 : -1;
        if (vb === null || vb === undefined) return asc ? -1 : 1;
        const cmp = String(va).localeCompare(String(vb), undefined, { numeric: true });
        if (cmp !== 0) return asc ? cmp : -cmp;
      }
      return 0;
    });
  }

  const limitParam = searchParams.get("limit");
  if (limitParam) {
    const n = parseInt(limitParam, 10);
    if (!Number.isNaN(n) && n >= 0) {
      result = result.slice(0, n);
    }
  }

  return result;
}

function withTableDefaults(table: string, raw: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString();
  const row: Record<string, unknown> = { ...raw };
  const pk = getPrimaryKey(table);

  if (pk === "id" && !row.id) {
    row.id = crypto.randomUUID();
  }
  if (!row.created_at) row.created_at = now;
  if (
    table !== "chat_messages" &&
    table !== "chat_sessions" &&
    table !== "blog_likes" &&
    table !== "comment_votes" &&
    table !== "gallery_images" &&
    !row.updated_at
  ) {
    row.updated_at = now;
  }

  if (table === "diary_entries") {
    if (!row.entry_date) row.entry_date = now.slice(0, 10);
    if (row.is_public === undefined) row.is_public = false;
    if (!row.visibility) row.visibility = row.is_public ? "public" : "private";
    if (row.word_count === undefined) row.word_count = 0;
    for (const col of [
      "folder_id",
      "image_path",
      "iv",
      "mood",
      "title",
      "music_artist",
      "music_artwork_url",
      "music_preview_url",
      "music_track_id",
      "music_track_name",
    ]) {
      if (row[col] === undefined) row[col] = null;
    }
  } else if (table === "notes") {
    if (row.content === undefined) row.content = "";
    for (const col of ["folder_id", "image_url", "iv", "tags", "title"]) {
      if (row[col] === undefined) row[col] = null;
    }
  } else if (table === "note_folders" || table === "diary_folders") {
    if (row.parent_id === undefined) row.parent_id = null;
  } else if (table === "chat_sessions") {
    if (!row.last_message_at) row.last_message_at = now;
    if (!row.title) row.title = "New conversation";
    if (row.title_iv === undefined) row.title_iv = null;
  } else if (table === "chat_messages") {
    if (row.iv === undefined) row.iv = null;
  } else if (table === "gallery_images") {
    for (const col of ["caption", "caption_iv", "iv", "mime"]) {
      if (row[col] === undefined) row[col] = null;
    }
  }

  return row;
}

function buildPostgrestResponse(
  rows: Record<string, unknown>[],
  method: string,
  headers: Headers,
  status = 200,
): Response {
  const accept = (headers.get("accept") ?? "").toLowerCase();
  const isSingleObject = accept.includes("application/vnd.pgrst.object+json");
  const countRange = rows.length > 0 ? `0-${rows.length - 1}/${rows.length}` : "*/0";

  const resHeaders = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Range": countRange,
  });

  if (method === "HEAD") {
    return new Response(null, { status: 200, headers: resHeaders });
  }

  if (isSingleObject) {
    const item = rows[0] ?? null;
    return new Response(JSON.stringify(item), { status: 200, headers: resHeaders });
  }

  return new Response(JSON.stringify(rows), { status, headers: resHeaders });
}

export function cacheAuthSession(session: unknown) {
  if (typeof window === "undefined") return;
  try {
    if (!session) {
      window.localStorage.removeItem(OFFLINE_AUTH_SESSION_KEY);
    } else {
      window.localStorage.setItem(OFFLINE_AUTH_SESSION_KEY, JSON.stringify(session));
    }
  } catch {
    // ignore storage errors
  }
}

export function getCachedAuthSession(): Record<string, unknown> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(OFFLINE_AUTH_SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && parsed.user) {
        return {
          ...parsed,
          expires_in: 86400,
          expires_at: Math.floor(Date.now() / 1000) + 86400,
        };
      }
    }
    // Also check standard Supabase sb-*-auth-token in localStorage
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith("sb-") && k.endsWith("-auth-token")) {
        const val = window.localStorage.getItem(k);
        if (val) {
          const parsed = JSON.parse(val) as Record<string, unknown>;
          if (parsed && typeof parsed === "object" && parsed.user) {
            return {
              ...parsed,
              expires_in: 86400,
              expires_at: Math.floor(Date.now() / 1000) + 86400,
            };
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

const nativeFetch: typeof fetch =
  typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : (() => Promise.reject(new Error("fetch unavailable"))) as unknown as typeof fetch;

export async function flushOfflineSyncQueue(): Promise<void> {
  if (typeof window === "undefined" || syncInProgress || !navigator.onLine) return;
  const queue = await idbGetAll<SyncQueueItem>("sync_queue");
  notifySyncState({ isOnline: navigator.onLine, pendingCount: queue.length });
  if (queue.length === 0) return;

  syncInProgress = true;
  notifySyncState({ isSyncing: true });

  try {
    const sorted = [...queue].sort((a, b) => a.createdAt - b.createdAt);
    for (const item of sorted) {
      if (!navigator.onLine) break;
      try {
        if (item.kind === "storage" && item.storageBucket && item.storagePath) {
          const db = await openOfflineDB();
          const blobRec = await new Promise<{ buffer: ArrayBuffer; contentType: string } | undefined>((res, rej) => {
            const tx = db.transaction("storage_blobs", "readonly");
            const req = tx.objectStore("storage_blobs").get(`${item.storageBucket}/${item.storagePath}`);
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
          });
          if (blobRec?.buffer) {
            const res = await nativeFetch(item.url, {
              method: item.method,
              headers: item.headers,
              body: new Blob([blobRec.buffer], { type: blobRec.contentType }),
            });
            if (res.ok || (res.status >= 400 && res.status < 500)) {
              await removeSyncItem(item.queueId);
            }
          } else {
            await removeSyncItem(item.queueId);
          }
        } else {
          const res = await nativeFetch(item.url, {
            method: item.method,
            headers: item.headers,
            body: item.body ?? undefined,
          });
          if (res.ok || (res.status >= 400 && res.status < 500)) {
            await removeSyncItem(item.queueId);
          }
        }
      } catch {
        // Network error while flushing; stop and retry next time online
        break;
      }
    }
  } finally {
    syncInProgress = false;
    const remaining = await idbGetAll<SyncQueueItem>("sync_queue");
    notifySyncState({
      isSyncing: false,
      pendingCount: remaining.length,
      lastSyncedAt: remaining.length === 0 ? Date.now() : currentSyncState.lastSyncedAt,
    });
  }
}

function extractHeadersRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

export const offlineAwareSupabaseFetch: typeof fetch = async (input, init) => {
  if (typeof window === "undefined") {
    return nativeFetch(input, init);
  }

  const req = new Request(input, init);
  const url = new URL(req.url);
  const method = req.method.toUpperCase();

  // 1. Auth Endpoints (/auth/v1/*)
  if (url.pathname.includes("/auth/v1/")) {
    if (navigator.onLine) {
      try {
        const res = await nativeFetch(req.clone());
        if (res.ok && (url.pathname.endsWith("/token") || url.pathname.endsWith("/signup"))) {
          try {
            const cloneData = await res.clone().json();
            if (cloneData?.access_token && cloneData?.user) {
              cacheAuthSession(cloneData);
            }
          } catch {
            // ignore
          }
        }
        if (url.pathname.endsWith("/logout")) {
          cacheAuthSession(null);
        }
        return res;
      } catch {
        // Fall through to offline auth fallback
      }
    }

    // Offline auth fallback: keep existing session alive so the user stays signed in offline
    const cached = getCachedAuthSession();
    if (url.pathname.endsWith("/token") && cached) {
      return new Response(JSON.stringify(cached), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname.endsWith("/user") && cached?.user) {
      return new Response(JSON.stringify(cached.user), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname.endsWith("/logout")) {
      cacheAuthSession(null);
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  }

  // 2. Storage Endpoints (/storage/v1/*)
  if (url.pathname.includes("/storage/v1/")) {
    // Batch signed URLs: POST /storage/v1/object/sign/<bucket>
    const batchSignMatch = /\/storage\/v1\/object\/sign\/([^/]+)$/.exec(url.pathname);
    if (batchSignMatch && method === "POST") {
      const bucket = decodeURIComponent(batchSignMatch[1]);
      const bodyJson = (await req.clone().json().catch(() => ({}))) as { paths?: string[] };
      const paths = bodyJson.paths ?? [];

      if (navigator.onLine) {
        try {
          const res = await nativeFetch(req.clone());
          if (res.ok) {
            const list = (await res.clone().json()) as { path: string; signedURL?: string; signedUrl?: string }[];
            const enhanced = await Promise.all(
              list.map(async (item) => {
                const localUrl = await getStorageBlobUrl(bucket, item.path);
                if (localUrl) {
                  return { ...item, signedURL: localUrl, signedUrl: localUrl };
                }
                return item;
              }),
            );
            return new Response(JSON.stringify(enhanced), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
        } catch {
          // Fall through to local blob URLs
        }
      }

      const offlineSigned = await Promise.all(
        paths.map(async (p) => {
          const localUrl = await getStorageBlobUrl(bucket, p);
          return {
            error: null,
            path: p,
            signedURL: localUrl ?? "",
            signedUrl: localUrl ?? "",
          };
        }),
      );
      return new Response(JSON.stringify(offlineSigned), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Single signed URL: POST /storage/v1/object/sign/<bucket>/<path...>
    const singleSignMatch = /\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (singleSignMatch && method === "POST") {
      const bucket = decodeURIComponent(singleSignMatch[1]);
      const objectPath = decodeURIComponent(singleSignMatch[2]);
      const localUrl = await getStorageBlobUrl(bucket, objectPath);

      if (navigator.onLine) {
        try {
          const res = await nativeFetch(req.clone());
          if (res.ok) return res;
        } catch {
          // Fall through to local blob URL
        }
      }

      if (localUrl) {
        return new Response(JSON.stringify({ signedURL: localUrl, signedUrl: localUrl }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Upload or Delete object: /storage/v1/object/<bucket>/<path...>
    const objectMatch = /\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (objectMatch && (method === "POST" || method === "PUT")) {
      const bucket = decodeURIComponent(objectMatch[1]);
      const objectPath = decodeURIComponent(objectMatch[2]);
      const blob = await req.clone().blob();
      await saveStorageBlob(bucket, objectPath, blob, req.headers.get("content-type") ?? undefined);

      if (navigator.onLine) {
        try {
          const res = await nativeFetch(req.clone());
          if (res.ok) return res;
        } catch {
          // Queue below
        }
      }

      await enqueueSyncItem({
        kind: "storage",
        url: req.url,
        method,
        headers: extractHeadersRecord(req.headers),
        body: null,
        storageBucket: bucket,
        storagePath: objectPath,
        contentType: req.headers.get("content-type") ?? "application/octet-stream",
      });

      return new Response(JSON.stringify({ Key: `${bucket}/${objectPath}`, Id: crypto.randomUUID() }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Downloading a signed storage object while online: cache encrypted blob in IndexedDB for offline viewing
    const signedDownloadMatch = /\/storage\/v1\/object\/sign\/([^/]+)\/([^?]+)/.exec(url.pathname);
    if (signedDownloadMatch && method === "GET") {
      const bucket = decodeURIComponent(signedDownloadMatch[1]);
      const objectPath = decodeURIComponent(signedDownloadMatch[2]);
      if (navigator.onLine) {
        try {
          const res = await nativeFetch(req.clone());
          if (res.ok) {
            const clonedBlob = await res.clone().blob();
            void saveStorageBlob(bucket, objectPath, clonedBlob, res.headers.get("content-type") ?? undefined);
            return res;
          }
        } catch {
          // Fall through to local blob cache
        }
      }
      const localUrl = await getStorageBlobUrl(bucket, objectPath);
      if (localUrl) {
        return nativeFetch(localUrl);
      }
    }
  }

  // 3. PostgREST Database Endpoints (/rest/v1/<table>)
  const restMatch = /\/rest\/v1\/([^/?]+)/.exec(url.pathname);
  if (restMatch) {
    const table = decodeURIComponent(restMatch[1]) as TableName;
    if ((TABLES as readonly string[]).includes(table)) {
      const pk = getPrimaryKey(table);

      // SELECT / HEAD
      if (method === "GET" || method === "HEAD") {
        if (navigator.onLine) {
          try {
            // Flush any queued offline mutations before reading remote state
            await flushOfflineSyncQueue();
            const res = await nativeFetch(req.clone());
            if (res.ok && method === "GET") {
              const data = await res.clone().json().catch(() => null);
              if (Array.isArray(data)) {
                await idbPutMany(table, data as Record<string, unknown>[]);
              } else if (data && typeof data === "object") {
                await idbPutMany(table, [data as Record<string, unknown>]);
              }
            }
            if (res.ok) return res;
          } catch {
            // Fall through to IndexedDB offline query
          }
        }

        const allLocal = await idbGetAll<Record<string, unknown>>(table);
        const filtered = filterAndSortRows(allLocal, url.searchParams);
        return buildPostgrestResponse(filtered, method, req.headers, 200);
      }

      // INSERT / UPSERT
      if (method === "POST") {
        const bodyText = await req.clone().text();
        const parsed = bodyText ? (JSON.parse(bodyText) as Record<string, unknown> | Record<string, unknown>[]) : [];
        const rawList = Array.isArray(parsed) ? parsed : [parsed];
        const normalizedRows = rawList.map((r) => withTableDefaults(table, r));

        await idbPutMany(table, normalizedRows);

        const forwardBody = JSON.stringify(Array.isArray(parsed) ? normalizedRows : normalizedRows[0]);
        if (navigator.onLine) {
          try {
            const res = await nativeFetch(req.url, {
              method,
              headers: req.headers,
              body: forwardBody,
            });
            if (res.ok) {
              const serverData = await res.clone().json().catch(() => null);
              if (Array.isArray(serverData)) {
                await idbPutMany(table, serverData as Record<string, unknown>[]);
              } else if (serverData && typeof serverData === "object") {
                await idbPutMany(table, [serverData as Record<string, unknown>]);
              }
              return res;
            }
          } catch {
            // Enqueue for background sync below
          }
        }

        await enqueueSyncItem({
          kind: "rest",
          table,
          url: req.url,
          method,
          headers: extractHeadersRecord(req.headers),
          body: forwardBody,
        });

        return buildPostgrestResponse(normalizedRows, method, req.headers, 201);
      }

      // UPDATE
      if (method === "PATCH") {
        const bodyText = await req.clone().text();
        const patchObj = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
        const allLocal = await idbGetAll<Record<string, unknown>>(table);
        const matched = filterAndSortRows(allLocal, url.searchParams);
        const now = new Date().toISOString();
        const updatedRows = matched.map((row) => ({
          ...row,
          ...patchObj,
          ...(row.updated_at !== undefined && patchObj.updated_at === undefined ? { updated_at: now } : {}),
        }));
        await idbPutMany(table, updatedRows);

        if (navigator.onLine) {
          try {
            const res = await nativeFetch(req.clone());
            if (res.ok) return res;
          } catch {
            // Enqueue below
          }
        }

        await enqueueSyncItem({
          kind: "rest",
          table,
          url: req.url,
          method,
          headers: extractHeadersRecord(req.headers),
          body: bodyText,
        });

        return buildPostgrestResponse(updatedRows, method, req.headers, 200);
      }

      // DELETE
      if (method === "DELETE") {
        const allLocal = await idbGetAll<Record<string, unknown>>(table);
        const matched = filterAndSortRows(allLocal, url.searchParams);
        const keysToDelete = matched
          .map((r) => r[pk])
          .filter((k): k is string | number => typeof k === "string" || typeof k === "number");
        await idbDeleteKeys(table, keysToDelete);

        if (navigator.onLine) {
          try {
            const res = await nativeFetch(req.clone());
            if (res.ok) return res;
          } catch {
            // Enqueue below
          }
        }

        await enqueueSyncItem({
          kind: "rest",
          table,
          url: req.url,
          method,
          headers: extractHeadersRecord(req.headers),
          body: null,
        });

        return buildPostgrestResponse(matched, method, req.headers, 200);
      }
    }
  }

  return nativeFetch(input, init);
};

// Register window online/offline listeners and service worker
if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    notifySyncState({ isOnline: true });
    void flushOfflineSyncQueue();
  });
  window.addEventListener("offline", () => {
    notifySyncState({ isOnline: false });
  });

  // Initialize pending count on startup
  void idbGetAll<SyncQueueItem>("sync_queue").then((items) => {
    notifySyncState({ isOnline: navigator.onLine, pendingCount: items.length });
    if (navigator.onLine && items.length > 0) {
      void flushOfflineSyncQueue();
    }
  });
}
