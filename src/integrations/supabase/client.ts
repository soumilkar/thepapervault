import {
  createClient,
  type AuthError,
  type Session,
  type SupabaseClient,
} from "@supabase/supabase-js";
import type { Database } from "./types";
import { brokeredPreviewStorage } from "./previewAuthStorage";
import {
  cacheAuthSession,
  getCachedAuthSession,
  getStorageBlobUrl,
  offlineAwareSupabaseFetch,
  registerAuthTokenGetter,
  triggerAutoSync,
} from "@/lib/offline-supabase";

const MISSING_ENV_MESSAGE =
  "Supabase is not configured yet. Please add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (or VITE_SUPABASE_ANON_KEY) in your environment secrets.";

export const EMAIL_AUTH_CALLBACK_STORAGE_KEY = "papervault:email_auth_callback_ts";
export const EMAIL_AUTH_CALLBACK_TYPE_KEY = "papervault:email_auth_callback_type";
export const EMAIL_AUTH_CALLBACK_EVENT = "papervault:email-auth-callback";
const PENDING_EMAIL_INTENT_KEY = "papervault:pending_email_intent";
const CONSUMED_AMR_TS_KEY = "papervault:consumed_amr_ts";

export type EmailCallbackIntent = "password_reset" | "security_panel";

export function setPendingEmailIntent(intent: EmailCallbackIntent): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      PENDING_EMAIL_INTENT_KEY,
      JSON.stringify({ intent, ts: Date.now() }),
    );
    window.sessionStorage.setItem(
      PENDING_EMAIL_INTENT_KEY,
      JSON.stringify({ intent, ts: Date.now() }),
    );
  } catch {
    // ignore
  }
}

