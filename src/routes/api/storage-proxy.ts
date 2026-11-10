import { createFileRoute } from "@tanstack/react-router";
import { createClient, type User } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  B2_COMMUNITY_SCOPE,
  B2_SYNCED_TABLES,
  type B2Config,
  b2DeleteStorageObjects,
  b2GetStorageObject,
  b2GetTableStore,
  b2HeadStorageObject,
  b2PutStorageObject,
  b2SaveTableStore,
  createSignedProxyDownloadUrl,
  isB2CommunityTable,
  isB2SyncedTable,
  isChatSessionExpired,
  mergeB2AndSupabaseRows,
  readServerEnv,
  resolveB2Config,
  verifySignedProxyDownloadUrl,
  withUserTableLock,
} from "@/lib/b2-storage";

function getSupabaseUrl(request: Request): string {
  return (
    readServerEnv("SUPABASE_URL", request) ||
    readServerEnv("VITE_SUPABASE_URL", request) ||
    (typeof process !== "undefined"
      ? process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ""
      : "")
  );
}

function getSupabaseAnonOrServiceKey(request: Request): string {
  return (
    readServerEnv("SUPABASE_ANON_KEY", request) ||
    readServerEnv("VITE_SUPABASE_ANON_KEY", request) ||
    readServerEnv("SUPABASE_PUBLISHABLE_KEY", request) ||
    readServerEnv("VITE_SUPABASE_PUBLISHABLE_KEY", request) ||
    readServerEnv("SUPABASE_SERVICE_ROLE_KEY", request) ||
    (typeof process !== "undefined"
      ? process.env.SUPABASE_ANON_KEY ||
        process.env.VITE_SUPABASE_ANON_KEY ||
        process.env.SUPABASE_PUBLISHABLE_KEY ||
        process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        ""
      : "")
  );
}

function getAdminClient(request: Request, bearerToken?: string) {
  const url = getSupabaseUrl(request);
  const serviceKey =
    readServerEnv("SUPABASE_SERVICE_ROLE_KEY", request) ||
    (typeof process !== "undefined" ? process.env.SUPABASE_SERVICE_ROLE_KEY : "") ||
    "";
  const key = serviceKey || getSupabaseAnonOrServiceKey(request);

  if (!url || !key) {
    throw new Error("Supabase configuration missing on server");
  }

  const headers: Record<string, string> = {};
  if (!serviceKey && bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(Object.keys(headers).length > 0 ? { global: { headers } } : {}),
  });
}

function getUserScopedClient(request: Request, bearerToken: string) {
  const url = getSupabaseUrl(request);
  const anonKey =
    readServerEnv("SUPABASE_ANON_KEY", request) ||
    readServerEnv("VITE_SUPABASE_ANON_KEY", request) ||
    readServerEnv("SUPABASE_PUBLISHABLE_KEY", request) ||
    readServerEnv("VITE_SUPABASE_PUBLISHABLE_KEY", request) ||
    readServerEnv("SUPABASE_SERVICE_ROLE_KEY", request);

  if (!url || !anonKey) {
    throw new Error("Supabase configuration missing on server");
  }

  return createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
      },
    },
  });
}

const MAX_VERIFIED_TOKENS = 500;
const verifiedTokenCache = new Map<string, { user: User; expiresAt: number }>();

function cacheVerifiedUser(token: string, user: User, expiresAt: number) {
  if (verifiedTokenCache.size >= MAX_VERIFIED_TOKENS) {
    const now = Date.now();
    for (const [key, val] of verifiedTokenCache) {
      if (val.expiresAt <= now || verifiedTokenCache.size >= MAX_VERIFIED_TOKENS) {
        verifiedTokenCache.delete(key);
      }
    }
  }
  verifiedTokenCache.set(token, { user, expiresAt });
}

const DANGEROUS_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function sanitizeRecord(input: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (DANGEROUS_OBJECT_KEYS.has(k)) continue;
    clean[k] = v;
  }
  return clean;
}

const SAFE_RASTER_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function sanitizeDownloadContentType(
  rawType: string | undefined,
  bucket: string,
  path: string,
): string {
  const lowerPath = path.toLowerCase();
  if (bucket === "gallery" || lowerPath.endsWith(".bin")) {
    return "application/octet-stream";
  }
  const normalizedMime = (rawType || "").split(";")[0].trim().toLowerCase();
  if (SAFE_RASTER_IMAGE_MIMES.has(normalizedMime)) {
    return normalizedMime;
  }
  return "application/octet-stream";
}

function sanitizeUploadContentType(
  rawType: string | undefined,
  bucket: string,
  path: string,
): string {
  return sanitizeDownloadContentType(rawType, bucket, path);
}

const STORAGE_RATE_WINDOW_MS = 60_000;
const STORAGE_RATE_MAX_REQUESTS = 600;
const storageRateBuckets = new Map<string, { count: number; resetAt: number }>();

function checkStorageRateLimit(key: string): boolean {
  const now = Date.now();
  if (storageRateBuckets.size > 2000) {
    for (const [k, v] of storageRateBuckets) {
      if (v.resetAt <= now) storageRateBuckets.delete(k);
    }
  }
  const existing = storageRateBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    storageRateBuckets.set(key, { count: 1, resetAt: now + STORAGE_RATE_WINDOW_MS });
    return true;
  }
  existing.count += 1;
  return existing.count <= STORAGE_RATE_MAX_REQUESTS;
}

function normalizeStoragePath(p: string): string {
  if (typeof p !== "string" || !p || p.length > 512) return "";
  let decoded = p;
  try {
    for (let i = 0; i < 2; i++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return "";
  }
  const clean = decoded.replace(/^[/\\]+/, "").trim();
  if (!clean || clean.includes("\\") || clean.includes("..")) {
    return "";
  }
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return "";
    }
  }
  const segments = clean.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === ".." || DANGEROUS_OBJECT_KEYS.has(seg)) {
      return "";
    }
  }
  return clean;
}

function isAllowedStoragePath(
  user: User,
  bucket: string,
  rawPath: string,
  isRead = false,
): boolean {
  const path = normalizeStoragePath(rawPath);
  if (!path) return false;

  const userPrefix = `${user.id}/`;

  if (bucket === "gallery") {
    return path.startsWith(userPrefix);
  }

  if (bucket === "media") {
    if (isRead) {
      if (path.startsWith(userPrefix)) {
        return true;
      }
      // Only allow cross-user reads in "media" for public unencrypted community images
      return /\.(jpg|jpeg|png|webp|gif)$/i.test(path);
    }
    return path.startsWith(userPrefix);
  }

  return path.startsWith(userPrefix);
}

