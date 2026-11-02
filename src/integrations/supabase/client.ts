import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';
import { brokeredPreviewStorage } from './previewAuthStorage';

type Row = Record<string, unknown>;

const memoryTables = new Map<string, Row[]>();
const memoryStorage = new Map<string, Blob>();
const authListeners = new Set<(event: string, session: unknown) => void>();

let mockCurrentUser: {
  id: string;
  email: string;
  user_metadata: { display_name?: string };
} | null = null;

function getTable(name: string): Row[] {
  if (!memoryTables.has(name)) {
    memoryTables.set(name, []);
  }
  return memoryTables.get(name)!;
}

function createMockQueryBuilder(table: string) {
  let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  let selectOpts: { count?: 'exact'; head?: boolean } | undefined;
  let insertPayload: Row[] = [];
  let updatePayload: Row = {};
  const filters: Array<(r: Row) => boolean> = [];
  const orders: Array<{ col: string; ascending: boolean }> = [];
  let limitCount: number | null = null;
  let singleMode: 'single' | 'maybeSingle' | null = null;

  const execute = async () => {
    const rows = getTable(table);

    if (op === 'insert') {
      const now = new Date().toISOString();
      const inserted = insertPayload.map((item) => {
        const record: Row = {
          id: (item.id as string) || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
          created_at: (item.created_at as string) || now,
          updated_at: (item.updated_at as string) || now,
          ...(table === 'diary_entries' ? { entry_date: (item.entry_date as string) || now.slice(0, 10), is_pinned: false, is_public: false, visibility: 'private', word_count: 0 } : {}),
          ...(table === 'chat_sessions' ? { last_message_at: (item.last_message_at as string) || now, title: (item.title as string) || 'New conversation', title_iv: null } : {}),
          ...(table === 'profiles' ? { tour_completed: Boolean(item.tour_completed) } : {}),
          ...item,
        };
        rows.push(record);
        return record;
      });
      if (singleMode === 'single') {
        return { data: inserted[0] ?? null, error: inserted[0] ? null : new Error('No row inserted'), count: inserted.length };
      }
      if (singleMode === 'maybeSingle') {
        return { data: inserted[0] ?? null, error: null, count: inserted.length };
      }
      return { data: inserted, error: null, count: inserted.length };
    }

    let matched = rows.filter((r) => filters.every((fn) => fn(r)));

    if (op === 'update') {
      const now = new Date().toISOString();
      matched.forEach((r) => {
        Object.assign(r, updatePayload, { updated_at: (updatePayload.updated_at as string) || now });
      });
      if (singleMode === 'single' || singleMode === 'maybeSingle') {
        return { data: matched[0] ?? null, error: null, count: matched.length };
      }
      return { data: matched, error: null, count: matched.length };
    }

    if (op === 'delete') {
      const toRemove = new Set(matched);
      const remaining = rows.filter((r) => !toRemove.has(r));
      memoryTables.set(table, remaining);
      return { data: matched, error: null, count: matched.length };
    }

    // select
    let result = [...matched];
    if (orders.length > 0) {
      result.sort((a, b) => {
        for (const o of orders) {
          const av = a[o.col];
          const bv = b[o.col];
          if (av === bv) continue;
          if (av == null) return o.ascending ? -1 : 1;
          if (bv == null) return o.ascending ? 1 : -1;
          const cmp = String(av).localeCompare(String(bv));
          if (cmp !== 0) return o.ascending ? cmp : -cmp;
        }
        return 0;
      });
    }
    const totalCount = result.length;
    if (limitCount !== null) {
      result = result.slice(0, limitCount);
    }
    if (selectOpts?.head) {
      return { data: null, error: null, count: totalCount };
    }
    if (singleMode === 'single') {
      return {
        data: result[0] ?? null,
        error: result[0] ? null : new Error('Row not found'),
        count: totalCount,
      };
    }
    if (singleMode === 'maybeSingle') {
      return { data: result[0] ?? null, error: null, count: totalCount };
    }
    return { data: result, error: null, count: totalCount };
  };

  const builder = {
    select(_columns?: string, opts?: { count?: 'exact'; head?: boolean }) {
      if (op === 'select') {
        selectOpts = opts;
      }
      return builder;
    },
    insert(values: Row | Row[]) {
      op = 'insert';
      insertPayload = Array.isArray(values) ? values : [values];
      return builder;
    },
    update(values: Row) {
      op = 'update';
      updatePayload = values;
      return builder;
    },
    delete() {
      op = 'delete';
      return builder;
    },
    eq(col: string, val: unknown) {
      filters.push((r) => r[col] === val);
      return builder;
    },
    neq(col: string, val: unknown) {
      filters.push((r) => r[col] !== val);
      return builder;
    },
    in(col: string, vals: unknown[]) {
      filters.push((r) => vals.includes(r[col]));
      return builder;
    },
    gte(col: string, val: unknown) {
      filters.push((r) => r[col] != null && String(r[col]) >= String(val));
      return builder;
    },
    lte(col: string, val: unknown) {
      filters.push((r) => r[col] != null && String(r[col]) <= String(val));
      return builder;
    },
    lt(col: string, val: unknown) {
      filters.push((r) => r[col] != null && String(r[col]) < String(val));
      return builder;
    },
    not(col: string, operator: string, val: unknown) {
      if (operator === 'is') {
        filters.push((r) => r[col] !== val);
      }
      return builder;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      orders.push({ col, ascending: opts?.ascending ?? true });
      return builder;
    },
    limit(n: number) {
      limitCount = n;
      return builder;
    },
    single() {
      singleMode = 'single';
      return builder;
    },
    maybeSingle() {
      singleMode = 'maybeSingle';
      return builder;
    },
    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: { data: any; error: any; count: number | null }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return execute().then(onfulfilled, onrejected);
    },
  };

  return builder;
}

