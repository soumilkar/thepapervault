import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { b2GetStorageObject, b2PutStorageObject, type B2Config } from "@/lib/b2-storage";
import {
  BASE_VAULT_LOCKOUT_MS,
  computeVaultLockoutDurationMs,
  INITIAL_MAX_PASSPHRASE_ATTEMPTS,
  type VaultLockoutStatus,
} from "@/lib/vault-lockout";

export type VaultLockoutState = {
  version: 1;
  userId?: string;
  emailHash?: string;
  failedAttempts: number;
  escalationStage: number;
  requireSecurityQuestionsOnSignIn: boolean;
  lockoutCount: number;
  lockedUntil: number;
  lastLockDurationMs: number;
  lastFailedAt: number;
  lastEscalatedAt: number;
  sqSignInVerifiedAt: number;
  lastEmailSentAt: number;
  updatedAt: string;
};

const vaultLockoutMemStore = new Map<string, VaultLockoutState>();

export function createEmptyLockoutState(userId?: string, emailHash?: string): VaultLockoutState {
  return {
    version: 1,
    userId,
    emailHash,
    failedAttempts: 0,
    escalationStage: 0,
    requireSecurityQuestionsOnSignIn: false,
    lockoutCount: 0,
    lockedUntil: 0,
    lastLockDurationMs: 0,
    lastFailedAt: 0,
    lastEscalatedAt: 0,
    sqSignInVerifiedAt: 0,
    lastEmailSentAt: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

function normalizeState(
  raw: unknown,
  userId?: string,
  emailHash?: string,
): VaultLockoutState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    version: 1,
    userId: typeof r.userId === "string" ? r.userId : userId,
    emailHash: typeof r.emailHash === "string" ? r.emailHash : emailHash,
    failedAttempts: Math.max(0, Number(r.failedAttempts) || 0),
    escalationStage: Math.max(0, Number(r.escalationStage) || 0),
    requireSecurityQuestionsOnSignIn: Boolean(r.requireSecurityQuestionsOnSignIn),
    lockoutCount: Math.max(0, Number(r.lockoutCount) || 0),
    lockedUntil: Math.max(0, Number(r.lockedUntil) || 0),
    lastLockDurationMs: Math.max(0, Number(r.lastLockDurationMs) || 0),
    lastFailedAt: Math.max(0, Number(r.lastFailedAt) || 0),
    lastEscalatedAt: Math.max(0, Number(r.lastEscalatedAt) || 0),
    sqSignInVerifiedAt: Math.max(0, Number(r.sqSignInVerifiedAt) || 0),
    lastEmailSentAt: Math.max(0, Number(r.lastEmailSentAt) || 0),
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date(0).toISOString(),
  };
}

function pickFresherState(
  candidates: (VaultLockoutState | null | undefined)[],
  userId?: string,
  emailHash?: string,
): VaultLockoutState {
  let best: VaultLockoutState | null = null;
  let bestTs = -1;
  for (const cand of candidates) {
    if (!cand) continue;
    const ts = Date.parse(cand.updatedAt || "") || 0;
    if (!best || ts > bestTs) {
      best = cand;
      bestTs = ts;
    }
  }
  return best ?? createEmptyLockoutState(userId, emailHash);
}

async function readLockoutBlob(params: {
  objectPath: string;
  b2Config: B2Config | null;
  adminClient: SupabaseClient<Database>;
  userClient?: SupabaseClient<Database> | null;
}): Promise<VaultLockoutState | null> {
  const mem = vaultLockoutMemStore.get(params.objectPath);
  if (mem) return mem;

  if (params.b2Config) {
    try {
      const b2Obj = await b2GetStorageObject(params.b2Config, "media", params.objectPath);
      if (b2Obj) {
        const parsed = normalizeState(JSON.parse(new TextDecoder().decode(b2Obj.buffer)));
        if (parsed) {
          vaultLockoutMemStore.set(params.objectPath, parsed);
          return parsed;
        }
      }
    } catch {
      // fallback
    }
  }

  const clients: SupabaseClient<Database>[] = [params.adminClient];
  if (params.userClient) clients.push(params.userClient);

  for (const client of clients) {
    for (const bucketName of ["media", "gallery"] as const) {
      try {
        const { data: blob, error } = await client.storage
          .from(bucketName)
          .download(params.objectPath);
        if (!error && blob) {
          const parsed = normalizeState(JSON.parse(await blob.text()));
          if (parsed) {
            vaultLockoutMemStore.set(params.objectPath, parsed);
            return parsed;
          }
        }
      } catch {
        // ignore
      }
    }
  }

  return null;
}

async function writeLockoutBlob(params: {
  objectPath: string;
  state: VaultLockoutState;
  b2Config: B2Config | null;
  adminClient: SupabaseClient<Database>;
  userClient?: SupabaseClient<Database> | null;
}): Promise<void> {
  vaultLockoutMemStore.set(params.objectPath, params.state);
  const serialized = JSON.stringify(params.state);
  const bytes = new TextEncoder().encode(serialized);
  const blob = new Blob([bytes], { type: "application/octet-stream" });

  if (params.b2Config) {
    try {
      await b2PutStorageObject(
        params.b2Config,
        "media",
        params.objectPath,
        bytes,
        "application/octet-stream",
      );
    } catch {
      // fallback
    }
  }

  const clients: SupabaseClient<Database>[] = [params.adminClient];
  if (params.userClient) clients.push(params.userClient);

  for (const client of clients) {
    try {
      const { error } = await client.storage.from("media").upload(params.objectPath, blob, {
        contentType: "application/octet-stream",
        upsert: true,
      });
      if (!error) break;
    } catch {
      // ignore
    }
  }
}