function extractBearerToken(request: Request): string {
  const authorization =
    request.headers.get("authorization") || request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return "";
  }
  return authorization.slice("Bearer ".length).trim();
}

async function authenticateUser(request: Request, adminClient: ReturnType<typeof getAdminClient>) {
  const token = extractBearerToken(request);
  if (!token) return null;

  const now = Date.now();
  const cached = verifiedTokenCache.get(token);
  if (cached && cached.expiresAt > now) {
    return cached.user;
  }

  try {
    const { data, error } = await adminClient.auth.getUser(token);
    if (error || !data?.user?.id) {
      return null;
    }
    cacheVerifiedUser(token, data.user, now + 5 * 60 * 1000);
    return data.user;
  } catch {
    return null;
  }
}

const ALLOWED_BUCKETS = new Set(["gallery", "media"]);

const JSON_SECURITY_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

function parseScalar(raw: string): unknown {
  if (raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

function matchesPostgrestCondition(
  row: Record<string, unknown>,
  col: string,
  expr: string,
): boolean {
  const val = row[col];
  if (expr.startsWith("not.")) {
    return !matchesPostgrestCondition(row, col, expr.slice(4));
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

function filterRowsByQueryParams(
  rows: Record<string, unknown>[],
  params: URLSearchParams,
): Record<string, unknown>[] {
  const reserved = new Set([
    "action",
    "table",
    "method",
    "bucket",
    "path",
    "select",
    "order",
    "limit",
    "offset",
    "on_conflict",
    "publicFeed",
  ]);
  return rows.filter((row) => {
    for (const [key, value] of params.entries()) {
      if (reserved.has(key) || key === "or" || key === "and") continue;
      if (!matchesPostgrestCondition(row, key, value)) return false;
    }
    return true;
  });
}

function sanitizeAnonymousDiaryRow(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id,
    user_id: "_anonymous",
    title: r.title ?? null,
    content: r.content ?? "",
    mood: r.mood ?? null,
    entry_date: r.entry_date ?? null,
    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? r.created_at ?? null,
    is_public: true,
    visibility: "public_anon",
    image_path: r.image_path ?? null,
    music: r.music ?? null,
    iv: null,
    folder_id: null,
  };
}

async function fetchUserRowsFromSupabase(
  request: Request,
  bearerToken: string,
  userId: string,
  table: string,
): Promise<Record<string, unknown>[]> {
  try {
    const userClient = getUserScopedClient(request, bearerToken);
    if (table === "profiles") {
      const { data } = await userClient
        .from("profiles")
        .select("id, display_name, tour_completed, created_at, updated_at")
        .limit(1000);
      return ((data ?? []) as unknown as Record<string, unknown>[]).map((r) =>
        r.id === userId
          ? r
          : {
              id: r.id,
              display_name: r.display_name ?? null,
              created_at: r.created_at ?? null,
              updated_at: r.updated_at ?? null,
            },
      );
    }
    if (isB2CommunityTable(table)) {
      const { data } = await (
        userClient.from(table as "blog_posts") as ReturnType<typeof userClient.from>
      )
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500);
      return (data ?? []) as unknown as Record<string, unknown>[];
    }
    if (table === "chat_messages") {
      const { data } = await userClient
        .from("chat_messages")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: true });
      const rows = (data ?? []) as unknown as Record<string, unknown>[];
      return rows.filter((r) => String(r.user_id ?? "") === userId);
    }
    const { data } = await (userClient.from(table as "notes") as ReturnType<typeof userClient.from>)
      .select("*")
      .eq("user_id" as never, userId as never);
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    return rows.filter((r) => String(r.user_id ?? "") === userId);
  } catch {
    return [];
  }
}

async function syncPublicDiaryEntriesToCommunityStore(
  b2Config: B2Config,
  userId: string,
  userDiaryRows: Record<string, unknown>[],
  deletedDiaryIds: Record<string, string>,
): Promise<void> {
  await withUserTableLock(B2_COMMUNITY_SCOPE, "public_diary_entries", async () => {
    try {
      const existingDoc = await b2GetTableStore(
        b2Config,
        B2_COMMUNITY_SCOPE,
        "public_diary_entries",
      ).catch(() => null);
      const nowIso = new Date().toISOString();
      const deletedIds: Record<string, string> = {
        ...(existingDoc?.deletedIds ?? {}),
      };
      const rowsById = new Map<string, Record<string, unknown>>();
      const otherUserOwnedIds = new Set<string>();

      for (const r of existingDoc?.rows ?? []) {
        const id = typeof r.id === "string" ? r.id : "";
        if (!id || deletedIds[id]) continue;
        // Keep other users' public entries; we will refresh current user's public entries below
        if (r.user_id !== userId && r.is_public === true && !r.iv) {
          rowsById.set(id, r);
          otherUserOwnedIds.add(id);
        } else if (r.user_id === userId) {
          // Tentatively mark removed unless re-added as public below
          deletedIds[id] = nowIso;
        }
      }

      // Only apply current user's deletions to IDs not owned by another user
      for (const [delId, delTs] of Object.entries(deletedDiaryIds)) {
        if (!otherUserOwnedIds.has(delId)) {
          deletedIds[delId] = delTs;
        }
      }

      for (const r of userDiaryRows) {
        const id = typeof r.id === "string" ? r.id : "";
        if (!id || otherUserOwnedIds.has(id)) continue;
        if (r.is_public === true && !r.iv) {
          delete deletedIds[id];
          rowsById.set(id, { ...r, user_id: userId });
        } else {
          rowsById.delete(id);
          deletedIds[id] = nowIso;
        }
      }

      await b2SaveTableStore(b2Config, {
        version: 1,
        table: "public_diary_entries",
        userId: B2_COMMUNITY_SCOPE,
        updatedAt: nowIso,
        rows: Array.from(rowsById.values()),
        deletedIds,
      });
    } catch {
      // Ignore community sync transient error without leaking details to logs
    }
  });
}

