// Offline-first persistence & background sync engine for The PaperVault.
// All encrypted tables (notes, private diary_entries, chat_messages, chat_sessions, gallery_images, vault_keys)
// are already encrypted client-side with the AES-GCM vault key before reaching Supabase.
// This layer caches only those encrypted rows/blobs in IndexedDB and queues offline mutations
// so the entire app works 100% offline (except live AI generation, which requires internet).

import { getBrowserNow } from "@/lib/browser-time";

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
export const OFFLINE_SYNC_SUCCESS_EVENT = "papervault:sync-success";
export const OFFLINE_DATA_UPDATED_EVENT = "papervault:data-updated";
const OFFLINE_AUTH_SESSION_KEY = "papervault:offline-cached-session:v1";
const HYDRATED_TABLES_KEY = "papervault:hydrated-tables:v1";

const memTableCache = new Map<string, Map<string | number, Record<string, unknown>>>();
const hydratedTables = new Set<string>();
const sessionHydratedTables = new Set<string>();
const recentRevalidations = new Map<string, number>();
const inFlightTableSyncs = new Map<
  string,
  Promise<{ rows: Record<string, unknown>[]; isFullTable: boolean } | null>
>();

export function resetSessionSyncCache(): void {
  sessionHydratedTables.clear();
  recentRevalidations.clear();
}

function isMutableStoragePath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.endsWith("vault-trackers.bin") ||
    lower.endsWith("gallery-folders.bin") ||
    lower.endsWith(".bin")
  );
}

function markTableHydrated(table: string): void {
  sessionHydratedTables.add(table);
  if (hydratedTables.has(table)) return;
  hydratedTables.add(table);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(HYDRATED_TABLES_KEY, JSON.stringify(Array.from(hydratedTables)));
    } catch {
      // ignore
    }
  }
}

type TokenGetter = (forceRefresh?: boolean) => Promise<string | null>;
let externalTokenGetter: TokenGetter | null = null;

export function registerAuthTokenGetter(getter: TokenGetter) {
  externalTokenGetter = getter;
}

export async function getFreshAccessToken(forceRefresh = false): Promise<string | null> {
  if (externalTokenGetter) {
    try {
      const token = await externalTokenGetter(forceRefresh);
      if (token) return token;
    } catch {
      // fallback
    }
  }
  const session = getCachedAuthSession();
  return (session as { access_token?: string })?.access_token ?? null;
}

async function resolveRequestAuthHeader(
  reqHeaders: Headers,
  forceRefresh = false,
): Promise<string> {
  if (forceRefresh) {
    const refreshed = await getFreshAccessToken(true);
    if (refreshed) return `Bearer ${refreshed}`;
  }
  const fresh = await getFreshAccessToken(false);
  if (fresh) return `Bearer ${fresh}`;
  return reqHeaders.get("authorization") || reqHeaders.get("Authorization") || "";
}

let autoSyncTimer: number | null = null;
let watchdogInterval: number | null = null;

export function triggerAutoSync(delayMs = 0): void {
  if (typeof window === "undefined") return;
  if (autoSyncTimer !== null) {
    window.clearTimeout(autoSyncTimer);
  }
  autoSyncTimer = window.setTimeout(() => {
    autoSyncTimer = null;
    if (navigator.onLine && !syncInProgress) {
      void flushOfflineSyncQueue();
    }
  }, delayMs);
}

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
    window.dispatchEvent(
      new CustomEvent<OfflineSyncState>(OFFLINE_SYNC_EVENT, { detail: currentSyncState }),
    );
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
  const isDataTable = (TABLES as readonly string[]).includes(storeName);
  if (isDataTable && memTableCache.has(storeName)) {
    return Array.from(memTableCache.get(storeName)!.values()) as unknown as T[];
  }
  try {
    const db = await openOfflineDB();
    const rows = await new Promise<T[]>((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result ?? []) as T[]);
      req.onerror = () => reject(req.error);
    });
    if (isDataTable) {
      const pk = getPrimaryKey(storeName);
      const map = new Map<string | number, Record<string, unknown>>();
      for (const r of rows as unknown as Record<string, unknown>[]) {
        const keyVal = r?.[pk];
        if (typeof keyVal === "string" || typeof keyVal === "number") {
          map.set(keyVal, r);
        }
      }
      memTableCache.set(storeName, map);
    }
    return rows;
  } catch {
    return [];
  }
}