export async function readVaultLockoutState(params: {
  userId?: string;
  emailHash?: string;
  userMetadata?: Record<string, unknown>;
  b2Config: B2Config | null;
  adminClient: SupabaseClient<Database>;
  userClient?: SupabaseClient<Database> | null;
}): Promise<VaultLockoutState> {
  const reads: Promise<VaultLockoutState | null>[] = [];
  if (params.userId) {
    reads.push(
      readLockoutBlob({
        objectPath: `_vault_lockout/usr_${params.userId}.json`,
        b2Config: params.b2Config,
        adminClient: params.adminClient,
      }),
      readLockoutBlob({
        objectPath: `${params.userId}/_vault_lockout.json`,
        b2Config: params.b2Config,
        adminClient: params.adminClient,
        userClient: params.userClient,
      }),
    );
  }
  if (params.emailHash) {
    reads.push(
      readLockoutBlob({
        objectPath: `_vault_lockout/em_${params.emailHash}.json`,
        b2Config: params.b2Config,
        adminClient: params.adminClient,
      }),
    );
  }

  const resolved = await Promise.all(reads);

  // Only consider user_metadata if server storage had no record AND metadata shows a restriction
  // (Prevents an attacker from resetting lockout by modifying their own user_metadata)
  const hasServerRecord = resolved.some(Boolean);
  let metaState: VaultLockoutState | null = null;
  if (!hasServerRecord && params.userMetadata?.papervault_vault_lockout) {
    const parsed = normalizeState(
      params.userMetadata.papervault_vault_lockout,
      params.userId,
      params.emailHash,
    );
    if (
      parsed &&
      (parsed.escalationStage > 0 || parsed.lockedUntil > Date.now() || parsed.failedAttempts > 0)
    ) {
      metaState = parsed;
    }
  }

  return pickFresherState([...resolved, metaState], params.userId, params.emailHash);
}

export async function saveVaultLockoutState(params: {
  state: VaultLockoutState;
  userId?: string;
  emailHash?: string;
  b2Config: B2Config | null;
  adminClient: SupabaseClient<Database>;
  userClient?: SupabaseClient<Database> | null;
  updateMetadata?: (patch: Record<string, unknown>) => Promise<void>;
}): Promise<VaultLockoutState> {
  const next: VaultLockoutState = {
    ...params.state,
    version: 1,
    userId: params.userId || params.state.userId,
    emailHash: params.emailHash || params.state.emailHash,
    updatedAt: new Date().toISOString(),
  };

  const writes: Promise<void>[] = [];
  if (next.userId) {
    writes.push(
      writeLockoutBlob({
        objectPath: `_vault_lockout/usr_${next.userId}.json`,
        state: next,
        b2Config: params.b2Config,
        adminClient: params.adminClient,
      }),
      writeLockoutBlob({
        objectPath: `${next.userId}/_vault_lockout.json`,
        state: next,
        b2Config: params.b2Config,
        adminClient: params.adminClient,
        userClient: params.userClient,
      }),
    );
  }
  if (next.emailHash) {
    writes.push(
      writeLockoutBlob({
        objectPath: `_vault_lockout/em_${next.emailHash}.json`,
        state: next,
        b2Config: params.b2Config,
        adminClient: params.adminClient,
      }),
    );
  }
  if (params.updateMetadata) {
    writes.push(params.updateMetadata({ papervault_vault_lockout: next }).catch(() => {}));
  }

  await Promise.allSettled(writes);
  return next;
}

export function toClientLockoutStatus(
  state: VaultLockoutState,
  hasSecurityQuestions: boolean,
  nowMs = Date.now(),
): VaultLockoutStatus {
  const isEscalated = state.escalationStage >= 1;
  const maxAttempts = isEscalated ? 1 : INITIAL_MAX_PASSPHRASE_ATTEMPTS;
  const remainingAttempts = isEscalated
    ? 1
    : Math.max(0, INITIAL_MAX_PASSPHRASE_ATTEMPTS - state.failedAttempts);
  const needsSecurityQuestionsInGate =
    state.requireSecurityQuestionsOnSignIn &&
    hasSecurityQuestions &&
    state.sqSignInVerifiedAt < state.lastEscalatedAt;

  return {
    failedAttempts: state.failedAttempts,
    maxAttemptsBeforeSignOut: maxAttempts,
    remainingAttempts,
    escalationStage: state.escalationStage,
    requireSecurityQuestionsOnSignIn: state.requireSecurityQuestionsOnSignIn,
    needsSecurityQuestionsInGate,
    lockoutCount: state.lockoutCount,
    lockedUntil: state.lockedUntil,
    isLocked: state.lockedUntil > nowMs,
    lastLockDurationMs: state.lastLockDurationMs,
    nextLockDurationMs:
      computeVaultLockoutDurationMs(state.lockoutCount + 1) || BASE_VAULT_LOCKOUT_MS,
    lastEmailSentAt: state.lastEmailSentAt,
  };
}
