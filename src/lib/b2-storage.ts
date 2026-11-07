// Server-side Backblaze B2 S3-compatible storage & encrypted table persistence engine.
// Uses pure Web Crypto (HMAC-SHA256 / AWS Signature V4) with zero external SDK bloat.
// All private user data (Diary, Notes, Companion chats, Gallery photos) is already
// client-side AES-256-GCM encrypted with the user's Vault key before reaching this layer.

type RuntimeRequest = Request & {
  runtime?: {
    cloudflare?: {
      env?: Record<string, unknown>;
    };
  };
};

export interface B2Config {
  bucket: string;
  endpointHost: string;
  region: string;
  keyId: string;
  applicationKey: string;
}

export interface B2TableStoreDocument {
  version: 1;
  userId: string;
  table: string;
  updatedAt: string;
  rows: Record<string, unknown>[];
  deletedIds: Record<string, string>; // id -> ISO timestamp when deleted
}

export const B2_SYNCED_TABLES = [
  "diary_entries",
  "diary_folders",
  "notes",
  "note_folders",
  "gallery_images",
  "chat_sessions",
  "chat_messages",
  "blog_posts",
  "blog_comments",
  "blog_likes",
  "comment_votes",
] as const;

export type B2SyncedTable = (typeof B2_SYNCED_TABLES)[number];

export const B2_COMMUNITY_TABLES = new Set<string>([
  "blog_posts",
  "blog_comments",
  "blog_likes",
  "comment_votes",
]);

export const B2_COMMUNITY_SCOPE = "_community";

export function isB2SyncedTable(table: string): table is B2SyncedTable {
  return (B2_SYNCED_TABLES as readonly string[]).includes(table);
}

export function isB2CommunityTable(table: string): boolean {
  return B2_COMMUNITY_TABLES.has(table);
}

function cleanEnvValue(raw: string): string {
  return raw
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim();
}

export function readServerEnv(key: string, request?: Request): string {
  const reqEnv = (request as RuntimeRequest | undefined)?.runtime?.cloudflare?.env;
  if (reqEnv && typeof reqEnv[key] === "string" && reqEnv[key]) {
    return cleanEnvValue(reqEnv[key] as string);
  }
  const globalEnv = (globalThis as { __env__?: Record<string, unknown> }).__env__;
  if (globalEnv && typeof globalEnv[key] === "string" && globalEnv[key]) {
    return cleanEnvValue(globalEnv[key] as string);
  }
  if (typeof process !== "undefined" && process.env) {
    const val = process.env[key];
    if (typeof val === "string" && val.trim()) {
      return cleanEnvValue(val);
    }
  }
  return "";
}