async function purgeChatSessionsAndMessages(
  request: Request,
  bearerToken: string,
  userId: string,
  b2Config: B2Config | null,
  sessionIds: string[],
): Promise<void> {
  if (sessionIds.length === 0) return;
  const sessionIdSet = new Set(sessionIds);
  const nowIso = new Date().toISOString();

  // 1. Delete from Supabase (chat_messages and chat_sessions)
  try {
    const userClient = getUserScopedClient(request, bearerToken);
    await userClient
      .from("chat_messages")
      .delete()
      .in("session_id", sessionIds)
      .eq("user_id", userId);
    await userClient.from("chat_sessions").delete().in("id", sessionIds).eq("user_id", userId);
  } catch {
    // ignore Supabase errors
  }

  // 2. Cascade-delete messages belonging to these sessions in R2 / Backblaze B2
  if (b2Config) {
    await withUserTableLock(userId, "chat_messages", async () => {
      try {
        const msgDoc = await b2GetTableStore(b2Config, userId, "chat_messages");
        if (!msgDoc) return;
        let changed = false;
        const remainingRows: Record<string, unknown>[] = [];
        for (const r of msgDoc.rows) {
          const sid = typeof r.session_id === "string" ? r.session_id : "";
          const mid = typeof r.id === "string" ? r.id : "";
          if (sid && sessionIdSet.has(sid)) {
            if (mid) msgDoc.deletedIds[mid] = nowIso;
            changed = true;
          } else {
            remainingRows.push(r);
          }
        }
        if (changed) {
          msgDoc.rows = remainingRows;
          msgDoc.updatedAt = nowIso;
          await b2SaveTableStore(b2Config, msgDoc);
        }
      } catch {
        // ignore B2 cascade errors
      }
    });
  }
}

