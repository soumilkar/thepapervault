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

if (typeof window !== "undefined") {
  try {
    window.localStorage.removeItem("papervault:mock-auth-user");
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