function normalizeEndpointHost(rawEndpoint: string): string {
  if (!rawEndpoint) return "";
  let cleaned = cleanEnvValue(rawEndpoint);
  cleaned = cleaned.replace(/^https?:\/\//i, "");
  const slashIdx = cleaned.indexOf("/");
  if (slashIdx !== -1) {
    cleaned = cleaned.slice(0, slashIdx);
  }
  return cleaned.toLowerCase().trim();
}

function extractRegionFromEndpoint(endpointHost: string): string {
  // Backblaze B2 endpoints look like: s3.us-west-004.backblazeb2.com or s3.eu-central-003.backblazeb2.com
  const match = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/i.exec(endpointHost);
  if (match?.[1]) return match[1];
  return "us-east-1";
}

let cachedAutoEndpoint: { keyId: string; endpointHost: string; expiresAt: number } | null = null;

async function discoverB2EndpointFromNativeApi(
  keyId: string,
  applicationKey: string,
): Promise<string> {
  const now = Date.now();
  if (
    cachedAutoEndpoint &&
    cachedAutoEndpoint.keyId === keyId &&
    cachedAutoEndpoint.expiresAt > now
  ) {
    return cachedAutoEndpoint.endpointHost;
  }

  try {
    const credentials = btoa(`${keyId}:${applicationKey}`);
    const res = await fetch("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
      method: "GET",
      headers: {
        Authorization: `Basic ${credentials}`,
      },
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { s3ApiUrl?: string };
    if (data?.s3ApiUrl) {
      const host = normalizeEndpointHost(data.s3ApiUrl);
      if (host) {
        cachedAutoEndpoint = {
          keyId,
          endpointHost: host,
          expiresAt: now + 60 * 60 * 1000,
        };
        return host;
      }
    }
  } catch {
    // ignore discovery error
  }
  return "";
}

export async function resolveB2Config(request?: Request): Promise<B2Config | null> {
  const bucket =
    readServerEnv("B2_BUCKET_NAME", request) ||
    readServerEnv("BACKBLAZE_BUCKET_NAME", request) ||
    readServerEnv("VITE_B2_BUCKET_NAME", request) ||
    readServerEnv("R2_BUCKET_NAME", request);

  const keyId =
    readServerEnv("B2_KEY_ID", request) ||
    readServerEnv("B2_ACCESS_KEY_ID", request) ||
    readServerEnv("BACKBLAZE_KEY_ID", request) ||
    readServerEnv("VITE_B2_KEY_ID", request) ||
    readServerEnv("R2_ACCESS_KEY_ID", request);

  const applicationKey =
    readServerEnv("B2_APPLICATION_KEY", request) ||
    readServerEnv("B2_SECRET_ACCESS_KEY", request) ||
    readServerEnv("BACKBLAZE_APPLICATION_KEY", request) ||
    readServerEnv("VITE_B2_APPLICATION_KEY", request) ||
    readServerEnv("R2_SECRET_ACCESS_KEY", request);

  if (!bucket || !keyId || !applicationKey) {
    return null;
  }

  let rawEndpoint =
    readServerEnv("B2_ENDPOINT", request) ||
    readServerEnv("BACKBLAZE_ENDPOINT", request) ||
    readServerEnv("VITE_B2_ENDPOINT", request);

  if (!rawEndpoint) {
    const r2AccountId = readServerEnv("R2_ACCOUNT_ID", request);
    if (r2AccountId) {
      rawEndpoint = `${r2AccountId}.r2.cloudflarestorage.com`;
    }
  }

  let endpointHost = normalizeEndpointHost(rawEndpoint);
  if (!endpointHost) {
    endpointHost = await discoverB2EndpointFromNativeApi(keyId, applicationKey);
  }
  if (!endpointHost) {
    return null;
  }

  const region = extractRegionFromEndpoint(endpointHost);
  return {
    bucket,
    endpointHost,
    region,
    keyId,
    applicationKey,
  };
}

const enc = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

async function sha256Hex(data: BufferSource | string): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(hash);
}

async function hmacSha256(keyData: BufferSource | string, message: string): Promise<ArrayBuffer> {
  const rawKey = typeof keyData === "string" ? enc.encode(keyData) : keyData;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
}

function rfc3986Encode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function buildCanonicalUri(bucket: string, objectKey: string): string {
  const cleanKey = objectKey.replace(/^\/+/, "");
  const segments = [bucket, ...cleanKey.split("/").filter(Boolean)];
  return "/" + segments.map(rfc3986Encode).join("/");
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

async function b2SignedFetch(
  config: B2Config,
  method: "GET" | "PUT" | "HEAD" | "DELETE",
  objectKey: string,
  body?: ArrayBuffer | Uint8Array | string | null,
  contentType?: string,
): Promise<Response> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  let bodyBytes: Uint8Array | null = null;
  let payloadHash = EMPTY_SHA256;

  if (body !== undefined && body !== null) {
    if (typeof body === "string") {
      bodyBytes = enc.encode(body);
    } else if (body instanceof Uint8Array) {
      bodyBytes = body;
    } else {
      bodyBytes = new Uint8Array(body);
    }
    payloadHash = await sha256Hex(bodyBytes);
  }

  const canonicalUri = buildCanonicalUri(config.bucket, objectKey);
  const canonicalQueryString = "";
  const canonicalHeaders =
    `host:${config.endpointHost}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmacSha256(`AWS4${config.applicationKey}`, dateStamp);
  const kRegion = await hmacSha256(kDate, config.region);
  const kService = await hmacSha256(kRegion, "s3");
  const kSigning = await hmacSha256(kService, "aws4_request");
  const signature = toHex(await hmacSha256(kSigning, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${config.keyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: Record<string, string> = {
    Authorization: authorization,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentType) {
    headers["Content-Type"] = contentType;
  }

  const targetUrl = `https://${config.endpointHost}${canonicalUri}`;
  return fetch(targetUrl, {
    method,
    headers,
    body: bodyBytes ? (bodyBytes as unknown as BodyInit) : undefined,
  });
}

// ============================================================================
// 1. Binary Storage Object Helpers (Photos / Media / Encrypted Trackers)
// ============================================================================

export function buildB2StorageKey(bucket: string, path: string): string {
  const cleanPath = path.replace(/^\/+/, "");
  return `storage/${bucket}/${cleanPath}`;
}

export async function b2PutStorageObject(
  config: B2Config,
  bucket: string,
  path: string,
  buffer: ArrayBuffer | Uint8Array,
  contentType = "application/octet-stream",
): Promise<void> {
  const objectKey = buildB2StorageKey(bucket, path);
  const res = await b2SignedFetch(config, "PUT", objectKey, buffer, contentType);
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Backblaze B2 upload failed (${res.status}): ${errText.slice(0, 200)}`);
  }
}

export async function b2GetStorageObject(
  config: B2Config,
  bucket: string,
  path: string,
): Promise<{ buffer: ArrayBuffer; contentType: string } | null> {
  const objectKey = buildB2StorageKey(bucket, path);
  const res = await b2SignedFetch(config, "GET", objectKey);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Backblaze B2 download failed (${res.status})`);
  }
  const buffer = await res.arrayBuffer();
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  return { buffer, contentType };
}

