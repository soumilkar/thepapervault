import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";
import { brokeredPreviewStorage } from "./previewAuthStorage";
import {
  cacheAuthSession,
  getCachedAuthSession,
  offlineAwareSupabaseFetch,
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
    const origGetSession = client.auth.getSession.bind(client.auth);
    client.auth.getSession = async () => {
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
          return { data: { session: null }, error: err as any };
        }
      }

      // ONLY when truly offline (!navigator.onLine), allow the cached offline session
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        const cached = getCachedAuthSession() as Session | null;
        if (cached?.user) {
          return { data: { session: cached }, error: null };
        }
      }
      return { data: { session: null }, error: null };
    };

    const origSignOut = client.auth.signOut.bind(client.auth);
    client.auth.signOut = async (options) => {
      cacheAuthSession(null);
      try {
        const res = await origSignOut(options);
        return res;
      } catch {
        return { error: null };
      }
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
