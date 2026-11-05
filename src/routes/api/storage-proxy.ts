import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type RuntimeRequest = Request & {
  runtime?: {
    cloudflare?: {
      env?: Record<string, unknown>;
    };
  };
};

function readRuntimeEnv(key: string, request?: Request): string {
  const reqEnv = (request as RuntimeRequest | undefined)?.runtime?.cloudflare?.env;
  if (reqEnv && typeof reqEnv[key] === "string" && reqEnv[key]) {
    return (reqEnv[key] as string).trim();
  }
  const globalEnv = (globalThis as { __env__?: Record<string, unknown> }).__env__;
  if (globalEnv && typeof globalEnv[key] === "string" && globalEnv[key]) {
    return (globalEnv[key] as string).trim();
  }
  if (typeof process !== "undefined" && process.env) {
    const val = process.env[key];
    if (typeof val === "string" && val.trim()) {
      return val.trim();
    }
  }
  return "";
}

function getAdminClient(request: Request) {
  const url =
    readRuntimeEnv("SUPABASE_URL", request) ||
    readRuntimeEnv("VITE_SUPABASE_URL", request) ||
    (typeof process !== "undefined"
      ? process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
      : "");

  const serviceKey =
    readRuntimeEnv("SUPABASE_SERVICE_ROLE_KEY", request) ||
    (typeof process !== "undefined" ? process.env.SUPABASE_SERVICE_ROLE_KEY : "") ||
    "";

  if (!url || !serviceKey) {
    throw new Error("Supabase service configuration missing on server");
  }

  return createClient<Database>(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

import type { User } from "@supabase/supabase-js";

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

function normalizeStoragePath(p: string): string {
  const clean = p.replace(/^[/\\]+/, "").trim();
  if (clean.includes("..") || clean.includes("\0")) {
    return "";
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
      if (path.endsWith(".bin")) {
        return path.startsWith(userPrefix);
      }
      return true;
    }
    return path.startsWith(userPrefix);
  }

  return path.startsWith(userPrefix);
}

async function authenticateUser(request: Request, adminClient: ReturnType<typeof getAdminClient>) {
  const authorization =
    request.headers.get("authorization") || request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length).trim();
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

export const Route = createFileRoute("/api/storage-proxy")({
  server: {
    handlers: {
      OPTIONS: async () => {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
          },
        });
      },
      POST: async ({ request }) => {
        try {
          const url = new URL(request.url);
          const action = url.searchParams.get("action") || "upload";
          const bucket = url.searchParams.get("bucket") || "gallery";
          const path = url.searchParams.get("path") || "";

          const adminClient = getAdminClient(request);
          const user = await authenticateUser(request, adminClient);
          if (!user) {
            return new Response(
              JSON.stringify({ error: "Unauthorized: valid session token required" }),
              { status: 401, headers: { "Content-Type": "application/json" } },
            );
          }

          // 1. Upload Object
          if (action === "upload") {
            if (!path) {
              return new Response(JSON.stringify({ error: "Missing path parameter" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
              });
            }

            if (!isAllowedStoragePath(user, bucket, path, false)) {
              return new Response(
                JSON.stringify({ error: "Forbidden: path not permitted for user" }),
                {
                  status: 403,
                  headers: { "Content-Type": "application/json" },
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
                    headers: { "Content-Type": "application/json" },
                  },
                );
              }
              fileBuffer = await foundBlob.arrayBuffer();
            } else {
              fileBuffer = await request.arrayBuffer();
            }

            const safeUploadPath = normalizeStoragePath(path);
            const { data, error } = await adminClient.storage
              .from(bucket)
              .upload(safeUploadPath, fileBuffer, {
                contentType,
                upsert: true,
              });

            if (error) {
              return new Response(JSON.stringify({ error: error.message }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
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
                headers: { "Content-Type": "application/json" },
              },
            );
          }

          // 2. Batch Signed URLs
          if (action === "sign") {
            const body = (await request.json().catch(() => ({}))) as { paths?: string[] };
            const paths = (body.paths ?? []).filter(
              (p): p is string => typeof p === "string" && Boolean(p),
            );

            // Enforce authorization: only allow owner paths (and non-.bin public media)
            const authorizedPaths = paths
              .map((p) => normalizeStoragePath(p))
              .filter((p) => p && isAllowedStoragePath(user, bucket, p, true));

            if (authorizedPaths.length === 0) {
              return new Response(JSON.stringify([]), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }

            const { data, error } = await adminClient.storage
              .from(bucket)
              .createSignedUrls(authorizedPaths, 60 * 60);
            if (error) {
              return new Response(JSON.stringify({ error: error.message }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
              });
            }

            const marker = "/storage/v1";
            const normalized = (data ?? []).map((item) => {
              const raw =
                (item as unknown as { signedURL?: string; signedUrl?: string }).signedURL ||
                (item as unknown as { signedURL?: string; signedUrl?: string }).signedUrl ||
                "";
              const idx = raw.indexOf(marker);
              const rel = idx !== -1 ? raw.slice(idx + marker.length) : raw;
              return {
                ...item,
                signedURL: rel,
                signedUrl: raw,
              };
            });

            return new Response(JSON.stringify(normalized), {
              status: 200,
              headers: { "Content-Type": "application/json" },
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
                headers: { "Content-Type": "application/json" },
              });
            }

            if (!isAllowedStoragePath(user, bucket, normalizedTarget, true)) {
              return new Response(
                JSON.stringify({ error: "Forbidden: unauthorized access to object" }),
                {
                  status: 403,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }

            const { data, error } = await adminClient.storage
              .from(bucket)
              .createSignedUrl(normalizedTarget, 60 * 60);

            if (error) {
              return new Response(JSON.stringify({ error: error.message }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
              });
            }

            const rawSignedUrl = data?.signedUrl ?? "";
            const marker = "/storage/v1";
            const idx = rawSignedUrl.indexOf(marker);
            const relativeSignedURL =
              idx !== -1 ? rawSignedUrl.slice(idx + marker.length) : rawSignedUrl;

            return new Response(
              JSON.stringify({ signedURL: relativeSignedURL, signedUrl: rawSignedUrl }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          }

          // 4. Batch Remove Objects
          if (action === "remove") {
            const body = (await request.json().catch(() => ({}))) as { prefixes?: string[] };
            const prefixes = (body.prefixes ?? [])
              .filter(
                (p): p is string =>
                  typeof p === "string" && isAllowedStoragePath(user, bucket, p, false),
              )
              .map((p) => normalizeStoragePath(p))
              .filter(Boolean);

            if (prefixes.length === 0) {
              return new Response(JSON.stringify([]), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }

            const { data, error } = await adminClient.storage.from(bucket).remove(prefixes);
            if (error) {
              return new Response(JSON.stringify({ error: error.message }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
              });
            }

            return new Response(JSON.stringify(data ?? []), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }

          return new Response(JSON.stringify({ error: `Unsupported action: ${action}` }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          console.error("Storage proxy error:", err);
          return new Response(
            JSON.stringify({
              error: err instanceof Error ? err.message : "Internal storage error",
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      },
    },
  },
});