export async function b2HeadStorageObject(
  config: B2Config,
  bucket: string,
  path: string,
): Promise<boolean> {
  const objectKey = buildB2StorageKey(bucket, path);
  const res = await b2SignedFetch(config, "HEAD", objectKey);
  return res.ok;
}

export async function b2DeleteStorageObjects(
  config: B2Config,
  bucket: string,
  paths: string[],
): Promise<void> {
  await Promise.all(
    paths.map(async (p) => {
      const objectKey = buildB2StorageKey(bucket, p);
      try {
        await b2SignedFetch(config, "DELETE", objectKey);
      } catch {
        // ignore individual delete errors
      }
    }),
  );
}

// ============================================================================
// 2. Signed Proxy Download URLs (Zero CORS issues, Zero User IP exposure)
// ============================================================================

const runtimeFallbackSecret = toHex(crypto.getRandomValues(new Uint8Array(32)).buffer);

function getProxySigningSecret(request?: Request): string {
  return (
    readServerEnv("B2_APPLICATION_KEY", request) ||
    readServerEnv("SUPABASE_SERVICE_ROLE_KEY", request) ||
    readServerEnv("GROQ_API_KEY", request) ||
    runtimeFallbackSecret
  );
}

export async function createSignedProxyDownloadUrl(
  request: Request,
  bucket: string,
  path: string,
  expiresInSec = 3600,
): Promise<string> {
  const safeTtl = Math.min(Math.max(60, expiresInSec), 7200);
  const exp = Math.floor(Date.now() / 1000) + safeTtl;
  const secret = getProxySigningSecret(request);
  const payload = `${bucket}:${path}:${exp}`;
  const sig = toHex(await hmacSha256(secret, payload));
  return `/api/storage-proxy?action=download&bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}&exp=${exp}&sig=${sig}`;
}

export async function verifySignedProxyDownloadUrl(
  request: Request,
  bucket: string,
  path: string,
  expStr: string,
  sig: string,
): Promise<boolean> {
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = parseInt(expStr, 10);
  if (Number.isNaN(exp) || exp < nowSec || exp > nowSec + 7200) {
    return false;
  }
  const secret = getProxySigningSecret(request);
  const payload = `${bucket}:${path}:${exp}`;
  const expectedSig = toHex(await hmacSha256(secret, payload));
  if (expectedSig.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedSig.length; i++) {
    diff |= expectedSig.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

// ============================================================================
// 3. Encrypted Table Rows Persistence in Backblaze B2 (Diary, Notes, Chats, Gallery)
// ============================================================================

const inMemoryTableLocks = new Map<string, Promise<unknown>>();

export function withUserTableLock<T>(
  userId: string,
  table: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${userId}:${table}`;
  const prev = inMemoryTableLocks.get(key) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => fn())
    .finally(() => {
      if (inMemoryTableLocks.get(key) === next) {
        inMemoryTableLocks.delete(key);
      }
    });
  inMemoryTableLocks.set(key, next);
  return next;
}

export function buildB2TableKey(userId: string, table: string): string {
  return `db/${userId}/${table}.json`;
}

export async function b2GetTableStore(
  config: B2Config,
  userId: string,
  table: string,
): Promise<B2TableStoreDocument | null> {
  const objectKey = buildB2TableKey(userId, table);
  const res = await b2SignedFetch(config, "GET", objectKey);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Backblaze B2 table read failed (${res.status})`);
  }
  try {
    const parsed = (await res.json()) as B2TableStoreDocument;
    if (parsed && Array.isArray(parsed.rows)) {
      return {
        version: 1,
        userId,
        table,
        updatedAt: parsed.updatedAt || new Date().toISOString(),
        rows: parsed.rows,
        deletedIds:
          parsed.deletedIds && typeof parsed.deletedIds === "object" ? parsed.deletedIds : {},
      };
    }
  } catch {
    // malformed JSON
  }
  return null;
}