async function idbPutMany(storeName: string, rows: Record<string, unknown>[]): Promise<void> {
  if (!rows.length) return;
  const pk = getPrimaryKey(storeName);
  if ((TABLES as readonly string[]).includes(storeName)) {
    let map = memTableCache.get(storeName);
    if (!map) {
      map = new Map<string | number, Record<string, unknown>>();
      memTableCache.set(storeName, map);
    }
    for (const row of rows) {
      const keyVal = row?.[pk];
      if (
        row &&
        typeof row === "object" &&
        (typeof keyVal === "string" || typeof keyVal === "number")
      ) {
        const existing = map.get(keyVal);
        map.set(keyVal, existing ? { ...existing, ...row } : row);
      }
    }
  }
  try {
    const db = await openOfflineDB();
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
  if (memTableCache.has(storeName)) {
    const map = memTableCache.get(storeName)!;
    for (const k of keys) map.delete(k);
  }
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

async function saveStorageBlob(
  bucket: string,
  path: string,
  blob: Blob,
  contentType?: string,
): Promise<void> {
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
const decryptedMediaUrlCache = new Map<string, string>();

export function peekDecryptedMediaUrl(
  bucket: string,
  path: string,
  iv: string | null | undefined,
): string | null {
  return decryptedMediaUrlCache.get(`${bucket}/${path}:${iv ?? "plain"}`) ?? null;
}

const MAX_DECRYPTED_MEDIA_URLS = 300;

export function setDecryptedMediaUrl(
  bucket: string,
  path: string,
  iv: string | null | undefined,
  blobUrl: string,
): void {
  const key = `${bucket}/${path}:${iv ?? "plain"}`;
  const prev = decryptedMediaUrlCache.get(key);
  if (prev && prev !== blobUrl) {
    let stillReferenced = false;
    for (const [k, u] of decryptedMediaUrlCache.entries()) {
      if (k !== key && u === prev) {
        stillReferenced = true;
        break;
      }
    }
    if (!stillReferenced) {
      try {
        URL.revokeObjectURL(prev);
      } catch {
        // ignore
      }
    }
  }
  if (!decryptedMediaUrlCache.has(key) && decryptedMediaUrlCache.size >= MAX_DECRYPTED_MEDIA_URLS) {
    const oldestKey = decryptedMediaUrlCache.keys().next().value;
    if (oldestKey !== undefined) {
      decryptedMediaUrlCache.delete(oldestKey);
    }
  }
  decryptedMediaUrlCache.set(key, blobUrl);
}

export function clearOfflineBlobUrls(): void {
  for (const url of blobUrlCache.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
  blobUrlCache.clear();
  for (const url of decryptedMediaUrlCache.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
  decryptedMediaUrlCache.clear();
}

export async function getStorageBlobRecord(
  bucket: string,
  path: string,
): Promise<{ key: string; buffer: ArrayBuffer; contentType: string } | null> {
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
    return record?.buffer ? record : null;
  } catch {
    return null;
  }
}

export async function getStorageBlobUrl(bucket: string, path: string): Promise<string | null> {
  const key = `${bucket}/${path}`;
  const isMutable = isMutableStoragePath(path);
  if (!isMutable && blobUrlCache.has(key)) {
    return blobUrlCache.get(key)!;
  }
  const record = await getStorageBlobRecord(bucket, path);
  if (!record?.buffer) return null;
  if (isMutable && blobUrlCache.has(key)) {
    try {
      URL.revokeObjectURL(blobUrlCache.get(key)!);
    } catch {
      // ignore
    }
  }
  const blob = new Blob([record.buffer], {
    type: record.contentType || "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);
  blobUrlCache.set(key, url);
  return url;
}

const activeBlobDownloads = new Map<string, Promise<ArrayBuffer | null>>();

function normalizeSignedProxyUrl(rawUrl: string): string {
  const proxyIdx = rawUrl.indexOf("/api/storage-proxy?");
  if (proxyIdx !== -1) {
    return rawUrl.slice(proxyIdx);
  }
  return rawUrl;
}

export async function cacheRemoteStorageUrl(
  bucket: string,
  path: string,
  signedUrl: string,
): Promise<ArrayBuffer | null> {
  if (!signedUrl || signedUrl.startsWith("blob:")) return null;
  const normalizedUrl = normalizeSignedProxyUrl(signedUrl);
  const key = `${bucket}/${path}`;
  const inFlight = activeBlobDownloads.get(key);
  if (inFlight) return inFlight;

  const task = (async () => {
    try {
      const res = await nativeFetch(normalizedUrl, {
        cache: isMutableStoragePath(path) ? "no-store" : "default",
      });
      if (!res.ok) return null;
      const blob = await res.blob();
      await saveStorageBlob(
        bucket,
        path,
        blob,
        res.headers.get("content-type") || "application/octet-stream",
      );
      return await blob.arrayBuffer();
    } catch {
      return null;
    } finally {
      activeBlobDownloads.delete(key);
    }
  })();

  activeBlobDownloads.set(key, task);
  return task;
}

export async function fetchStorageBytesWithOfflineCache(
  bucket: string,
  path: string,
  signedUrl?: string,
): Promise<ArrayBuffer | null> {
  const isMutable = isMutableStoragePath(path);
  if (!isMutable) {
    const cached = await getStorageBlobRecord(bucket, path);
    if (cached?.buffer) {
      return cached.buffer;
    }
  }

  if (signedUrl) {
    if (signedUrl.startsWith("blob:")) {
      try {
        const res = await nativeFetch(signedUrl);
        if (res.ok) return await res.arrayBuffer();
      } catch {
        // fallback below
      }
    } else if (typeof navigator === "undefined" || navigator.onLine) {
      const downloaded = await cacheRemoteStorageUrl(bucket, path, signedUrl);
      if (downloaded) return downloaded;
    }
  }

  const fallback = await getStorageBlobRecord(bucket, path);
  return fallback?.buffer ?? null;
}

export async function fetchStorageUrlWithOfflineCache(
  bucket: string,
  path: string,
  signedUrl?: string,
): Promise<string | null> {
  const isMutable = isMutableStoragePath(path);
  if (!isMutable) {
    const localUrl = await getStorageBlobUrl(bucket, path);
    if (localUrl) return localUrl;
  }

  if (signedUrl && (typeof navigator === "undefined" || navigator.onLine)) {
    const downloaded = await cacheRemoteStorageUrl(bucket, path, signedUrl);
    if (downloaded) {
      const freshLocal = await getStorageBlobUrl(bucket, path);
      if (freshLocal) return freshLocal;
    }
    return signedUrl;
  }

  return signedUrl || null;
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
    if (typeof navigator !== "undefined" && navigator.onLine) {
      triggerAutoSync(300);
    }
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
    if (target === null) return val === null || val === undefined;
    return String(val ?? "") === String(target);
  }
  if (expr.startsWith("neq.")) {
    const target = parseScalar(expr.slice(4));
    if (target === null) return val !== null && val !== undefined;
    return String(val ?? "") !== String(target);
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

function evaluateGroupExpr(
  row: Record<string, unknown>,
  group: string,
  mode: "or" | "and",
): boolean {
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

function filterAndSortRows(
  rows: Record<string, unknown>[],
  searchParams: URLSearchParams,
): Record<string, unknown>[] {
  let result = rows.filter((row) => {
    for (const [key, value] of searchParams.entries()) {
      if (
        key === "select" ||
        key === "order" ||
        key === "limit" ||
        key === "offset" ||
        key === "on_conflict"
      ) {
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

  const orderParams = searchParams.getAll("order");
  if (orderParams.length > 0) {
    const specs: { col: string; asc: boolean }[] = [];
    for (const op of orderParams) {
      for (const s of op.split(",")) {
        const parts = s.trim().split(".");
        if (parts[0]) {
          specs.push({
            col: parts[0],
            asc: parts[1] !== "desc",
          });
        }
      }
    }
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
  const browserNow = getBrowserNow();
  const now = browserNow.iso;
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
    if (!row.entry_date) row.entry_date = browserNow.localDate;
    if (row.is_public === undefined) row.is_public = false;
    if (!row.visibility || row.visibility === "public") {
      row.visibility = row.is_public ? "public_anon" : "private";
    }
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
  const prefer = (headers.get("prefer") ?? "").toLowerCase();
  const isSingleObject = accept.includes("application/vnd.pgrst.object+json");
  const countRange = rows.length > 0 ? `0-${rows.length - 1}/${rows.length}` : "*/0";

  const resHeaders = new Headers({
    "Content-Type": isSingleObject
      ? "application/vnd.pgrst.object+json; charset=utf-8"
      : "application/json; charset=utf-8",
    "Content-Range": countRange,
  });

  if (method === "HEAD") {
    return new Response(null, { status: 200, headers: resHeaders });
  }

  // PostgREST return=minimal returns 201/200/204 with empty body
  if (
    prefer.includes("return=minimal") &&
    (method === "POST" || method === "PATCH" || method === "DELETE")
  ) {
    return new Response(null, { status, headers: resHeaders });
  }

  if (isSingleObject) {
    const item = rows[0] ?? null;
    if (!item && status === 200) {
      return new Response(
        JSON.stringify({
          code: "PGRST116",
          details: "The result contains 0 rows",
          message: "JSON object requested, multiple (or no) rows returned",
        }),
        {
          status: 406,
          headers: resHeaders,
        },
      );
    }
    return new Response(JSON.stringify(item), { status, headers: resHeaders });
  }

  return new Response(JSON.stringify(rows), { status, headers: resHeaders });
}

export function clearAllOfflineUserData() {
  memTableCache.clear();
  hydratedTables.clear();
  sessionHydratedTables.clear();
  recentRevalidations.clear();
  inFlightTableSyncs.clear();
  clearOfflineBlobUrls();

  if (typeof window !== "undefined") {
    try {
      const preservedPrefixes = [
        "papervault:security_questions:v1:",
        "papervault:sq_onboarded:",
        "papervault:sq_challenge:",
        "papervault:welcome_tour_seen:",
        "papervault:profile_name:",
      ];
      const keysToRemove: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (!k) continue;
        if (preservedPrefixes.some((prefix) => k.startsWith(prefix))) {
          continue;
        }
        if (
          k.startsWith("papervault:") ||
          k.startsWith("sb-") ||
          k.includes("auth-token") ||
          k.includes("supabase")
        ) {
          keysToRemove.push(k);
        }
      }
      for (const k of keysToRemove) {
        window.localStorage.removeItem(k);
      }
    } catch {
      // ignore
    }

    try {
      const sessionKeys: string[] = [];
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const k = window.sessionStorage.key(i);
        if (
          k &&
          (k.startsWith("papervault:") ||
            k.startsWith("sb-") ||
            k.includes("auth-token") ||
            k.includes("supabase"))
        ) {
          sessionKeys.push(k);
        }
      }
      for (const k of sessionKeys) {
        window.sessionStorage.removeItem(k);
      }
    } catch {
      // ignore
    }

    // Clear all IndexedDB stores asynchronously so no prior account data persists
    void openOfflineDB()
      .then((db) => {
        const allStores = [...TABLES, "sync_queue", "storage_blobs"];
        const existingStores = allStores.filter((s) => db.objectStoreNames.contains(s));
        if (existingStores.length === 0) return;
        const tx = db.transaction(existingStores, "readwrite");
        for (const s of existingStores) {
          tx.objectStore(s).clear();
        }
      })
      .catch(() => {});
  }
}

let memActiveSession: Record<string, unknown> | null = null;

export function cacheAuthSession(session: unknown) {
  if (typeof window === "undefined") return;
  try {
    if (!session || typeof session !== "object") {
      memActiveSession = null;
      clearAllOfflineUserData();
    } else {
      const s = session as Record<string, unknown>;
      memActiveSession = s;
      const userObj = s.user as
        { id?: string; email?: string; user_metadata?: unknown } | undefined;
      const newUserId = userObj?.id;
      try {
        const prevRaw = window.localStorage.getItem(OFFLINE_AUTH_SESSION_KEY);
        if (prevRaw) {
          const prevParsed = JSON.parse(prevRaw) as { user?: { id?: string } };
          const prevUserId = prevParsed?.user?.id;
          if (prevUserId && newUserId && prevUserId !== newUserId) {
            clearAllOfflineUserData();
            memActiveSession = s;
          }
        }
      } catch {
        // ignore
      }
      // Store only minimal non-refresh identity metadata for offline fallback; never duplicate refresh_token
      const minimalOfflineSession = {
        token_type: "bearer",
        user: userObj
          ? {
              id: userObj.id,
              email: userObj.email,
              user_metadata: userObj.user_metadata,
            }
          : undefined,
      };
      window.localStorage.setItem(OFFLINE_AUTH_SESSION_KEY, JSON.stringify(minimalOfflineSession));
    }
  } catch {
    // ignore storage errors
  }
}

export function getCachedAuthSession(): Record<string, unknown> | null {
  if (typeof window === "undefined") return null;
  if (memActiveSession && memActiveSession.user && memActiveSession.access_token) {
    return memActiveSession;
  }
  try {
    // 1. Check standard Supabase sb-*-auth-token in localStorage first (contains live access_token)
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith("sb-") && k.endsWith("-auth-token")) {
        const val = window.localStorage.getItem(k);
        if (val) {
          const parsed = JSON.parse(val) as Record<string, unknown>;
          if (parsed && typeof parsed === "object" && parsed.user) {
            memActiveSession = parsed;
            return {
              ...parsed,
              expires_in: (parsed.expires_in as number | undefined) ?? 86400,
              expires_at:
                (parsed.expires_at as number | undefined) ?? Math.floor(Date.now() / 1000) + 86400,
            };
          }
        }
      }
    }
    // 2. Offline fallback: minimal identity metadata when offline
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
  } catch {
    // ignore
  }
  return null;
}

const nativeFetch: typeof fetch =
  typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : ((() => Promise.reject(new Error("fetch unavailable"))) as unknown as typeof fetch);

async function quickFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = 2500,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await nativeFetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function flushOfflineSyncQueue(): Promise<void> {
  if (typeof window === "undefined" || syncInProgress || !navigator.onLine) return;
  const queue = await idbGetAll<SyncQueueItem>("sync_queue");
  notifySyncState({ isOnline: navigator.onLine, pendingCount: queue.length });
  if (queue.length === 0) return;

  syncInProgress = true;
  notifySyncState({ isSyncing: true });

  let successfullySyncedCount = 0;
  const syncedTables = new Set<string>();

  try {
    let token = await getFreshAccessToken();
    const sorted = [...queue].sort((a, b) => a.createdAt - b.createdAt);

    for (const item of sorted) {
      if (!navigator.onLine) break;

      const buildSanitizedHeaders = (
        tokenStr: string | null,
        isStorageUpload = false,
        contentType?: string,
      ) => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(item.headers || {})) {
          const lower = k.toLowerCase();
          if (
            lower === "host" ||
            lower === "content-length" ||
            lower === "connection" ||
            lower === "cookie" ||
            lower === "origin" ||
            lower === "referer"
          ) {
            continue;
          }
          h[k] = v;
        }
        if (tokenStr) {
          h["authorization"] = `Bearer ${tokenStr}`;
        }
        if (isStorageUpload) {
          h["content-type"] = contentType || item.contentType || "application/octet-stream";
          h["x-upsert"] = "true";
        } else if (!item.body) {
          delete h["content-type"];
        }
        return h;
      };

      try {
        if (item.kind === "storage" && item.storageBucket && item.storagePath) {
          const db = await openOfflineDB();
          const blobRec = await new Promise<
            { buffer: ArrayBuffer; contentType: string } | undefined
          >((res, rej) => {
            const tx = db.transaction("storage_blobs", "readonly");
            const req = tx
              .objectStore("storage_blobs")
              .get(`${item.storageBucket}/${item.storagePath}`);
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
          });

          if (blobRec?.buffer) {
            const proxyUploadUrl = `/api/storage-proxy?action=upload&bucket=${encodeURIComponent(
              item.storageBucket,
            )}&path=${encodeURIComponent(item.storagePath)}`;

            let res = await quickFetch(
              proxyUploadUrl,
              {
                method: "POST",
                headers: {
                  authorization: token ? `Bearer ${token}` : "",
                  "content-type":
                    blobRec.contentType || item.contentType || "application/octet-stream",
                },
                body: new Blob([blobRec.buffer], {
                  type: blobRec.contentType || item.contentType || "application/octet-stream",
                }),
              },
              30000,
            );

            // Attempt session refresh if 401 unauthorized
            if (res.status === 401) {
              try {
                token = await getFreshAccessToken(true);
              } catch {
                token = null;
              }
              if (token) {
                res = await quickFetch(
                  proxyUploadUrl,
                  {
                    method: "POST",
                    headers: {
                      authorization: `Bearer ${token}`,
                      "content-type":
                        blobRec.contentType || item.contentType || "application/octet-stream",
                    },
                    body: new Blob([blobRec.buffer], {
                      type: blobRec.contentType || item.contentType || "application/octet-stream",
                    }),
                  },
                  30000,
                );
              }
            }

            if (res.ok || res.status === 409) {
              await removeSyncItem(item.queueId);
              successfullySyncedCount++;
              syncedTables.add("storage");
            } else if (res.status === 401 || res.status === 403) {
              break;
            }
          } else {
            // Blob missing locally; remove stale queue reference
            await removeSyncItem(item.queueId);
          }
        } else if (item.kind === "storage" && item.method === "DELETE" && item.storageBucket) {
          const proxyRemoveUrl = `/api/storage-proxy?action=remove&bucket=${encodeURIComponent(
            item.storageBucket,
          )}`;
          const res = await quickFetch(
            proxyRemoveUrl,
            {
              method: "POST",
              headers: {
                authorization: token ? `Bearer ${token}` : "",
                "content-type": "application/json",
              },
              body: item.body ?? undefined,
            },
            10000,
          );
          if (res.ok || res.status === 404) {
            await removeSyncItem(item.queueId);
            successfullySyncedCount++;
            syncedTables.add("storage");
          } else if (res.status === 401 || res.status === 403) {
            break;
          }
        } else {
          let activeHeaders = buildSanitizedHeaders(token, false);
          let res: Response | null = null;

          // If this is a B2-backed table and item.url is direct PostgREST, try storage-proxy first so B2 is updated too
          if (item.table && !item.url.includes("/api/storage-proxy")) {
            try {
              const parsedItemUrl = new URL(item.url, window.location.origin);
              const proxyMutateUrl = `/api/storage-proxy?action=db-mutate&table=${encodeURIComponent(
                item.table,
              )}&method=${encodeURIComponent(item.method)}&${parsedItemUrl.searchParams.toString()}`;
              const proxyRes = await quickFetch(
                proxyMutateUrl,
                {
                  method: "POST",
                  headers: {
                    authorization: token ? `Bearer ${token}` : activeHeaders["authorization"] || "",
                    "content-type": "application/json",
                  },
                  body: item.body ?? undefined,
                },
                12000,
              );
              if (proxyRes.ok) {
                res = proxyRes;
              }
            } catch {
              // Fall back to item.url below
            }
          }

          if (!res) {
            res = await quickFetch(
              item.url,
              {
                method: item.method,
                headers: activeHeaders,
                body: item.body ?? undefined,
              },
              12000,
            );

            if (res.status === 401) {
              try {
                token = await getFreshAccessToken(true);
              } catch {
                token = null;
              }
              if (token) {
                activeHeaders = buildSanitizedHeaders(token, false);
                res = await quickFetch(
                  item.url,
                  {
                    method: item.method,
                    headers: activeHeaders,
                    body: item.body ?? undefined,
                  },
                  12000,
                );
              }
            }
          }

          // If a legacy queued /api/storage-proxy?action=db-mutate item failed, fallback to direct Supabase REST
          if (
            !res.ok &&
            res.status !== 409 &&
            item.table &&
            item.url.includes("/api/storage-proxy")
          ) {
            const sbBase = (import.meta.env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
            const sbKey =
              import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
              import.meta.env.VITE_SUPABASE_ANON_KEY ||
              "";
            if (sbBase && sbKey) {
              try {
                const proxyUrlObj = new URL(item.url, window.location.origin);
                const origMethod = (proxyUrlObj.searchParams.get("method") || "POST").toUpperCase();
                const forwardParams = new URLSearchParams(proxyUrlObj.searchParams);
                forwardParams.delete("action");
                forwardParams.delete("table");
                forwardParams.delete("method");
                const qs = forwardParams.toString();
                const directUrl = `${sbBase}/rest/v1/${encodeURIComponent(item.table)}${
                  qs ? `?${qs}` : ""
                }`;
                const directHeaders: Record<string, string> = {
                  ...activeHeaders,
                  apikey: sbKey,
                };
                if (origMethod === "POST") {
                  directHeaders["Prefer"] = "resolution=merge-duplicates,return=representation";
                }
                const directRes = await quickFetch(
                  directUrl,
                  {
                    method: origMethod,
                    headers: directHeaders,
                    body: item.body ?? undefined,
                  },
                  10000,
                );
                if (directRes.ok || directRes.status === 409) {
                  res = directRes;
                }
              } catch {
                // ignore fallback error
              }
            }
          }

          if (res.ok || res.status === 409 || (item.method === "DELETE" && res.status === 404)) {
            if (res.ok && item.table) {
              try {
                const serverData = await res.clone().json();
                if (Array.isArray(serverData)) {
                  await idbPutMany(item.table, serverData as Record<string, unknown>[]);
                } else if (serverData && typeof serverData === "object") {
                  await idbPutMany(item.table, [serverData as Record<string, unknown>]);
                }
              } catch {
                // minimal response or no json body
              }
            }
            await removeSyncItem(item.queueId);
            successfullySyncedCount++;
            if (item.table) syncedTables.add(item.table);
          } else if (
            res.status === 400 ||
            res.status === 404 ||
            res.status === 406 ||
            res.status === 413 ||
            res.status === 422
          ) {
            // Permanent client error on a stale queued request; remove so it never blocks table reconciliation
            await removeSyncItem(item.queueId);
          } else if (res.status === 401 || res.status === 403) {
            break;
          }
        }
      } catch {
        // Network error while flushing; stop this batch and retry via autoSync
        break;
      }
    }
  } finally {
    syncInProgress = false;
    const remaining = await idbGetAll<SyncQueueItem>("sync_queue");
    notifySyncState({
      isSyncing: false,
      pendingCount: remaining.length,
      lastSyncedAt: successfullySyncedCount > 0 ? Date.now() : currentSyncState.lastSyncedAt,
    });

    if (successfullySyncedCount > 0 && typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(OFFLINE_SYNC_SUCCESS_EVENT, {
          detail: {
            syncedCount: successfullySyncedCount,
            tables: Array.from(syncedTables),
            remainingCount: remaining.length,
          },
        }),
      );
    }

    if (remaining.length > 0 && navigator.onLine) {
      triggerAutoSync(3000);
    }
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
        const res = await nativeFetch(input, init);
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
      } catch (err) {
        if (navigator.onLine) {
          throw err;
        }
      }
    }

    // Offline auth fallback: only when strictly offline
    if (!navigator.onLine) {
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
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
  }

  // 2. Storage Endpoints (/storage/v1/*)
  if (url.pathname.includes("/storage/v1/")) {
    // Storage object remove: DELETE /storage/v1/object/<bucket> (with JSON body { prefixes: string[] })
    const batchDeleteMatch = /\/storage\/v1\/object\/([^/]+)$/.exec(url.pathname);
    if (batchDeleteMatch && method === "DELETE") {
      const bucket = decodeURIComponent(batchDeleteMatch[1]);
      const bodyJson = (await req
        .clone()
        .json()
        .catch(() => ({}))) as { prefixes?: string[] };
      const prefixes = bodyJson.prefixes ?? [];
      for (const p of prefixes) {
        try {
          const db = await openOfflineDB();
          const tx = db.transaction("storage_blobs", "readwrite");
          tx.objectStore("storage_blobs").delete(`${bucket}/${p}`);
        } catch {
          // ignore
        }
      }

      if (navigator.onLine) {
        try {
          const authHeader =
            req.headers.get("authorization") || req.headers.get("Authorization") || "";
          const proxyRes = await quickFetch(
            `/api/storage-proxy?action=remove&bucket=${encodeURIComponent(bucket)}`,
            {
              method: "POST",
              headers: {
                authorization: authHeader,
                "content-type": "application/json",
              },
              body: JSON.stringify(bodyJson),
            },
            6000,
          );
          if (proxyRes.ok) return proxyRes;
        } catch {
          // Queue below
        }
      }

      await enqueueSyncItem({
        kind: "storage",
        url: req.url,
        method,
        headers: extractHeadersRecord(req.headers),
        body: JSON.stringify(bodyJson),
        storageBucket: bucket,
      });

      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Batch signed URLs: POST /storage/v1/object/sign/<bucket>
    const batchSignMatch = /\/storage\/v1\/object\/sign\/([^/]+)$/.exec(url.pathname);
    if (batchSignMatch && method === "POST") {
      const bucket = decodeURIComponent(batchSignMatch[1]);
      const bodyJson = (await req
        .clone()
        .json()
        .catch(() => ({}))) as { paths?: string[] };
      const paths = bodyJson.paths ?? [];

      if (navigator.onLine) {
        try {
          const authHeader =
            req.headers.get("authorization") || req.headers.get("Authorization") || "";
          const proxyRes = await quickFetch(
            `/api/storage-proxy?action=sign&bucket=${encodeURIComponent(bucket)}`,
            {
              method: "POST",
              headers: {
                authorization: authHeader,
                "content-type": "application/json",
              },
              body: JSON.stringify(bodyJson),
            },
            5000,
          );
          if (proxyRes.ok) {
            return proxyRes;
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

      if (navigator.onLine) {
        try {
          let authHeader = await resolveRequestAuthHeader(req.headers);
          let proxyRes = await quickFetch(
            `/api/storage-proxy?action=sign-single&bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(objectPath)}`,
            {
              method: "POST",
              headers: {
                authorization: authHeader,
                "content-type": "application/json",
              },
              body: JSON.stringify({ path: objectPath }),
            },
            6000,
          );
          if (proxyRes.status === 401) {
            authHeader = await resolveRequestAuthHeader(req.headers, true);
            proxyRes = await quickFetch(
              `/api/storage-proxy?action=sign-single&bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(objectPath)}`,
              {
                method: "POST",
                headers: {
                  authorization: authHeader,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ path: objectPath }),
              },
              6000,
            );
          }
          if (proxyRes.ok) return proxyRes;
        } catch {
          // Fall through to local blob URL
        }
      }

      if (!navigator.onLine || !isMutableStoragePath(objectPath)) {
        const localUrl = await getStorageBlobUrl(bucket, objectPath);
        if (localUrl) {
          return new Response(JSON.stringify({ signedURL: localUrl, signedUrl: localUrl }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
    }

    // Upload or Delete object: /storage/v1/object/<bucket>/<path...>
    const objectMatch = /\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (objectMatch && (method === "POST" || method === "PUT")) {
      const bucket = decodeURIComponent(objectMatch[1]);
      const objectPath = decodeURIComponent(objectMatch[2]);

      // If body is FormData (as sent by @supabase/storage-js for Blobs), extract actual binary file
      let targetBlob: Blob = await req.clone().blob();
      let targetType = req.headers.get("content-type") ?? undefined;
      const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
      if (contentType.includes("multipart/form-data")) {
        try {
          const fd = await req.clone().formData();
          for (const [, val] of fd.entries()) {
            if (val instanceof Blob) {
              targetBlob = val;
              targetType = val.type || "application/octet-stream";
              break;
            }
          }
        } catch {
          // fallback to raw body
        }
      }

      await saveStorageBlob(bucket, objectPath, targetBlob, targetType);

      if (navigator.onLine) {
        try {
          let authHeader = await resolveRequestAuthHeader(req.headers);
          let proxyRes = await quickFetch(
            `/api/storage-proxy?action=upload&bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(objectPath)}`,
            {
              method: "POST",
              headers: {
                authorization: authHeader,
                "content-type": targetType || "application/octet-stream",
              },
              body: targetBlob,
            },
            30000,
          );
          if (proxyRes.status === 401) {
            authHeader = await resolveRequestAuthHeader(req.headers, true);
            proxyRes = await quickFetch(
              `/api/storage-proxy?action=upload&bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(objectPath)}`,
              {
                method: "POST",
                headers: {
                  authorization: authHeader,
                  "content-type": targetType || "application/octet-stream",
                },
                body: targetBlob,
              },
              30000,
            );
          }
          if (proxyRes.ok) return proxyRes;
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
        contentType: targetType ?? "application/octet-stream",
      });

      return new Response(
        JSON.stringify({ Key: `${bucket}/${objectPath}`, Id: crypto.randomUUID() }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Downloading a signed storage object while online: cache encrypted blob in IndexedDB for offline viewing
    const signedDownloadMatch = /\/storage\/v1\/object\/sign\/([^/]+)\/([^?]+)/.exec(url.pathname);
    if (signedDownloadMatch && method === "GET") {
      const bucket = decodeURIComponent(signedDownloadMatch[1]);
      const objectPath = decodeURIComponent(signedDownloadMatch[2]);
      if (navigator.onLine) {
        try {
          const res = await quickFetch(
            req.clone(),
            { cache: isMutableStoragePath(objectPath) ? "no-store" : "default" },
            6000,
          );
          if (res.ok) {
            const clonedBlob = await res.clone().blob();
            void saveStorageBlob(
              bucket,
              objectPath,
              clonedBlob,
              res.headers.get("content-type") ?? undefined,
            );
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
      const isPublicDiaryFeed =
        table === "diary_entries" && Boolean(url.searchParams.get("user_id")?.startsWith("neq."));
      const isB2Table =
        table === "diary_entries" ||
        table === "diary_folders" ||
        table === "notes" ||
        table === "note_folders" ||
        table === "gallery_images" ||
        table === "chat_sessions" ||
        table === "chat_messages" ||
        table === "blog_posts" ||
        table === "blog_comments" ||
        table === "blog_likes" ||
        table === "comment_votes" ||
        table === "profiles";

      const reconcileRemoteTableRows = async (
        freshList: Record<string, unknown>[],
        isFullTable: boolean,
        sessionFilterId?: string | null,
      ): Promise<boolean> => {
        const beforeLocal = await idbGetAll<Record<string, unknown>>(table);
        const beforeSerialized = JSON.stringify(beforeLocal);

        const queueItems = await idbGetAll<SyncQueueItem>("sync_queue");
        const nowMs = Date.now();
        const hasPendingForTable = queueItems.some(
          (q) => q.table === table && nowMs - q.createdAt < 24 * 60 * 60 * 1000,
        );
        if (!hasPendingForTable) {
          const freshIds = new Set(
            freshList
              .map((r) => r[pk])
              .filter((k): k is string | number => typeof k === "string" || typeof k === "number"),
          );
          if (table === "diary_entries") {
            const staleDiaryKeys = beforeLocal
              .filter((r) =>
                isPublicDiaryFeed ? r.user_id === "_anonymous" : r.user_id !== "_anonymous",
              )
              .map((r) => r[pk])
              .filter(
                (k): k is string | number =>
                  (typeof k === "string" || typeof k === "number") && !freshIds.has(k),
              );
            if (staleDiaryKeys.length > 0) {
              await idbDeleteKeys(table, staleDiaryKeys);
            }
          } else if (isFullTable) {
            const staleKeys = beforeLocal
              .map((r) => r[pk])
              .filter(
                (k): k is string | number =>
                  (typeof k === "string" || typeof k === "number") && !freshIds.has(k),
              );
            if (staleKeys.length > 0) {
              await idbDeleteKeys(table, staleKeys);
            }
          } else if (table === "chat_messages" && sessionFilterId) {
            const staleMsgKeys = beforeLocal
              .filter((r) => String(r.session_id ?? "") === sessionFilterId)
              .map((r) => r[pk])
              .filter(
                (k): k is string | number =>
                  (typeof k === "string" || typeof k === "number") && !freshIds.has(k),
              );
            if (staleMsgKeys.length > 0) {
              await idbDeleteKeys(table, staleMsgKeys);
            }
          }
        }
        await idbPutMany(table, freshList);
        const afterLocal = await idbGetAll<Record<string, unknown>>(table);
        return JSON.stringify(afterLocal) !== beforeSerialized;
      };

      const fetchRowsFromRemote = async (
        reqClone: Request,
        timeoutMs: number,
      ): Promise<{ rows: Record<string, unknown>[]; isFullTable: boolean } | null> => {
        if (isB2Table) {
          try {
            let authHeader = await resolveRequestAuthHeader(reqClone.headers);
            const proxyQueryUrl = `/api/storage-proxy?action=db-query&table=${encodeURIComponent(table)}${
              isPublicDiaryFeed ? "&publicFeed=1" : ""
            }`;
            let proxyRes = await quickFetch(
              proxyQueryUrl,
              {
                method: "POST",
                headers: {
                  authorization: authHeader,
                  "content-type": "application/json",
                },
              },
              timeoutMs,
            );
            if (proxyRes.status === 401) {
              authHeader = await resolveRequestAuthHeader(reqClone.headers, true);
              proxyRes = await quickFetch(
                proxyQueryUrl,
                {
                  method: "POST",
                  headers: {
                    authorization: authHeader,
                    "content-type": "application/json",
                  },
                },
                timeoutMs,
              );
            }
            if (proxyRes.ok) {
              const data = await proxyRes.json().catch(() => null);
              if (Array.isArray(data)) {
                return {
                  rows: data as Record<string, unknown>[],
                  isFullTable: !isPublicDiaryFeed,
                };
              }
            }
          } catch {
            // Fall through to direct Supabase PostgREST fetch
          }
        }
        if (reqClone.method.toUpperCase() === "HEAD") {
          return null;
        }
        const res = await quickFetch(reqClone, undefined, timeoutMs);
        if (!res.ok) return null;
        const data = await res.json().catch(() => null);
        const selectParam = url.searchParams.get("select") || "*";
        const isWildcardSelect = selectParam === "*" || selectParam.includes("id");
        if (!isWildcardSelect) {
          return null;
        }
        const filterKeys = Array.from(url.searchParams.keys()).filter(
          (k) => k !== "select" && k !== "order" && k !== "user_id",
        );
        const isFullTable = filterKeys.length === 0 && !isPublicDiaryFeed;
        if (Array.isArray(data)) {
          return { rows: data as Record<string, unknown>[], isFullTable };
        }
        if (data && typeof data === "object") {
          return { rows: [data as Record<string, unknown>], isFullTable: false };
        }
        return null;
      };

      const eqSessionParam = url.searchParams.get("session_id");
      const sessionFilterId =
        eqSessionParam && eqSessionParam.startsWith("eq.") ? eqSessionParam.slice(3) : null;
      const syncScopeKey = isPublicDiaryFeed ? `${table}:public` : table;

      const syncTableFromServer = (
        reqClone: Request,
        timeoutMs: number,
        notifyOnDiff: boolean,
      ): Promise<{ rows: Record<string, unknown>[]; isFullTable: boolean } | null> => {
        const existingInFlight = inFlightTableSyncs.get(syncScopeKey);
        if (existingInFlight) return existingInFlight;

        const task = (async () => {
          try {
            const remoteRes = await fetchRowsFromRemote(reqClone, timeoutMs);
            if (!remoteRes) return null;
            markTableHydrated(syncScopeKey);
            markTableHydrated(table);
            const changed = await reconcileRemoteTableRows(
              remoteRes.rows,
              remoteRes.isFullTable,
              sessionFilterId,
            );
            if (changed && notifyOnDiff && typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent(OFFLINE_DATA_UPDATED_EVENT, { detail: { table } }),
              );
            }
            return remoteRes;
          } catch {
            return null;
          } finally {
            inFlightTableSyncs.delete(syncScopeKey);
          }
        })();

        inFlightTableSyncs.set(syncScopeKey, task);
        return task;
      };

      // SELECT / HEAD — Always hydrate from remote server on first read per session while online
      // so every device sees 100% identical data immediately, then use instant local cache + background sync.
      if (method === "GET" || method === "HEAD") {
        const allLocal = await idbGetAll<Record<string, unknown>>(table);
        const filtered = filterAndSortRows(allLocal, url.searchParams);
        const hasFilteredLocalRows = filtered.length > 0;
        const isSessionHydrated = sessionHydratedTables.has(syncScopeKey);

        if (hasFilteredLocalRows && isSessionHydrated) {
          if (navigator.onLine) {
            if (currentSyncState.pendingCount > 0) {
              void flushOfflineSyncQueue();
            }
            const nowMs = Date.now();
            const lastReval = recentRevalidations.get(syncScopeKey) ?? 0;
            const revalIntervalMs =
              table === "chat_sessions" || table === "chat_messages" ? 800 : 1500;
            if (nowMs - lastReval > revalIntervalMs) {
              recentRevalidations.set(syncScopeKey, nowMs);
              void syncTableFromServer(req.clone(), 8000, true);
            }
          }

          return buildPostgrestResponse(filtered, method, req.headers, 200);
        }

        if (navigator.onLine) {
          try {
            if (currentSyncState.pendingCount > 0) {
              await flushOfflineSyncQueue();
            }

            recentRevalidations.set(syncScopeKey, Date.now());
            const remoteRes = await syncTableFromServer(req.clone(), 8000, false);
            if (remoteRes) {
              const updatedAllLocal = await idbGetAll<Record<string, unknown>>(table);
              const freshFiltered = filterAndSortRows(updatedAllLocal, url.searchParams);
              return buildPostgrestResponse(freshFiltered, method, req.headers, 200);
            }

            const res = await quickFetch(req.clone(), undefined, 5000);
            if (res.ok) {
              markTableHydrated(syncScopeKey);
              markTableHydrated(table);
              if (method === "GET") {
                const cloned = res.clone();
                void cloned
                  .json()
                  .then((data) => {
                    if (Array.isArray(data)) {
                      void idbPutMany(table, data as Record<string, unknown>[]);
                    } else if (data && typeof data === "object") {
                      void idbPutMany(table, [data as Record<string, unknown>]);
                    }
                  })
                  .catch(() => {});
              }
              return res;
            }
          } catch {
            // Fall through to IndexedDB offline query on network failure
          }
        }

        return buildPostgrestResponse(filtered, method, req.headers, 200);
      }

      const b2MutateUrl = isB2Table
        ? `/api/storage-proxy?action=db-mutate&table=${encodeURIComponent(table)}&method=${method}&${url.searchParams.toString()}`
        : null;

      // INSERT / UPSERT
      if (method === "POST") {
        const bodyText = await req.clone().text();
        const parsed = bodyText
          ? (JSON.parse(bodyText) as Record<string, unknown> | Record<string, unknown>[])
          : [];
        const rawList = Array.isArray(parsed) ? parsed : [parsed];
        const normalizedRows = rawList.map((r) => withTableDefaults(table, r));

        await idbPutMany(table, normalizedRows);

        const forwardBody = JSON.stringify(
          Array.isArray(parsed) ? normalizedRows : normalizedRows[0],
        );
        if (navigator.onLine) {
          if (b2MutateUrl) {
            try {
              let authHeader = await resolveRequestAuthHeader(req.headers);
              let proxyRes = await quickFetch(
                b2MutateUrl,
                {
                  method: "POST",
                  headers: {
                    authorization: authHeader,
                    "content-type": "application/json",
                  },
                  body: forwardBody,
                },
                10000,
              );
              if (proxyRes.status === 401) {
                authHeader = await resolveRequestAuthHeader(req.headers, true);
                proxyRes = await quickFetch(
                  b2MutateUrl,
                  {
                    method: "POST",
                    headers: {
                      authorization: authHeader,
                      "content-type": "application/json",
                    },
                    body: forwardBody,
                  },
                  10000,
                );
              }
              if (proxyRes.ok) {
                const serverData = await proxyRes
                  .clone()
                  .json()
                  .catch(() => null);
                if (Array.isArray(serverData)) {
                  await idbPutMany(table, serverData as Record<string, unknown>[]);
                }
                return buildPostgrestResponse(normalizedRows, method, req.headers, 201);
              }
            } catch {
              // Fall through to direct Supabase PostgREST below
            }
          }

          // Direct Supabase PostgREST fallback (or primary when not a B2 table)
          try {
            const res = await quickFetch(
              req.url,
              {
                method,
                headers: req.headers,
                body: forwardBody,
              },
              8000,
            );
            if (res.ok) {
              const serverData = await res
                .clone()
                .json()
                .catch(() => null);
              if (Array.isArray(serverData)) {
                await idbPutMany(table, serverData as Record<string, unknown>[]);
              } else if (serverData && typeof serverData === "object") {
                await idbPutMany(table, [serverData as Record<string, unknown>]);
              }
              return buildPostgrestResponse(normalizedRows, method, req.headers, 201);
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
        if (table === "diary_entries" && patchObj.is_public !== undefined && !patchObj.visibility) {
          patchObj.visibility = patchObj.is_public ? "public_anon" : "private";
        }
        const now = new Date().toISOString();
        const hasUpdatedAtColumn =
          table === "diary_entries" ||
          table === "diary_folders" ||
          table === "notes" ||
          table === "note_folders" ||
          table === "blog_posts" ||
          table === "blog_comments" ||
          table === "profiles" ||
          table === "vault_keys";
        if (hasUpdatedAtColumn && patchObj.updated_at === undefined) {
          patchObj.updated_at = now;
        }
        const normalizedPatchText = JSON.stringify(patchObj);
        const allLocal = await idbGetAll<Record<string, unknown>>(table);
        const matched = filterAndSortRows(allLocal, url.searchParams);
        const updatedRows = matched.map((row) => ({
          ...row,
          ...patchObj,
          ...(row.updated_at !== undefined && patchObj.updated_at === undefined
            ? { updated_at: now }
            : {}),
        }));
        await idbPutMany(table, updatedRows);

        if (navigator.onLine) {
          if (b2MutateUrl) {
            try {
              let authHeader = await resolveRequestAuthHeader(req.headers);
              let proxyRes = await quickFetch(
                b2MutateUrl,
                {
                  method: "POST",
                  headers: {
                    authorization: authHeader,
                    "content-type": "application/json",
                  },
                  body: normalizedPatchText,
                },
                10000,
              );
              if (proxyRes.status === 401) {
                authHeader = await resolveRequestAuthHeader(req.headers, true);
                proxyRes = await quickFetch(
                  b2MutateUrl,
                  {
                    method: "POST",
                    headers: {
                      authorization: authHeader,
                      "content-type": "application/json",
                    },
                    body: normalizedPatchText,
                  },
                  10000,
                );
              }
              if (proxyRes.ok) {
                return buildPostgrestResponse(updatedRows, method, req.headers, 200);
              }
            } catch {
              // Fall through to direct Supabase PostgREST below
            }
          }

          try {
            const res = await quickFetch(
              req.url,
              {
                method,
                headers: req.headers,
                body: normalizedPatchText,
              },
              8000,
            );
            if (res.ok) {
              return buildPostgrestResponse(updatedRows, method, req.headers, 200);
            }
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
          body: normalizedPatchText,
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

        if (table === "chat_sessions" && keysToDelete.length > 0) {
          const sessionSet = new Set(keysToDelete.map(String));
          const allMessages = await idbGetAll<Record<string, unknown>>("chat_messages");
          const msgKeysToDelete = allMessages
            .filter((m) => typeof m.session_id === "string" && sessionSet.has(m.session_id))
            .map((m) => m.id)
            .filter((k): k is string | number => typeof k === "string" || typeof k === "number");
          if (msgKeysToDelete.length > 0) {
            await idbDeleteKeys("chat_messages", msgKeysToDelete);
          }
        }

        if (navigator.onLine) {
          if (b2MutateUrl) {
            try {
              let authHeader = await resolveRequestAuthHeader(req.headers);
              let proxyRes = await quickFetch(
                b2MutateUrl,
                {
                  method: "POST",
                  headers: {
                    authorization: authHeader,
                    "content-type": "application/json",
                  },
                },
                10000,
              );
              if (proxyRes.status === 401) {
                authHeader = await resolveRequestAuthHeader(req.headers, true);
                proxyRes = await quickFetch(
                  b2MutateUrl,
                  {
                    method: "POST",
                    headers: {
                      authorization: authHeader,
                      "content-type": "application/json",
                    },
                  },
                  10000,
                );
              }
              if (proxyRes.ok) {
                return buildPostgrestResponse(matched, method, req.headers, 200);
              }
            } catch {
              // Fall through to direct Supabase PostgREST below
            }
          }

          try {
            const res = await quickFetch(req.clone(), undefined, 8000);
            if (res.ok) {
              return buildPostgrestResponse(matched, method, req.headers, 200);
            }
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

export interface B2MigrateResult {
  configured: boolean;
  bucket?: string;
  endpoint?: string;
  syncedRowsCount?: number;
  migratedFilesCount?: number;
  message?: string;
}

export async function syncAllToBackblazeB2(): Promise<B2MigrateResult> {
  const token = await getFreshAccessToken();
  if (!token) {
    return { configured: false, message: "Not signed in" };
  }
  const res = await quickFetch(
    "/api/storage-proxy?action=b2-migrate",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    },
    45000,
  );
  if (!res.ok) {
    throw new Error(`Backblaze B2 sync failed (${res.status})`);
  }
  return (await res.json()) as B2MigrateResult;
}

function startSyncWatchdog(): void {
  if (typeof window === "undefined" || watchdogInterval !== null) return;
  watchdogInterval = window.setInterval(async () => {
    if (!navigator.onLine || syncInProgress) return;
    try {
      const items = await idbGetAll<SyncQueueItem>("sync_queue");
      if (items.length > 0) {
        void flushOfflineSyncQueue();
      }
    } catch {
      // ignore
    }
  }, 4000);
}

// Register window online/offline listeners, visibility, focus, and background watchdog
if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    notifySyncState({ isOnline: true });
    triggerAutoSync(0);
    setTimeout(() => triggerAutoSync(1000), 1000);
    setTimeout(() => triggerAutoSync(3000), 3000);
  });

  window.addEventListener("offline", () => {
    notifySyncState({ isOnline: false });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && navigator.onLine) {
      triggerAutoSync(50);
    }
  });

  window.addEventListener("focus", () => {
    if (navigator.onLine) {
      triggerAutoSync(50);
    }
  });

  startSyncWatchdog();

  // Initialize pending count on startup and sync immediately if online
  void idbGetAll<SyncQueueItem>("sync_queue").then((items) => {
    notifySyncState({ isOnline: navigator.onLine, pendingCount: items.length });
    if (navigator.onLine && items.length > 0) {
      triggerAutoSync(300);
    }
  });
}