function createMockSupabaseClient(): SupabaseClient<Database> {
  console.warn('[AI Studio] Supabase environment variables not configured — using in-memory mock client');

  const notifyAuth = (event: string) => {
    const session = mockCurrentUser
      ? { access_token: `mock-token-${mockCurrentUser.id}`, user: mockCurrentUser }
      : null;
    authListeners.forEach((cb) => cb(event, session));
  };

  const ensureProfile = (user: { id: string; email: string; user_metadata: { display_name?: string } }) => {
    const profiles = getTable('profiles');
    if (!profiles.some((p) => p.id === user.id)) {
      const now = new Date().toISOString();
      profiles.push({
        id: user.id,
        display_name: user.user_metadata?.display_name || user.email.split('@')[0],
        bio: null,
        tour_completed: false,
        created_at: now,
        updated_at: now,
      });
    }
  };

  const mockClient = {
    auth: {
      async getUser() {
        return { data: { user: mockCurrentUser }, error: null };
      },
      async getSession() {
        const session = mockCurrentUser
          ? { access_token: `mock-token-${mockCurrentUser.id}`, user: mockCurrentUser }
          : null;
        return { data: { session }, error: null };
      },
      async getClaims(token?: string) {
        if (token && token.startsWith('mock-token-')) {
          return { data: { claims: { sub: token.slice('mock-token-'.length) } }, error: null };
        }
        if (mockCurrentUser) {
          return { data: { claims: { sub: mockCurrentUser.id } }, error: null };
        }
        return { data: null, error: new Error('Invalid token') };
      },
      async signUp({ email, options }: { email: string; password?: string; options?: { data?: { display_name?: string } } }) {
        const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'mock-user-1';
        mockCurrentUser = {
          id,
          email,
          user_metadata: { display_name: options?.data?.display_name || email.split('@')[0] },
        };
        ensureProfile(mockCurrentUser);
        notifyAuth('SIGNED_IN');
        return {
          data: {
            user: mockCurrentUser,
            session: { access_token: `mock-token-${mockCurrentUser.id}`, user: mockCurrentUser },
          },
          error: null,
        };
      },
      async signInWithPassword({ email }: { email: string; password?: string }) {
        const id = 'mock-user-' + email.replace(/[^a-zA-Z0-9]/g, '-');
        mockCurrentUser = {
          id,
          email,
          user_metadata: { display_name: email.split('@')[0] },
        };
        ensureProfile(mockCurrentUser);
        notifyAuth('SIGNED_IN');
        return {
          data: {
            user: mockCurrentUser,
            session: { access_token: `mock-token-${mockCurrentUser.id}`, user: mockCurrentUser },
          },
          error: null,
        };
      },
      async setSession(tokens: { access_token?: string; refresh_token?: string }) {
        if (!mockCurrentUser) {
          mockCurrentUser = {
            id: 'mock-oauth-user',
            email: 'writer@papervault.local',
            user_metadata: { display_name: 'Writer' },
          };
          ensureProfile(mockCurrentUser);
        }
        notifyAuth('SIGNED_IN');
        return {
          data: {
            user: mockCurrentUser,
            session: { access_token: tokens?.access_token || `mock-token-${mockCurrentUser.id}`, user: mockCurrentUser },
          },
          error: null,
        };
      },
      async signOut() {
        mockCurrentUser = null;
        notifyAuth('SIGNED_OUT');
        return { error: null };
      },
      onAuthStateChange(callback: (event: string, session: unknown) => void) {
        authListeners.add(callback);
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                authListeners.delete(callback);
              },
            },
          },
        };
      },
    },
    from(table: string) {
      return createMockQueryBuilder(table);
    },
    storage: {
      from(bucket: string) {
        return {
          async upload(path: string, body: Blob) {
            memoryStorage.set(`${bucket}:${path}`, body);
            return { data: { path }, error: null };
          },
          async createSignedUrl(path: string, _expiresIn: number) {
            const blob = memoryStorage.get(`${bucket}:${path}`);
            if (!blob) return { data: null, error: new Error('Not found') };
            const signedUrl = typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(blob) : '';
            return { data: { signedUrl }, error: null };
          },
          async remove(paths: string[]) {
            for (const p of paths) {
              memoryStorage.delete(`${bucket}:${p}`);
            }
            return { data: paths, error: null };
          },
        };
      },
    },
  };

  return mockClient as unknown as SupabaseClient<Database>;
}

function createSupabaseClient(): SupabaseClient<Database> {
  // Use import.meta.env for client-side (Vite build-time replacement)
  // Fall back to process.env for SSR (server-side rendering)
  const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    return createMockSupabaseClient();
  }

  return createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      storage: brokeredPreviewStorage(),
      persistSession: true,
      autoRefreshToken: true,
    },
  });
}

let _supabase: ReturnType<typeof createSupabaseClient> | undefined;

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";
export const supabase = new Proxy({} as ReturnType<typeof createSupabaseClient>, {
  get(_, prop, receiver) {
    if (!_supabase) _supabase = createSupabaseClient();
    return Reflect.get(_supabase, prop, receiver);
  },
});
