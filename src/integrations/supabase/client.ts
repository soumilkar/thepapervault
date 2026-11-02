import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';
import { brokeredPreviewStorage } from './previewAuthStorage';

type Row = Record<string, unknown>;
type MockUser = {
  id: string;
  email: string;
  user_metadata: { display_name?: string };
};

const STORAGE_SESSION_KEY = 'papervault:mock-auth-user';
const STORAGE_TABLES_PREFIX = 'papervault:mock-table:';

const memoryTables = new Map<string, Row[]>();
const memoryStorage = new Map<string, Blob>();
const authListeners = new Set<(event: string, session: unknown) => void>();

function loadStoredUser(): MockUser | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as MockUser;
  } catch {
    return null;
  }
}

function saveStoredUser(user: MockUser | null) {
  if (typeof window === 'undefined') return;
  try {
    if (user) {
      window.localStorage.setItem(STORAGE_SESSION_KEY, JSON.stringify(user));
    } else {
      window.localStorage.removeItem(STORAGE_SESSION_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

let mockCurrentUser: MockUser | null = null;

function getCurrentMockUser(): MockUser | null {
  if (!mockCurrentUser && typeof window !== 'undefined') {
    mockCurrentUser = loadStoredUser();
  }
  return mockCurrentUser;
}

function getTable(name: string): Row[] {
  if (!memoryTables.has(name)) {
    let initial: Row[] = [];
    if (typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(`${STORAGE_TABLES_PREFIX}${name}`);
        if (raw) initial = JSON.parse(raw) as Row[];
      } catch {
        initial = [];
      }
    }
    memoryTables.set(name, initial);
  }
  return memoryTables.get(name)!;
}

function persistTable(name: string) {
  if (typeof window === 'undefined') return;
  try {
    const rows = memoryTables.get(name) ?? [];
    window.localStorage.setItem(`${STORAGE_TABLES_PREFIX}${name}`, JSON.stringify(rows));
  } catch {
    // ignore storage quota errors
  }
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
      persistTable(table);
      if (singleMode === 'single') {
        return { data: inserted[0] ?? null, error: inserted[0] ? null : new Error('No row inserted'), count: inserted.length };
      }
      if (singleMode === 'maybeSingle') {
        return { data: inserted[0] ?? null, error: null, count: inserted.length };
      }
      return { data: inserted, error: null, count: inserted.length };
    }

    const matched = rows.filter((r) => filters.every((fn) => fn(r)));

    if (op === 'update') {
      const now = new Date().toISOString();
      matched.forEach((r) => {
        Object.assign(r, updatePayload, { updated_at: (updatePayload.updated_at as string) || now });
      });
      persistTable(table);
      if (singleMode === 'single' || singleMode === 'maybeSingle') {
        return { data: matched[0] ?? null, error: null, count: matched.length };
      }
      return { data: matched, error: null, count: matched.length };
    }

    if (op === 'delete') {
      const toRemove = new Set(matched);
      const remaining = rows.filter((r) => !toRemove.has(r));
      memoryTables.set(table, remaining);
      persistTable(table);
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
  const notifyAuth = (event: string) => {
    const user = getCurrentMockUser();
    const session = user
      ? { access_token: `mock-token-${user.id}`, user }
      : null;
    authListeners.forEach((cb) => cb(event, session));
  };

  const ensureProfile = (user: MockUser) => {
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
      persistTable('profiles');
    }
  };

  const mockClient = {
    auth: {
      async getUser() {
        const user = getCurrentMockUser();
        return { data: { user }, error: null };
      },
      async getSession() {
        const user = getCurrentMockUser();
        const session = user
          ? { access_token: `mock-token-${user.id}`, user }
          : null;
        return { data: { session }, error: null };
      },
      async getClaims(token?: string) {
        if (token && token.startsWith('mock-token-')) {
          return { data: { claims: { sub: token.slice('mock-token-'.length) } }, error: null };
        }
        const user = getCurrentMockUser();
        if (user) {
          return { data: { claims: { sub: user.id } }, error: null };
        }
        return { data: null, error: new Error('Invalid token') };
      },
      async signUp({ email, options }: { email: string; password?: string; options?: { data?: { display_name?: string } } }) {
        const id = 'user-' + email.toLowerCase().replace(/[^a-z0-9]/g, '-');
        mockCurrentUser = {
          id,
          email,
          user_metadata: { display_name: options?.data?.display_name || email.split('@')[0] },
        };
        saveStoredUser(mockCurrentUser);
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
        const id = 'user-' + email.toLowerCase().replace(/[^a-z0-9]/g, '-');
        mockCurrentUser = {
          id,
          email,
          user_metadata: { display_name: email.split('@')[0] },
        };
        saveStoredUser(mockCurrentUser);
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
        if (!getCurrentMockUser()) {
          mockCurrentUser = {
            id: 'google-oauth-user',
            email: 'soumil.krm@gmail.com',
            user_metadata: { display_name: 'Soumil' },
          };
          saveStoredUser(mockCurrentUser);
          ensureProfile(mockCurrentUser);
        }
        const user = getCurrentMockUser()!;
        notifyAuth('SIGNED_IN');
        return {
          data: {
            user,
            session: { access_token: tokens?.access_token || `mock-token-${user.id}`, user },
          },
          error: null,
        };
      },
      async signOut() {
        mockCurrentUser = null;
        saveStoredUser(null);
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
  const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SUPABASE_KEY =
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    import.meta.env.VITE_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return createMockSupabaseClient();
  }

  return createClient<Database>(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      storage: brokeredPreviewStorage(),
      persistSession: true,
      autoRefreshToken: true,
    },
  });
}

let _supabase: ReturnType<typeof createSupabaseClient> | undefined;

export const supabase = new Proxy({} as ReturnType<typeof createSupabaseClient>, {
  get(_, prop, receiver) {
    if (!_supabase) _supabase = createSupabaseClient();
    return Reflect.get(_supabase, prop, receiver);
  },
});