function getRecentPendingEmailIntent(): EmailCallbackIntent | null {
  if (typeof window === "undefined") return null;
  try {
    const raw =
      window.sessionStorage.getItem(PENDING_EMAIL_INTENT_KEY) ||
      window.localStorage.getItem(PENDING_EMAIL_INTENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { intent?: EmailCallbackIntent; ts?: number };
    if (parsed?.intent && parsed?.ts && Date.now() - parsed.ts < 20 * 60_000) {
      return parsed.intent;
    }
  } catch {
    // ignore
  }
  return null;
}

function extractJwtAmrCallback(
  accessToken?: string | null,
): { method: "recovery" | "otp"; timestamp: number } | null {
  if (!accessToken) return null;
  try {
    const parts = accessToken.split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as {
      amr?: { method?: string; timestamp?: number }[];
      iat?: number;
    };
    const nowSec = Math.floor(Date.now() / 1000);
    if (Array.isArray(payload.amr)) {
      for (const item of payload.amr) {
        const ts = item.timestamp || payload.iat || 0;
        if (ts > 0 && nowSec - ts <= 240) {
          if (item.method === "recovery") return { method: "recovery", timestamp: ts };
          if (item.method === "otp") return { method: "otp", timestamp: ts };
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export function peekEmailCallbackIntent(session?: Session | null): EmailCallbackIntent | null {
  if (typeof window === "undefined") return null;
  try {
    const search = new URLSearchParams(window.location.search);
    const hash = window.location.hash || "";
    if (search.get("mode") === "reset") return "password_reset";

    const storedTs = Number(window.sessionStorage.getItem(EMAIL_AUTH_CALLBACK_STORAGE_KEY) || "0");
    const storedType = window.sessionStorage.getItem(
      EMAIL_AUTH_CALLBACK_TYPE_KEY,
    ) as EmailCallbackIntent | null;
    if (storedTs > 0 && Date.now() - storedTs < 5 * 60_000 && storedType) {
      return storedType;
    }

    const pendingIntent = getRecentPendingEmailIntent();
    if (hash.includes("type=recovery") || search.get("type") === "recovery") {
      return pendingIntent || "password_reset";
    }
    if (
      hash.includes("type=magiclink") ||
      hash.includes("type=email") ||
      hash.includes("access_token=") ||
      search.has("code") ||
      search.has("token_hash") ||
      search.has("security_nonce") ||
      search.get("security_verified") === "1"
    ) {
      return pendingIntent || "security_panel";
    }

    const activeSession = session ?? (getCachedAuthSession() as Session | null);
    const amr = extractJwtAmrCallback(activeSession?.access_token);
    if (amr) {
      const consumedTs = Number(window.sessionStorage.getItem(CONSUMED_AMR_TS_KEY) || "0");
      if (amr.timestamp > consumedTs) {
        if (pendingIntent) return pendingIntent;
        return amr.method === "recovery" ? "password_reset" : "security_panel";
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export function consumeEmailCallbackIntent(session?: Session | null): EmailCallbackIntent | null {
  if (typeof window === "undefined") return null;
  const intent = peekEmailCallbackIntent(session);
  if (!intent) return null;
  try {
    window.sessionStorage.removeItem(EMAIL_AUTH_CALLBACK_STORAGE_KEY);
    window.sessionStorage.removeItem(EMAIL_AUTH_CALLBACK_TYPE_KEY);
    window.sessionStorage.removeItem(PENDING_EMAIL_INTENT_KEY);
    window.localStorage.removeItem(PENDING_EMAIL_INTENT_KEY);
    const activeSession = session ?? (getCachedAuthSession() as Session | null);
    const amr = extractJwtAmrCallback(activeSession?.access_token);
    if (amr) {
      window.sessionStorage.setItem(CONSUMED_AMR_TS_KEY, String(amr.timestamp));
    } else {
      window.sessionStorage.setItem(CONSUMED_AMR_TS_KEY, String(Math.floor(Date.now() / 1000)));
    }
  } catch {
    // ignore
  }
  return intent;
}

if (typeof window !== "undefined") {
  try {
    window.localStorage.removeItem("papervault:mock-auth-user");
    const initHash = window.location.hash || "";
    const initSearch = window.location.search || "";
    const pendingIntent = getRecentPendingEmailIntent();

    const isRecoveryRedirect =
      initHash.includes("type=recovery") ||
      initSearch.includes("type=recovery") ||
      initSearch.includes("mode=reset");

    const isAuthRedirect =
      isRecoveryRedirect ||
      initHash.includes("access_token=") ||
      initHash.includes("type=magiclink") ||
      initHash.includes("type=email") ||
      initSearch.includes("code=") ||
      initSearch.includes("token_hash=") ||
      initSearch.includes("type=magiclink") ||
      initSearch.includes("security_nonce=") ||
      initSearch.includes("security_verified=1");

    if (isAuthRedirect) {
      const resolvedIntent: EmailCallbackIntent = isRecoveryRedirect
        ? pendingIntent || "password_reset"
        : pendingIntent || "security_panel";
      window.sessionStorage.setItem(EMAIL_AUTH_CALLBACK_STORAGE_KEY, String(Date.now()));
      window.sessionStorage.setItem(EMAIL_AUTH_CALLBACK_TYPE_KEY, resolvedIntent);
    }
  } catch {
    // ignore storage errors
  }
}

function createUnconfiguredQueryBuilder() {
  const result = Promise.resolve({
    data: null,
    error: new Error(MISSING_ENV_MESSAGE),
    count: 0,
  });

  const builder: Record<string, unknown> = {
    select: () => builder,
    insert: () => builder,
    update: () => builder,
    delete: () => builder,
    eq: () => builder,
    neq: () => builder,
    in: () => builder,
    gte: () => builder,
    lte: () => builder,
    lt: () => builder,
    not: () => builder,
    order: () => builder,
    limit: () => builder,
    single: () => builder,
    maybeSingle: () => builder,
    then: result.then.bind(result),
  };

  return builder;
}

function createUnconfiguredSupabaseClient(): SupabaseClient<Database> {
  const client = {
    auth: {
      async getUser() {
        return { data: { user: null }, error: null };
      },
      async getSession() {
        return { data: { session: null }, error: null };
      },
      async getClaims() {
        return { data: null, error: new Error(MISSING_ENV_MESSAGE) };
      },
      async signUp() {
        return { data: { user: null, session: null }, error: new Error(MISSING_ENV_MESSAGE) };
      },
      async signInWithPassword() {
        return { data: { user: null, session: null }, error: new Error(MISSING_ENV_MESSAGE) };
      },
      async signInWithOAuth() {
        return { data: { provider: "google", url: null }, error: new Error(MISSING_ENV_MESSAGE) };
      },
      async signInWithIdToken() {
        return { data: { user: null, session: null }, error: new Error(MISSING_ENV_MESSAGE) };
      },
      async exchangeCodeForSession() {
        return { data: { user: null, session: null }, error: new Error(MISSING_ENV_MESSAGE) };
      },
      async setSession() {
        return { data: { user: null, session: null }, error: new Error(MISSING_ENV_MESSAGE) };
      },
      async signOut() {
        return { error: null };
      },
      onAuthStateChange() {
        return {
          data: {
            subscription: {
              unsubscribe: () => {},
            },
          },
        };
      },
    },
    from() {
      return createUnconfiguredQueryBuilder();
    },
    storage: {
      from() {
        return {
          async upload() {
            return { data: null, error: new Error(MISSING_ENV_MESSAGE) };
          },
          async createSignedUrl() {
            return { data: null, error: new Error(MISSING_ENV_MESSAGE) };
          },
          async remove() {
            return { data: null, error: new Error(MISSING_ENV_MESSAGE) };
          },
        };
      },
    },
  };

  return client as unknown as SupabaseClient<Database>;
}

function createSupabaseClient(): SupabaseClient<Database> {
  const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SUPABASE_KEY =
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    import.meta.env.VITE_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return createUnconfiguredSupabaseClient();
  }

  const client = createClient<Database>(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      storage: brokeredPreviewStorage(),
      persistSession: true,
      autoRefreshToken: true,
    },
    global: {
      fetch: offlineAwareSupabaseFetch,
    },
  });

  if (typeof window !== "undefined") {
    const signedUrlMemCache = new Map<string, { signedUrl: string; expiresAt: number }>();
    const SIGNED_URL_TTL_MS = 45 * 60 * 1000;

    const origGetSession = client.auth.getSession.bind(client.auth);
    client.auth.getSession = async () => {
      // Fast path: if we already have a valid non-expired cached session in memory, return it immediately
      const cached = getCachedAuthSession() as Session | null;
      const nowSec = Math.floor(Date.now() / 1000);
      if (
        cached?.user &&
        cached?.access_token &&
        (!cached.expires_at || cached.expires_at > nowSec + 60)
      ) {
        return { data: { session: cached }, error: null };
      }

      try {
        const res = await origGetSession();
        if (res.data?.session) {
          cacheAuthSession(res.data.session);
          return res;
        }
        // When online, if Supabase has no active session, the user is signed out
        if (typeof navigator !== "undefined" && navigator.onLine) {
          return { data: { session: null }, error: null };
        }
      } catch (err) {
        if (typeof navigator !== "undefined" && navigator.onLine) {
          return { data: { session: null }, error: err as AuthError };
        }
      }

      // ONLY when truly offline (!navigator.onLine), allow the cached offline session
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        if (cached?.user) {
          return { data: { session: cached }, error: null };
        }
      }
      return { data: { session: null }, error: null };
    };

    const origSignOut = client.auth.signOut.bind(client.auth);
    client.auth.signOut = async (options) => {
      cacheAuthSession(null);
      signedUrlMemCache.clear();
      try {
        const res = await origSignOut(options);
        return res;
      } catch {
        return { error: null };
      }
    };

    registerAuthTokenGetter(async (forceRefresh?: boolean) => {
      try {
        if (forceRefresh) {
          const res = await client.auth.refreshSession();
          if (res.data?.session?.access_token) {
            cacheAuthSession(res.data.session);
            return res.data.session.access_token;
          }
        }
        const res = await client.auth.getSession();
        if (res.data?.session?.access_token) {
          cacheAuthSession(res.data.session);
          return res.data.session.access_token;
        }
      } catch {
        // fallback
      }
      return null;
    });

    client.auth.onAuthStateChange((event, session) => {
      if (session) {
        cacheAuthSession(session);
        if (event === "PASSWORD_RECOVERY") {
          const pending = getRecentPendingEmailIntent() || "password_reset";
          try {
            window.sessionStorage.setItem(EMAIL_AUTH_CALLBACK_STORAGE_KEY, String(Date.now()));
            window.sessionStorage.setItem(EMAIL_AUTH_CALLBACK_TYPE_KEY, pending);
          } catch {
            // ignore
          }
          window.dispatchEvent(
            new CustomEvent(EMAIL_AUTH_CALLBACK_EVENT, { detail: { intent: pending } }),
          );
        } else if (event === "SIGNED_IN") {
          const intent = peekEmailCallbackIntent(session);
          if (intent) {
            window.dispatchEvent(
              new CustomEvent(EMAIL_AUTH_CALLBACK_EVENT, { detail: { intent } }),
            );
          }
        }
        if (typeof navigator !== "undefined" && navigator.onLine) {
          triggerAutoSync(200);
        }
      } else if (event === "SIGNED_OUT") {
        cacheAuthSession(null);
        signedUrlMemCache.clear();
      }
    });

    const origStorageFrom = client.storage.from.bind(client.storage);
    client.storage.from = (bucket: string) => {
      const api = origStorageFrom(bucket);
      const origCreateSignedUrl = api.createSignedUrl.bind(api);
      const origCreateSignedUrls = api.createSignedUrls.bind(api);

      const normalizeSignedStorageUrl = (rawUrl: string): string => {
        const proxyIdx = rawUrl.indexOf("/api/storage-proxy?");
        if (proxyIdx !== -1) {
          return rawUrl.slice(proxyIdx);
        }
        return rawUrl;
      };

      api.createSignedUrl = async (path, expiresIn, options) => {
        const isMutable =
          path.endsWith("vault-trackers.bin") || path.endsWith("gallery-folders.bin");
        const cacheKey = `${bucket}/${path}`;
        const now = Date.now();
        if (!isMutable) {
          const hit = signedUrlMemCache.get(cacheKey);
          if (hit && hit.expiresAt > now) {
            return { data: { signedUrl: hit.signedUrl }, error: null };
          }
        }
        if (typeof navigator !== "undefined" && !navigator.onLine) {
          const offlineUrl = await getStorageBlobUrl(bucket, path);
          return { data: { signedUrl: offlineUrl ?? "" }, error: null };
        }
        try {
          const res = await origCreateSignedUrl(path, expiresIn, options);
          if (res.data?.signedUrl) {
            const normalizedUrl = normalizeSignedStorageUrl(res.data.signedUrl);
            if (!isMutable) {
              signedUrlMemCache.set(cacheKey, {
                signedUrl: normalizedUrl,
                expiresAt: now + SIGNED_URL_TTL_MS,
              });
            }
            return { data: { signedUrl: normalizedUrl }, error: null };
          }
        } catch {
          // fallback below
        }
        const fallbackUrl = await getStorageBlobUrl(bucket, path);
        return { data: { signedUrl: fallbackUrl ?? "" }, error: null };
      };

      api.createSignedUrls = async (paths, expiresIn, options) => {
        if (typeof navigator !== "undefined" && !navigator.onLine) {
          const offlineItems = await Promise.all(
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
          return { data: offlineItems, error: null };
        }

        const now = Date.now();
        const uncachedPaths: string[] = [];
        for (const p of paths) {
          const hit = signedUrlMemCache.get(`${bucket}/${p}`);
          if (!hit || hit.expiresAt <= now) {
            uncachedPaths.push(p);
          }
        }

        if (uncachedPaths.length === 0) {
          return {
            data: paths.map((p) => {
              const url = signedUrlMemCache.get(`${bucket}/${p}`)?.signedUrl ?? "";
              return { error: null, path: p, signedURL: url, signedUrl: url };
            }),
            error: null,
          };
        }

        try {
          const res = await origCreateSignedUrls(uncachedPaths, expiresIn, options);
          if (res.data) {
            for (const item of res.data) {
              const rawSigned =
                item.signedUrl || (item as unknown as { signedURL?: string }).signedURL || "";
              const signed = normalizeSignedStorageUrl(rawSigned);
              if (item.path && signed) {
                signedUrlMemCache.set(`${bucket}/${item.path}`, {
                  signedUrl: signed,
                  expiresAt: now + SIGNED_URL_TTL_MS,
                });
              }
            }
            return {
              data: paths.map((p) => {
                const url = signedUrlMemCache.get(`${bucket}/${p}`)?.signedUrl ?? "";
                return { error: null, path: p, signedURL: url, signedUrl: url };
              }),
              error: null,
            };
          }
        } catch {
          // fallback below
        }
        const fallbackItems = await Promise.all(
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
        return { data: fallbackItems, error: null };
      };

      return api;
    };
  }

  return client;
}

let _supabase: ReturnType<typeof createSupabaseClient> | undefined;

export const supabase = new Proxy({} as ReturnType<typeof createSupabaseClient>, {
  get(_, prop, receiver) {
    if (!_supabase) _supabase = createSupabaseClient();
    return Reflect.get(_supabase, prop, receiver);
  },
});
