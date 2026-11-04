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
    (typeof process !== "undefined" ? process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL : "") ||
    "https://lffxkhqwyvgpqkkqhznm.supabase.co";

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

async function authenticateUser(request: Request, adminClient: ReturnType<typeof getAdminClient>) {
  const authorization = request.headers.get("authorization") || request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) return null;

  try {
    const { data, error } = await adminClient.auth.getUser(token);
    if (error || !data?.user?.id) {
      return null;
    }
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

            // Path must begin with user.id/ for security
            if (!path.startsWith(`${user.id}/`)) {
              return new Response(JSON.stringify({ error: "Path does not match user ID" }), {
                status: 403,
                headers: { "Content-Type": "application/json" },
              });
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
                return new Response(JSON.stringify({ error: "No file found in multipart upload" }), {
                  status: 400,
                  headers: { "Content-Type": "application/json" },
                });
              }
              fileBuffer = await foundBlob.arrayBuffer();
            } else {
              fileBuffer = await request.arrayBuffer();
            }

            const { data, error } = await adminClient.storage
              .from(bucket)
              .upload(path, fileBuffer, {
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
                Key: `${bucket}/${path}`,
                Id: data?.id || crypto.randomUUID(),
                fullPath: data?.fullPath || `${bucket}/${path}`,
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
            const paths = (body.paths ?? []).filter((p): p is string => typeof p === "string" && Boolean(p));

            if (paths.length === 0) {
              return new Response(JSON.stringify([]), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }

            const { data, error } = await adminClient.storage.from(bucket).createSignedUrls(paths, 60 * 60);
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

          // 3. Single Signed URL
          if (action === "sign-single") {
            const body = (await request.json().catch(() => ({}))) as { path?: string };
            const targetPath = body.path || path;
            if (!targetPath) {
              return new Response(JSON.stringify({ error: "Missing path" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
              });
            }

            const { data, error } = await adminClient.storage
              .from(bucket)
              .createSignedUrl(targetPath, 60 * 60);

            if (error) {
              return new Response(JSON.stringify({ error: error.message }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
              });
            }

            return new Response(JSON.stringify({ signedURL: data?.signedUrl, signedUrl: data?.signedUrl }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }

          // 4. Batch Remove Objects
          if (action === "remove") {
            const body = (await request.json().catch(() => ({}))) as { prefixes?: string[] };
            const prefixes = (body.prefixes ?? []).filter(
              (p): p is string => typeof p === "string" && p.startsWith(`${user.id}/`),
            );

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