export const Route = createFileRoute("/api/storage-proxy")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const reqOrigin = request.headers.get("origin");
        const selfOrigin = new URL(request.url).origin;
        const allowedOrigin = reqOrigin && reqOrigin === selfOrigin ? reqOrigin : selfOrigin;
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": allowedOrigin,
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
            Vary: "Origin",
          },
        });
      },

      // GET handler for downloading encrypted objects from Backblaze B2 (with automatic Supabase fallback & migration)
      GET: async ({ request }) => {
        try {
          const url = new URL(request.url);
          const action = url.searchParams.get("action") || "download";

          if (action === "b2-status") {
            const bearerToken = extractBearerToken(request);
            const adminClient = getAdminClient(request, bearerToken);
            const user = await authenticateUser(request, adminClient);
            if (!user) {
              return new Response(JSON.stringify({ error: "Unauthorized" }), {
                status: 401,
                headers: JSON_SECURITY_HEADERS,
              });
            }
            const b2Config = await resolveB2Config(request);
            return new Response(
              JSON.stringify({
                configured: Boolean(b2Config),
              }),
              { status: 200, headers: JSON_SECURITY_HEADERS },
            );
          }

          if (action !== "download") {
            return new Response(JSON.stringify({ error: "Unsupported GET action" }), {
              status: 400,
              headers: JSON_SECURITY_HEADERS,
            });
          }

          const bucket = url.searchParams.get("bucket") || "gallery";
          const rawPath = url.searchParams.get("path") || "";
          const safePath = normalizeStoragePath(rawPath);
          const exp = url.searchParams.get("exp") || "";
          const sig = url.searchParams.get("sig") || "";

          if (!ALLOWED_BUCKETS.has(bucket) || !safePath) {
            return new Response(JSON.stringify({ error: "Invalid bucket or path" }), {
              status: 400,
              headers: JSON_SECURITY_HEADERS,
            });
          }

          const bearerToken = extractBearerToken(request);
          const adminClient = getAdminClient(request, bearerToken);
          let authorized = false;

          if (exp && sig) {
            authorized = await verifySignedProxyDownloadUrl(request, bucket, safePath, exp, sig);
          }
          if (!authorized) {
            const user = await authenticateUser(request, adminClient);
            if (user && isAllowedStoragePath(user, bucket, safePath, true)) {
              authorized = true;
            }
          }

          if (!authorized) {
            return new Response(JSON.stringify({ error: "Unauthorized object download" }), {
              status: 403,
              headers: JSON_SECURITY_HEADERS,
            });
          }

          const b2Config = await resolveB2Config(request);
          const isMutableTracker =
            safePath.endsWith("vault-trackers.bin") || safePath.endsWith("gallery-folders.bin");
          const cacheHeader = isMutableTracker
            ? "no-store, no-cache, must-revalidate, private"
            : "private, max-age=3600";

          // 1. Try Backblaze B2 first if configured
          if (b2Config) {
            try {
              const b2Obj = await b2GetStorageObject(b2Config, bucket, safePath);
              if (b2Obj) {
                const safeMime = sanitizeDownloadContentType(b2Obj.contentType, bucket, safePath);
                return new Response(b2Obj.buffer, {
                  status: 200,
                  headers: {
                    "Content-Type": safeMime,
                    "Cache-Control": cacheHeader,
                    "X-Content-Type-Options": "nosniff",
                    "Content-Security-Policy": "default-src 'none'; sandbox",
                    "Cross-Origin-Resource-Policy": "same-origin",
                    "Content-Disposition":
                      safeMime === "application/octet-stream" ? "attachment" : "inline",
                  },
                });
              }
            } catch {
              // Fallback to Supabase Storage silently
            }
          }

          // 2. Fallback to Supabase Storage (and auto-migrate into Backblaze B2 if found!)
          const { data: sbBlob, error: sbErr } = await adminClient.storage
            .from(bucket)
            .download(safePath);

          if (sbErr || !sbBlob) {
            return new Response(JSON.stringify({ error: "Object not found" }), {
              status: 404,
              headers: JSON_SECURITY_HEADERS,
            });
          }

          const buffer = await sbBlob.arrayBuffer();
          const safeMime = sanitizeDownloadContentType(sbBlob.type, bucket, safePath);

          if (b2Config) {
            // Copy existing Supabase object into Backblaze B2 in the background so it is migrated
            void b2PutStorageObject(b2Config, bucket, safePath, buffer, safeMime).catch(() => {});
          }

          return new Response(buffer, {
            status: 200,
            headers: {
              "Content-Type": safeMime,
              "Cache-Control": cacheHeader,
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": "default-src 'none'; sandbox",
              "Cross-Origin-Resource-Policy": "same-origin",
              "Content-Disposition":
                safeMime === "application/octet-stream" ? "attachment" : "inline",
            },
          });
        } catch {
          return new Response(
            JSON.stringify({
              error: "Internal download error",
            }),
            { status: 500, headers: JSON_SECURITY_HEADERS },
          );
        }
      },

      POST: async ({ request }) => {
        try {
          const url = new URL(request.url);
          const action = url.searchParams.get("action") || "upload";
          const bucket = url.searchParams.get("bucket") || "gallery";
          const path = url.searchParams.get("path") || "";

          const bearerToken = extractBearerToken(request);
          const adminClient = getAdminClient(request, bearerToken);
          const user = await authenticateUser(request, adminClient);
          if (!user) {
            return new Response(
              JSON.stringify({ error: "Unauthorized: valid session token required" }),
              { status: 401, headers: JSON_SECURITY_HEADERS },
            );
          }

          if (!checkStorageRateLimit(user.id)) {
            return new Response(
              JSON.stringify({ error: "Too many storage requests. Please slow down." }),
              {
                status: 429,
                headers: { ...JSON_SECURITY_HEADERS, "Retry-After": "15" },
              },
            );
          }

          const b2Config = await resolveB2Config(request);

          // ==================================================================
          // A. Backblaze B2 Status & Full Migration of Existing Supabase Data
          // ==================================================================
          if (action === "b2-migrate") {
            if (!b2Config) {
              return new Response(
                JSON.stringify({
                  configured: false,
                  message:
                    "Backblaze B2 keys not configured yet. Add B2_BUCKET_NAME, B2_ENDPOINT, B2_KEY_ID, and B2_APPLICATION_KEY.",
                }),
                { status: 200, headers: JSON_SECURITY_HEADERS },
              );
            }

            let syncedRowsCount = 0;
            let migratedFilesCount = 0;
            const mediaPathsToMigrate = new Set<string>([
              `${user.id}/vault-trackers.bin`,
              `${user.id}/gallery-folders.bin`,
            ]);
            const galleryPathsToMigrate = new Set<string>();

            for (const table of B2_SYNCED_TABLES) {
              const storeScope = isB2CommunityTable(table) ? B2_COMMUNITY_SCOPE : user.id;
              let expiredIdsForTable: string[] = [];
              let diaryRowsForPublicSync: Record<string, unknown>[] | null = null;
              let diaryDeletedIdsForPublicSync: Record<string, string> = {};

              await withUserTableLock(storeScope, table, async () => {
                const [b2Doc, sbRows] = await Promise.all([
                  b2GetTableStore(b2Config, storeScope, table).catch(() => null),
                  fetchUserRowsFromSupabase(request, bearerToken, user.id, table),
                ]);
                const { mergedDoc, needsB2Save, expiredSessionIds } = mergeB2AndSupabaseRows(
                  storeScope,
                  table,
                  b2Doc,
                  sbRows,
                );
                expiredIdsForTable = expiredSessionIds;
                if (needsB2Save) {
                  await b2SaveTableStore(b2Config, mergedDoc);
                }
                if (table === "diary_entries") {
                  diaryRowsForPublicSync = mergedDoc.rows;
                  diaryDeletedIdsForPublicSync = mergedDoc.deletedIds;
                }
                syncedRowsCount += mergedDoc.rows.length;

                for (const r of mergedDoc.rows) {
                  if (table === "gallery_images" && typeof r.storage_path === "string") {
                    galleryPathsToMigrate.add(r.storage_path);
                  } else if (table === "diary_entries" && typeof r.image_path === "string") {
                    mediaPathsToMigrate.add(r.image_path);
                  } else if (table === "notes" && typeof r.image_url === "string") {
                    mediaPathsToMigrate.add(r.image_url);
                  } else if (
                    table === "blog_posts" &&
                    r.user_id === user.id &&
                    typeof r.image_url === "string"
                  ) {
                    mediaPathsToMigrate.add(r.image_url);
                  }
                }
              });
              if (table === "diary_entries" && diaryRowsForPublicSync) {
                await syncPublicDiaryEntriesToCommunityStore(
                  b2Config,
                  user.id,
                  diaryRowsForPublicSync,
                  diaryDeletedIdsForPublicSync,
                );
              }
              if (table === "chat_sessions" && expiredIdsForTable.length > 0) {
                await purgeChatSessionsAndMessages(
                  request,
                  bearerToken,
                  user.id,
                  b2Config,
                  expiredIdsForTable,
                );
              }
            }

            // Migrate any existing gallery/media files from Supabase Storage to Backblaze B2
            const migrateBucketPaths = async (
              targetBucket: "gallery" | "media",
              pathsSet: Set<string>,
            ) => {
              for (const rawP of pathsSet) {
                const safeP = normalizeStoragePath(rawP);
                if (!safeP || !isAllowedStoragePath(user, targetBucket, safeP, true)) continue;
                try {
                  const existsInB2 = await b2HeadStorageObject(b2Config, targetBucket, safeP);
                  if (existsInB2) continue;
                  const { data: sbBlob, error: sbErr } = await adminClient.storage
                    .from(targetBucket)
                    .download(safeP);
                  if (!sbErr && sbBlob) {
                    const buf = await sbBlob.arrayBuffer();
                    await b2PutStorageObject(
                      b2Config,
                      targetBucket,
                      safeP,
                      buf,
                      sbBlob.type || "application/octet-stream",
                    );
                    migratedFilesCount++;
                  }
                } catch {
                  // ignore individual file errors
                }
              }
            };

            await Promise.all([
              migrateBucketPaths("gallery", galleryPathsToMigrate),
              migrateBucketPaths("media", mediaPathsToMigrate),
            ]);

            return new Response(
              JSON.stringify({
                configured: true,
                syncedRowsCount,
                migratedFilesCount,
              }),
              { status: 200, headers: JSON_SECURITY_HEADERS },
            );
          }

          // ==================================================================
          // B. Encrypted Database Table Read (Diary, Notes, Folders, Gallery, Chats, Blogs)
          // ==================================================================
          if (action === "db-query") {
            const table = url.searchParams.get("table") || "";
            if (!isB2SyncedTable(table)) {
              return new Response(JSON.stringify({ error: "Unsupported B2 table" }), {
                status: 400,
                headers: JSON_SECURITY_HEADERS,
              });
            }

            // Special handling for the anonymous Public Diary Feed (is_public=true & user_id != user.id)
            if (table === "diary_entries" && url.searchParams.get("publicFeed") === "1") {
              let sbPubRows: Record<string, unknown>[] = [];
              try {
                const userClient = getUserScopedClient(request, bearerToken);
                const { data } = await userClient
                  .from("diary_entries")
                  .select("*")
                  .eq("is_public", true)
                  .neq("user_id", user.id)
                  .order("created_at", { ascending: false })
                  .limit(100);
                sbPubRows = (data ?? []) as unknown as Record<string, unknown>[];
              } catch {
                sbPubRows = [];
              }

              if (!b2Config) {
                const anonymized = sbPubRows
                  .filter((r) => r.is_public === true && !r.iv && r.user_id !== user.id)
                  .map((r) => sanitizeAnonymousDiaryRow(r));
                return new Response(JSON.stringify(anonymized), {
                  status: 200,
                  headers: JSON_SECURITY_HEADERS,
                });
              }

              const pubMerged = await withUserTableLock(
                B2_COMMUNITY_SCOPE,
                "public_diary_entries",
                async () => {
                  const b2Doc = await b2GetTableStore(
                    b2Config,
                    B2_COMMUNITY_SCOPE,
                    "public_diary_entries",
                  ).catch(() => null);
                  const { mergedDoc, needsB2Save } = mergeB2AndSupabaseRows(
                    B2_COMMUNITY_SCOPE,
                    "public_diary_entries",
                    b2Doc,
                    sbPubRows,
                  );
                  if (needsB2Save) {
                    await b2SaveTableStore(b2Config, mergedDoc).catch(() => {});
                  }
                  return mergedDoc.rows;
                },
              );

              const anonymized = pubMerged
                .filter((r) => r.is_public === true && !r.iv && r.user_id !== user.id)
                .map((r) => sanitizeAnonymousDiaryRow(r));

              return new Response(JSON.stringify(anonymized), {
                status: 200,
                headers: JSON_SECURITY_HEADERS,
              });
            }

            const storeScope = isB2CommunityTable(table) ? B2_COMMUNITY_SCOPE : user.id;
            const sbRows = await fetchUserRowsFromSupabase(request, bearerToken, user.id, table);

            if (!b2Config) {
              if (table === "chat_sessions") {
                const nowMs = Date.now();
                const expiredIds: string[] = [];
                const activeRows = sbRows.filter((r) => {
                  if (isChatSessionExpired(r, nowMs)) {
                    if (typeof r.id === "string") expiredIds.push(r.id);
                    return false;
                  }
                  return true;
                });
                if (expiredIds.length > 0) {
                  void purgeChatSessionsAndMessages(
                    request,
                    bearerToken,
                    user.id,
                    null,
                    expiredIds,
                  );
                }
                return new Response(JSON.stringify(activeRows), {
                  status: 200,
                  headers: JSON_SECURITY_HEADERS,
                });
              }
              return new Response(JSON.stringify(sbRows), {
                status: 200,
                headers: JSON_SECURITY_HEADERS,
              });
            }

            let expiredToPurge: string[] = [];
            let diaryDeletedIds: Record<string, string> = {};
            const mergedRows = await withUserTableLock(storeScope, table, async () => {
              const b2Doc = await b2GetTableStore(b2Config, storeScope, table).catch(() => null);
              const { mergedDoc, needsB2Save, expiredSessionIds } = mergeB2AndSupabaseRows(
                storeScope,
                table,
                b2Doc,
                sbRows,
              );
              expiredToPurge = expiredSessionIds;
              diaryDeletedIds = mergedDoc.deletedIds;
              if (needsB2Save) {
                await b2SaveTableStore(b2Config, mergedDoc).catch(() => {});
              }
              return mergedDoc.rows;
            });

            if (table === "diary_entries") {
              void syncPublicDiaryEntriesToCommunityStore(
                b2Config,
                user.id,
                mergedRows,
                diaryDeletedIds,
              );
            }

            if (table === "chat_sessions" && expiredToPurge.length > 0) {
              void purgeChatSessionsAndMessages(
                request,
                bearerToken,
                user.id,
                b2Config,
                expiredToPurge,
              );
            }

            const safeRows =
              table === "profiles"
                ? mergedRows.map((r) => {
                    const clean = { ...r };
                    delete clean._b2_updated_at;
                    delete clean.user_id;
                    if (clean.id !== user.id) {
                      delete clean.tour_completed;
                    }
                    return clean;
                  })
                : isB2CommunityTable(table)
                  ? mergedRows.map((r) => {
                      const clean = { ...r };
                      delete clean._b2_updated_at;
                      return clean;
                    })
                  : mergedRows
                      .filter((r) => String(r.user_id ?? "") === user.id)
                      .map((r) => {
                        const clean = { ...r };
                        delete clean._b2_updated_at;
                        return clean;
                      });

            return new Response(JSON.stringify(safeRows), {
              status: 200,
              headers: JSON_SECURITY_HEADERS,
            });
          }

          // ==================================================================
          // C. Encrypted Database Table Mutate (Insert / Update / Delete in B2 + Supabase)
          // ==================================================================
          if (action === "db-mutate") {
            const table = url.searchParams.get("table") || "";
            const mutateMethod = (url.searchParams.get("method") || "POST").toUpperCase();
            if (!isB2SyncedTable(table)) {
              return new Response(JSON.stringify({ error: "Unsupported B2 table" }), {
                status: 400,
                headers: JSON_SECURITY_HEADERS,
              });
            }

            const rawBodyText = await request.text();
            if (rawBodyText.length > 5 * 1024 * 1024) {
              return new Response(JSON.stringify({ error: "Payload too large" }), {
                status: 413,
                headers: JSON_SECURITY_HEADERS,
              });
            }
            const parsedBody = rawBodyText ? (JSON.parse(rawBodyText) as unknown) : null;
            const storeScope = isB2CommunityTable(table) ? B2_COMMUNITY_SCOPE : user.id;

            let diaryRowsAfterMutate: Record<string, unknown>[] | null = null;
            let diaryDeletedAfterMutate: Record<string, string> = {};

            const resultRows = await withUserTableLock(storeScope, table, async () => {
              const sbRows = await fetchUserRowsFromSupabase(request, bearerToken, user.id, table);
              const b2Doc = b2Config
                ? await b2GetTableStore(b2Config, storeScope, table).catch(() => null)
                : null;
              const { mergedDoc } = mergeB2AndSupabaseRows(storeScope, table, b2Doc, sbRows);

              const rowsById = new Map<string, Record<string, unknown>>();
              for (const r of mergedDoc.rows) {
                if (typeof r.id === "string") rowsById.set(r.id, r);
              }

              const affectedRows: Record<string, unknown>[] = [];
              const nowIso = new Date().toISOString();

              if (mutateMethod === "POST") {
                const rawList = Array.isArray(parsedBody)
                  ? (parsedBody as Record<string, unknown>[])
                  : parsedBody && typeof parsedBody === "object"
                    ? [parsedBody as Record<string, unknown>]
                    : [];
                const inputList = rawList.slice(0, 500);

                for (const rawItem of inputList) {
                  if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) continue;
                  const item = sanitizeRecord(rawItem);
                  // Deduplicate blog_likes by (post_id, user_id) and comment_votes by (comment_id, user_id)
                  if (table === "blog_likes" && typeof item.post_id === "string") {
                    for (const [existingId, existingRow] of rowsById.entries()) {
                      if (existingRow.post_id === item.post_id && existingRow.user_id === user.id) {
                        rowsById.delete(existingId);
                      }
                    }
                  } else if (table === "comment_votes" && typeof item.comment_id === "string") {
                    for (const [existingId, existingRow] of rowsById.entries()) {
                      if (
                        existingRow.comment_id === item.comment_id &&
                        existingRow.user_id === user.id
                      ) {
                        rowsById.delete(existingId);
                      }
                    }
                  }

                  const rowId =
                    table === "profiles"
                      ? user.id
                      : typeof item.id === "string" && item.id
                        ? item.id
                        : crypto.randomUUID();
                  const existingRow = rowsById.get(rowId);
                  const existingOwnerId =
                    table === "profiles"
                      ? typeof existingRow?.id === "string"
                        ? existingRow.id
                        : ""
                      : typeof existingRow?.user_id === "string"
                        ? existingRow.user_id
                        : "";
                  if (existingRow && existingOwnerId && existingOwnerId !== user.id) {
                    // Prevent cross-user ID collision or overwrite in shared community tables
                    continue;
                  }
                  const normalized: Record<string, unknown> =
                    table === "profiles"
                      ? {
                          ...(existingRow ?? {}),
                          ...item,
                          id: user.id,
                          updated_at: nowIso,
                          _b2_updated_at: nowIso,
                        }
                      : {
                          ...item,
                          id: rowId,
                          user_id: user.id,
                          _b2_updated_at: nowIso,
                        };
                  if (table === "profiles") {
                    delete normalized.user_id;
                  }
                  if (table === "diary_entries") {
                    normalized.visibility = normalized.is_public ? "public_anon" : "private";
                  }
                  delete mergedDoc.deletedIds[rowId];
                  rowsById.set(rowId, normalized);
                  const forSupabase = { ...normalized };
                  delete forSupabase._b2_updated_at;
                  affectedRows.push(forSupabase);
                }

                // Write to Supabase (and ensure parent chat_sessions exist before inserting chat_messages)
                let sbWriteErr: string | null = null;
                try {
                  const userClient = getUserScopedClient(request, bearerToken);
                  if (table === "chat_messages" && affectedRows.length > 0) {
                    const sessionIds = Array.from(
                      new Set(
                        affectedRows
                          .map((r) => (typeof r.session_id === "string" ? r.session_id : ""))
                          .filter(Boolean),
                      ),
                    );
                    if (sessionIds.length > 0) {
                      const sessionPlaceholders = sessionIds.map((sid) => ({
                        id: sid,
                        user_id: user.id,
                        title: "New conversation",
                        last_message_at: nowIso,
                      }));
                      await userClient
                        .from("chat_sessions")
                        .upsert(sessionPlaceholders, { onConflict: "id", ignoreDuplicates: true });
                    }
                  }

                  if (table === "blog_likes") {
                    const { error } = await userClient
                      .from("blog_likes")
                      .insert(affectedRows as never);
                    if (error && !error.message.toLowerCase().includes("duplicate")) {
                      sbWriteErr = error.message;
                    }
                  } else {
                    const { error: upsertErr } = await (
                      userClient.from(table as "notes") as ReturnType<typeof userClient.from>
                    ).upsert(affectedRows as never);
                    if (upsertErr) {
                      const { error: insertErr } = await (
                        userClient.from(table as "notes") as ReturnType<typeof userClient.from>
                      ).insert(affectedRows as never);
                      if (insertErr && !insertErr.message.toLowerCase().includes("duplicate")) {
                        sbWriteErr = insertErr.message;
                      }
                    }
                  }
                } catch (err) {
                  sbWriteErr = err instanceof Error ? err.message : "Supabase write failed";
                }
                if (!b2Config && sbWriteErr) {
                  throw new Error(sbWriteErr);
                }
              } else if (mutateMethod === "PATCH") {
                const patchObj =
                  parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
                    ? sanitizeRecord(parsedBody as Record<string, unknown>)
                    : {};
                const safePatch: Record<string, unknown> = { ...patchObj };
                delete safePatch.user_id;
                delete safePatch.id;
                delete safePatch._b2_updated_at;
                const hasUpdatedAtColumn =
                  table === "diary_entries" ||
                  table === "diary_folders" ||
                  table === "notes" ||
                  table === "note_folders" ||
                  table === "blog_posts" ||
                  table === "blog_comments" ||
                  table === "profiles";
                if (hasUpdatedAtColumn && !safePatch.updated_at) {
                  safePatch.updated_at = nowIso;
                }
                if (table === "diary_entries" && safePatch.is_public !== undefined) {
                  safePatch.visibility = safePatch.is_public ? "public_anon" : "private";
                }
                const matched = filterRowsByQueryParams(
                  Array.from(rowsById.values()),
                  url.searchParams,
                ).filter((r) =>
                  table === "profiles"
                    ? String(r.id ?? "") === user.id
                    : String(r.user_id ?? "") === user.id,
                );

                if (
                  matched.length === 0 &&
                  table === "chat_sessions" &&
                  url.searchParams.get("id")?.startsWith("eq.")
                ) {
                  const targetSessionId = url.searchParams.get("id")!.slice(3);
                  if (targetSessionId) {
                    const synthesized: Record<string, unknown> = {
                      id: targetSessionId,
                      user_id: user.id,
                      title: "New conversation",
                      title_iv: null,
                      created_at: nowIso,
                      last_message_at: nowIso,
                      ...safePatch,
                      _b2_updated_at: nowIso,
                    };
                    delete mergedDoc.deletedIds[targetSessionId];
                    rowsById.set(targetSessionId, synthesized);
                    const cleanRow = { ...synthesized };
                    delete cleanRow._b2_updated_at;
                    affectedRows.push(cleanRow);
                  }
                } else {
                  for (const row of matched) {
                    const rowId = String(row.id);
                    const updated: Record<string, unknown> =
                      table === "profiles"
                        ? {
                            ...row,
                            ...safePatch,
                            id: user.id,
                            _b2_updated_at: nowIso,
                          }
                        : {
                            ...row,
                            ...safePatch,
                            id: rowId,
                            user_id: user.id,
                            _b2_updated_at: nowIso,
                          };
                    if (table === "profiles") {
                      delete updated.user_id;
                    }
                    rowsById.set(rowId, updated);
                    const cleanRow = { ...updated };
                    delete cleanRow._b2_updated_at;
                    affectedRows.push(cleanRow);
                  }
                }

                // Update in Supabase
                try {
                  const userClient = getUserScopedClient(request, bearerToken);
                  if (table === "chat_sessions" && affectedRows.length > 0) {
                    await userClient.from("chat_sessions").upsert(affectedRows as never);
                  } else if (table === "profiles") {
                    for (const row of affectedRows) {
                      await userClient
                        .from("profiles")
                        .update(safePatch as never)
                        .eq("id", String(row.id));
                    }
                  } else {
                    for (const row of affectedRows) {
                      await (
                        userClient.from(table as "notes") as ReturnType<typeof userClient.from>
                      )
                        .update(safePatch as never)
                        .eq("id" as never, String(row.id) as never)
                        .eq("user_id" as never, user.id as never);
                    }
                  }
                } catch {
                  // Ignore Supabase quota errors when B2 is active
                }
              } else if (mutateMethod === "DELETE") {
                const matched = filterRowsByQueryParams(
                  Array.from(rowsById.values()),
                  url.searchParams,
                ).filter((r) =>
                  table === "profiles"
                    ? String(r.id ?? "") === user.id
                    : String(r.user_id ?? "") === user.id,
                );

                for (const row of matched) {
                  const rowId = String(row.id);
                  rowsById.delete(rowId);
                  mergedDoc.deletedIds[rowId] = nowIso;
                  const cleanRow = { ...row };
                  delete cleanRow._b2_updated_at;
                  affectedRows.push(cleanRow);
                }

                // Delete in Supabase (both matched rows and any explicit id filter)
                try {
                  const userClient = getUserScopedClient(request, bearerToken);
                  for (const row of affectedRows) {
                    if (table === "profiles") {
                      await userClient.from("profiles").delete().eq("id", user.id);
                    } else {
                      await (
                        userClient.from(table as "notes") as ReturnType<typeof userClient.from>
                      )
                        .delete()
                        .eq("id" as never, String(row.id) as never)
                        .eq("user_id" as never, user.id as never);
                    }
                  }
                  const eqId = url.searchParams.get("id");
                  if (
                    affectedRows.length === 0 &&
                    eqId?.startsWith("eq.") &&
                    table !== "profiles"
                  ) {
                    await (userClient.from(table as "notes") as ReturnType<typeof userClient.from>)
                      .delete()
                      .eq("id" as never, eqId.slice(3) as never)
                      .eq("user_id" as never, user.id as never);
                  }
                } catch {
                  // Ignore
                }
              }

              mergedDoc.rows = Array.from(rowsById.values());
              mergedDoc.updatedAt = nowIso;

              if (table === "diary_entries") {
                diaryRowsAfterMutate = mergedDoc.rows;
                diaryDeletedAfterMutate = mergedDoc.deletedIds;
              }

              if (b2Config) {
                await b2SaveTableStore(b2Config, mergedDoc);
              }

              return affectedRows;
            });

            if (table === "diary_entries" && b2Config && diaryRowsAfterMutate) {
              await syncPublicDiaryEntriesToCommunityStore(
                b2Config,
                user.id,
                diaryRowsAfterMutate,
                diaryDeletedAfterMutate,
              );
            }

            if (table === "chat_sessions" && mutateMethod === "DELETE" && resultRows.length > 0) {
              const deletedSessionIds = resultRows
                .map((r) => (typeof r.id === "string" ? r.id : ""))
                .filter(Boolean);
              if (deletedSessionIds.length > 0) {
                await purgeChatSessionsAndMessages(
                  request,
                  bearerToken,
                  user.id,
                  b2Config,
                  deletedSessionIds,
                );
              }
            }

            return new Response(JSON.stringify(resultRows), {
              status: mutateMethod === "POST" ? 201 : 200,
              headers: JSON_SECURITY_HEADERS,
            });
          }

          // ==================================================================
          // D. Binary File Storage Operations (Gallery & Media Buckets)
          // ==================================================================
          if (!ALLOWED_BUCKETS.has(bucket)) {
            return new Response(JSON.stringify({ error: "Invalid storage bucket" }), {
              status: 400,
              headers: JSON_SECURITY_HEADERS,
            });
          }

          // 1. Upload Object
          if (action === "upload") {
            if (!path) {
              return new Response(JSON.stringify({ error: "Missing path parameter" }), {
                status: 400,
                headers: JSON_SECURITY_HEADERS,
              });
            }

            if (!isAllowedStoragePath(user, bucket, path, false)) {
              return new Response(
                JSON.stringify({ error: "Forbidden: path not permitted for user" }),
                {
                  status: 403,
                  headers: JSON_SECURITY_HEADERS,
                },
              );
            }

            let fileBuffer: ArrayBuffer;
            let contentType = request.headers.get("content-type") || "application/octet-stream";

            if (contentType.toLowerCase().includes("multipart/form-data")) {
              const fd = await request.formData();
              let foundBlob: Blob | null = null;
              for (const [, val] of fd.entries()) {
                if (val instanceof Blob) {
                  foundBlob = val;
                  if (val.type) contentType = val.type;
                  break;
                }
              }
              if (!foundBlob) {
                return new Response(
                  JSON.stringify({ error: "No file found in multipart upload" }),
                  {
                    status: 400,
                    headers: JSON_SECURITY_HEADERS,
                  },
                );
              }
              fileBuffer = await foundBlob.arrayBuffer();
            } else {
              fileBuffer = await request.arrayBuffer();
            }

            if (fileBuffer.byteLength > 20 * 1024 * 1024) {
              return new Response(JSON.stringify({ error: "Uploaded file exceeds 20 MB limit" }), {
                status: 413,
                headers: JSON_SECURITY_HEADERS,
              });
            }

            const safeUploadPath = normalizeStoragePath(path);
            const safeUploadMime = sanitizeUploadContentType(contentType, bucket, safeUploadPath);

            // Upload to Backblaze B2 when configured
            if (b2Config) {
              await b2PutStorageObject(
                b2Config,
                bucket,
                safeUploadPath,
                fileBuffer,
                safeUploadMime,
              );
              // Best-effort mirror to Supabase Storage in background
              void adminClient.storage
                .from(bucket)
                .upload(safeUploadPath, fileBuffer, { contentType: safeUploadMime, upsert: true })
                .catch(() => {});

              return new Response(
                JSON.stringify({
                  Key: `${bucket}/${safeUploadPath}`,
                  Id: crypto.randomUUID(),
                  fullPath: `${bucket}/${safeUploadPath}`,
                  storage: "b2",
                }),
                {
                  status: 200,
                  headers: JSON_SECURITY_HEADERS,
                },
              );
            }

            const { data, error } = await adminClient.storage
              .from(bucket)
              .upload(safeUploadPath, fileBuffer, {
                contentType: safeUploadMime,
                upsert: true,
              });

            if (error) {
              return new Response(JSON.stringify({ error: "Storage upload failed" }), {
                status: 400,
                headers: JSON_SECURITY_HEADERS,
              });
            }

            return new Response(
              JSON.stringify({
                Key: `${bucket}/${safeUploadPath}`,
                Id: data?.id || crypto.randomUUID(),
                fullPath: data?.fullPath || `${bucket}/${safeUploadPath}`,
              }),
              {
                status: 200,
                headers: JSON_SECURITY_HEADERS,
              },
            );
          }

          // 2. Batch Signed URLs
          if (action === "sign") {
            const body = (await request.json().catch(() => ({}))) as { paths?: string[] };
            const paths = (body.paths ?? [])
              .slice(0, 500)
              .filter((p): p is string => typeof p === "string" && Boolean(p));

            const authorizedPaths = paths
              .map((p) => normalizeStoragePath(p))
              .filter((p) => p && isAllowedStoragePath(user, bucket, p, true));

            if (authorizedPaths.length === 0) {
              return new Response(JSON.stringify([]), {
                status: 200,
                headers: JSON_SECURITY_HEADERS,
              });
            }

            const signedItems = await Promise.all(
              authorizedPaths.map(async (p) => {
                const dlUrl = await createSignedProxyDownloadUrl(request, bucket, p, 60 * 60);
                return {
                  error: null,
                  path: p,
                  signedURL: dlUrl,
                  signedUrl: dlUrl,
                };
              }),
            );
            return new Response(JSON.stringify(signedItems), {
              status: 200,
              headers: JSON_SECURITY_HEADERS,
            });
          }

          // 3. Single Signed URL
          if (action === "sign-single") {
            const body = (await request.json().catch(() => ({}))) as { path?: string };
            const targetPath = body.path || path;
            const normalizedTarget = normalizeStoragePath(targetPath);
            if (!normalizedTarget) {
              return new Response(JSON.stringify({ error: "Missing or invalid path" }), {
                status: 400,
                headers: JSON_SECURITY_HEADERS,
              });
            }

            if (!isAllowedStoragePath(user, bucket, normalizedTarget, true)) {
              return new Response(
                JSON.stringify({ error: "Forbidden: unauthorized access to object" }),
                {
                  status: 403,
                  headers: JSON_SECURITY_HEADERS,
                },
              );
            }

            const dlUrl = await createSignedProxyDownloadUrl(
              request,
              bucket,
              normalizedTarget,
              60 * 60,
            );
            return new Response(JSON.stringify({ signedURL: dlUrl, signedUrl: dlUrl }), {
              status: 200,
              headers: JSON_SECURITY_HEADERS,
            });
          }

          // 4. Batch Remove Objects
          if (action === "remove") {
            const body = (await request.json().catch(() => ({}))) as { prefixes?: string[] };
            const prefixes = (body.prefixes ?? [])
              .slice(0, 500)
              .filter(
                (p): p is string =>
                  typeof p === "string" && isAllowedStoragePath(user, bucket, p, false),
              )
              .map((p) => normalizeStoragePath(p))
              .filter(Boolean);

            if (prefixes.length === 0) {
              return new Response(JSON.stringify([]), {
                status: 200,
                headers: JSON_SECURITY_HEADERS,
              });
            }

            if (b2Config) {
              await b2DeleteStorageObjects(b2Config, bucket, prefixes);
              void adminClient.storage
                .from(bucket)
                .remove(prefixes)
                .catch(() => {});
              return new Response(JSON.stringify(prefixes.map((p) => ({ name: p }))), {
                status: 200,
                headers: JSON_SECURITY_HEADERS,
              });
            }

            const { data, error } = await adminClient.storage.from(bucket).remove(prefixes);
            if (error) {
              return new Response(JSON.stringify({ error: "Storage remove failed" }), {
                status: 400,
                headers: JSON_SECURITY_HEADERS,
              });
            }

            return new Response(JSON.stringify(data ?? []), {
              status: 200,
              headers: JSON_SECURITY_HEADERS,
            });
          }

          return new Response(JSON.stringify({ error: "Unsupported storage action" }), {
            status: 400,
            headers: JSON_SECURITY_HEADERS,
          });
        } catch {
          return new Response(
            JSON.stringify({
              error: "Internal storage error",
            }),
            { status: 500, headers: JSON_SECURITY_HEADERS },
          );
        }
      },
    },
  },
});