export async function b2SaveTableStore(config: B2Config, doc: B2TableStoreDocument): Promise<void> {
  const objectKey = buildB2TableKey(doc.userId, doc.table);
  const body = JSON.stringify({
    ...doc,
    version: 1,
    updatedAt: new Date().toISOString(),
  });
  const res = await b2SignedFetch(config, "PUT", objectKey, body, "application/json");
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Backblaze B2 table write failed (${res.status}): ${errText.slice(0, 200)}`);
  }
}

export const CHAT_INACTIVITY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 1 month (30 days)

export function isChatSessionExpired(row: Record<string, unknown>, nowMs = Date.now()): boolean {
  const ts = (row.last_message_at || row.updated_at || row.created_at) as string | undefined;
  if (!ts) return false;
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return false;
  return nowMs - parsed > CHAT_INACTIVITY_TTL_MS;
}

function getRowTimestamp(row: Record<string, unknown>): number {
  const ts = (row.updated_at || row.last_message_at || row.created_at) as string | undefined;
  if (!ts) return 0;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Merges rows from Backblaze B2/R2 and Supabase so zero existing entries are ever lost,
 * while respecting explicit deletions recorded in B2's deletedIds map and automatically
 * expiring AI Companion chat threads that have been inactive for 1 month (30 days).
 */
export function mergeB2AndSupabaseRows(
  userId: string,
  table: string,
  b2Doc: B2TableStoreDocument | null,
  supabaseRows: Record<string, unknown>[],
): { mergedDoc: B2TableStoreDocument; needsB2Save: boolean; expiredSessionIds: string[] } {
  const deletedIds: Record<string, string> = { ...(b2Doc?.deletedIds ?? {}) };
  const byId = new Map<string, Record<string, unknown>>();
  const expiredSessionIds: string[] = [];
  let needsB2Save = !b2Doc;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  for (const row of b2Doc?.rows ?? []) {
    const id = typeof row.id === "string" ? row.id : "";
    if (!id || deletedIds[id]) continue;
    if (table === "chat_sessions" && isChatSessionExpired(row, nowMs)) {
      deletedIds[id] = nowIso;
      expiredSessionIds.push(id);
      needsB2Save = true;
      continue;
    }
    byId.set(id, row);
  }

  for (const sbRow of supabaseRows) {
    const id = typeof sbRow.id === "string" ? sbRow.id : "";
    if (!id) continue;
    if (deletedIds[id]) {
      continue;
    }
    if (table === "chat_sessions" && isChatSessionExpired(sbRow, nowMs)) {
      deletedIds[id] = nowIso;
      expiredSessionIds.push(id);
      needsB2Save = true;
      continue;
    }
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, sbRow);
      needsB2Save = true;
    } else {
      const sbTime = getRowTimestamp(sbRow);
      const b2Time = getRowTimestamp(existing);
      if (sbTime > b2Time) {
        const mergedRow = { ...existing, ...sbRow };
        if (table === "chat_sessions" && isChatSessionExpired(mergedRow, nowMs)) {
          byId.delete(id);
          deletedIds[id] = nowIso;
          expiredSessionIds.push(id);
          needsB2Save = true;
        } else {
          byId.set(id, mergedRow);
          needsB2Save = true;
        }
      }
    }
  }

  return {
    mergedDoc: {
      version: 1,
      userId,
      table,
      updatedAt: nowIso,
      rows: Array.from(byId.values()),
      deletedIds,
    },
    needsB2Save,
    expiredSessionIds: Array.from(new Set(expiredSessionIds)),
  };
}
