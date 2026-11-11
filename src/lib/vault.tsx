import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  clearCryptoCache,
  decryptText,
  deriveDataKey,
  deriveVerifier,
  encryptText,
  randomBytes,
  timingSafeEqualStr,
  toB64,
} from "@/lib/crypto";
import {
  clearAllOfflineUserData,
  clearOfflineBlobUrls,
  getFreshAccessToken,
} from "@/lib/offline-supabase";
import {
  createRecoveryEnvelope,
  fetchRemoteVaultMeta,
  generateRecoveryKey,
  reencryptUserVaultData,
  type RecoveryEnvelope,
  unwrapRecoveryEnvelope,
  type VaultMetaRecord,
  wipeAndResetUserVault,
  writeRemoteVaultMeta,
} from "@/lib/vault-rekey";

type VaultStatus = "loading" | "needs_setup" | "locked" | "unlocked";

export const MAX_PASSPHRASE_ATTEMPTS = 5;
const PASSPHRASE_LOCKOUT_KEY_PREFIX = "papervault:passphrase_lockout:";

export function getLockoutDurationMs(tier: number): number {
  const HOUR = 60 * 60 * 1000;
  const t = Math.max(1, Math.floor(tier));
  switch (t) {
    case 1:
      return 1 * HOUR; // 1 hour
    case 2:
      return 2 * HOUR; // 2 hours
    case 3:
      return 4 * HOUR; // 4 hours
    case 4:
      return 8 * HOUR; // 8 hours
    case 5:
      return 24 * HOUR; // 24 hours (1 day)
    case 6:
      return 48 * HOUR; // 48 hours (2 days)
    default:
      return Math.min(7 * 24 * HOUR, (t - 4) * 24 * HOUR); // 72h, 96h... up to 7 days
  }
}

export function formatDurationLabel(ms: number): string {
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours < 24) {
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

export function formatLockoutRemaining(remainingMs: number): string {
  const totalSec = Math.max(1, Math.ceil(remainingMs / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (days > 0) {
    return `${days}d ${hours}h ${mins}m`;
  }
  if (hours > 0) {
    return `${hours}h ${mins}m ${secs.toString().padStart(2, "0")}s`;
  }
  if (mins <= 0) return `${secs}s`;
  return `${mins}m ${secs.toString().padStart(2, "0")}s`;
}

type LocalLockoutRecord = {
  failures: number;
  lockedUntil: number;
  windowResetAt: number;
  tier?: number;
  userId?: string;
  email?: string;
};

function readLockoutSlot(storageKey: string): LocalLockoutRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalLockoutRecord>;
    if (!parsed || typeof parsed !== "object") return null;
    const now = Date.now();
    const lockedUntil = Number(parsed.lockedUntil) || 0;
    const windowResetAt = Number(parsed.windowResetAt) || 0;
    const failures = Number(parsed.failures) || 0;
    const tier = Number(parsed.tier) || 0;
    if (lockedUntil > 0 && lockedUntil <= now && windowResetAt <= now) {
      window.localStorage.removeItem(storageKey);
      return null;
    }
    if (lockedUntil === 0 && windowResetAt > 0 && windowResetAt <= now) {
      window.localStorage.removeItem(storageKey);
      return null;
    }
    return {
      failures,
      lockedUntil,
      windowResetAt: windowResetAt || lockedUntil,
      tier,
      userId: typeof parsed.userId === "string" ? parsed.userId : undefined,
      email: typeof parsed.email === "string" ? parsed.email : undefined,
    };
  } catch {
    return null;
  }
}

function writeLockoutSlot(storageKey: string, record: LocalLockoutRecord): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(record));
  } catch {
    // ignore storage errors
  }
}

export function getPassphraseLockoutStatus(
  userId?: string,
  email?: string,
): {
  locked: boolean;
  lockedUntil: number;
  remainingMs: number;
  failures: number;
  attemptsRemaining: number;
  tier: number;
  nextLockoutDurationMs: number;
} {
  const now = Date.now();
  const cleanEmail = email?.trim().toLowerCase() || "";
  const globalRec = readLockoutSlot(`${PASSPHRASE_LOCKOUT_KEY_PREFIX}global`);
  const userRec = userId ? readLockoutSlot(`${PASSPHRASE_LOCKOUT_KEY_PREFIX}usr:${userId}`) : null;
  const emailRec = cleanEmail ? readLockoutSlot(`${PASSPHSE_EMAIL_PREFIX(cleanEmail)}`) : null;

  const lockedUntil = Math.max(
    globalRec?.lockedUntil || 0,
    userRec?.lockedUntil || 0,
    emailRec?.lockedUntil || 0,
  );
  const tier = Math.max(userRec?.tier || 0, emailRec?.tier || 0, globalRec?.tier || 0);
  const failures = Math.max(
    userRec?.failures || 0,
    emailRec?.failures || 0,
    globalRec?.failures || 0,
  );
  const locked = lockedUntil > now;
  const remainingMs = locked ? lockedUntil - now : 0;
  const maxAttempts = tier > 0 ? 3 : MAX_PASSPHRASE_ATTEMPTS;
  const nextTier = tier + 1;
  const nextLockoutDurationMs = getLockoutDurationMs(nextTier);

  return {
    locked,
    lockedUntil: locked ? lockedUntil : 0,
    remainingMs,
    failures: locked ? maxAttempts : failures,
    attemptsRemaining: locked ? 0 : Math.max(0, maxAttempts - failures),
    tier,
    nextLockoutDurationMs,
  };
}

function PASSPHSE_EMAIL_PREFIX(cleanEmail: string): string {
  return `${PASSPHRASE_LOCKOUT_KEY_PREFIX}em:${cleanEmail}`;
}

export function setLocalPassphraseLockout(
  lockedUntil: number,
  userId?: string,
  email?: string,
  failures?: number,
  tier?: number,
): void {
  const cleanEmail = email?.trim().toLowerCase() || "";
  const existingStatus = getPassphraseLockoutStatus(userId, cleanEmail);
  const resolvedTier = typeof tier === "number" ? tier : existingStatus.tier;
  const resolvedFailures = typeof failures === "number" ? failures : existingStatus.failures;
  const record: LocalLockoutRecord = {
    failures: resolvedFailures,
    lockedUntil,
    windowResetAt: Math.max(lockedUntil, Date.now() + 7 * 24 * 60 * 60 * 1000),
    tier: resolvedTier,
    userId,
    email: cleanEmail || undefined,
  };
  writeLockoutSlot(`${PASSPHRASE_LOCKOUT_KEY_PREFIX}global`, record);
  if (userId) {
    writeLockoutSlot(`${PASSPHRASE_LOCKOUT_KEY_PREFIX}usr:${userId}`, record);
  }
  if (cleanEmail) {
    writeLockoutSlot(PASSPHSE_EMAIL_PREFIX(cleanEmail), record);
  }
}

export function clearPassphraseFailures(userId?: string, email?: string, fullReset = false): void {
  if (typeof window === "undefined") return;
  const status = getPassphraseLockoutStatus(userId, email);
  if (status.locked) return;
  try {
    if (fullReset) {
      window.localStorage.removeItem(`${PASSPHRASE_LOCKOUT_KEY_PREFIX}global`);
      if (userId) {
        window.localStorage.removeItem(`${PASSPHRASE_LOCKOUT_KEY_PREFIX}usr:${userId}`);
      }
      const cleanEmail = email?.trim().toLowerCase() || "";
      if (cleanEmail) {
        window.localStorage.removeItem(PASSPHSE_EMAIL_PREFIX(cleanEmail));
      }
    } else {
      setLocalPassphraseLockout(0, userId, email, 0, status.tier);
    }
  } catch {
    // ignore
  }
}

export async function checkServerPassphraseLockout(
  email: string,
): Promise<{ locked: boolean; lockedUntil: number; tier: number }> {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail) return { locked: false, lockedUntil: 0, tier: 0 };
  try {
    const res = await fetch("/api/storage-proxy?action=passphrase-lockout-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: cleanEmail }),
    });
    if (!res.ok) return { locked: false, lockedUntil: 0, tier: 0 };
    const data = (await res.json()) as { locked?: boolean; lockedUntil?: number; tier?: number };
    const lockedUntil = Number(data?.lockedUntil) || 0;
    const tier = Number(data?.tier) || 0;
    const locked = Boolean(data?.locked && lockedUntil > Date.now());
    if (locked) {
      setLocalPassphraseLockout(lockedUntil, undefined, cleanEmail, undefined, tier);
    }
    return { locked, lockedUntil: locked ? lockedUntil : 0, tier };
  } catch {
    return { locked: false, lockedUntil: 0, tier: 0 };
  }
}

export async function recordServerPassphraseFailure(
  email?: string,
  forceLockout = false,
  userId?: string,
  tier?: number,
): Promise<{
  failures: number;
  locked: boolean;
  lockedUntil: number;
  tier: number;
  attemptsRemaining: number;
}> {
  const cleanEmail = email?.trim().toLowerCase() || "";
  const token = await getFreshAccessToken();
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch("/api/storage-proxy?action=passphrase-lockout-record", {
      method: "POST",
      headers,
      body: JSON.stringify({
        email: cleanEmail,
        forceLockout,
        tier,
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        failures?: number;
        locked?: boolean;
        lockedUntil?: number;
        tier?: number;
        attemptsRemaining?: number;
      };
      const lockedUntil = Number(data?.lockedUntil) || 0;
      const resTier = Number(data?.tier) || tier || 0;
      const resFailures = Number(data?.failures) || 0;
      const isLocked = Boolean(data?.locked && lockedUntil > Date.now());
      setLocalPassphraseLockout(lockedUntil, userId, cleanEmail, resFailures, resTier);
      return {
        failures: resFailures,
        locked: isLocked,
        lockedUntil: isLocked ? lockedUntil : 0,
        tier: resTier,
        attemptsRemaining: Number(data?.attemptsRemaining) || 0,
      };
    }
  } catch {
    // fallback
  }

  // Local fallback if offline or proxy error
  const localStatus = getPassphraseLockoutStatus(userId, cleanEmail);
  const currentTier = typeof tier === "number" ? tier : localStatus.tier;
  const maxAttempts = currentTier > 0 ? 3 : MAX_PASSPHRASE_ATTEMPTS;
  const nextFailures = forceLockout ? maxAttempts : localStatus.failures + 1;
  const shouldLock = forceLockout || nextFailures >= maxAttempts;
  const nextTier = shouldLock ? currentTier + 1 : currentTier;
  const duration = getLockoutDurationMs(Math.max(1, nextTier));
  const lockedUntil = shouldLock ? Date.now() + duration : 0;
  setLocalPassphraseLockout(lockedUntil, userId, cleanEmail, nextFailures, nextTier);
  return {
    failures: nextFailures,
    locked: shouldLock,
    lockedUntil,
    tier: nextTier,
    attemptsRemaining: Math.max(0, maxAttempts - nextFailures),
  };
}

export async function forceLogoutForPassphraseLockout(
  userId?: string,
  email?: string,
  lockedUntilOverride?: number,
  tierOverride?: number,
): Promise<void> {
  const currentStatus = getPassphraseLockoutStatus(userId, email);
  const resolvedTier =
    typeof tierOverride === "number" ? tierOverride : Math.max(1, currentStatus.tier + 1);
  const durationMs = getLockoutDurationMs(resolvedTier);
  const lockedUntil =
    lockedUntilOverride && lockedUntilOverride > Date.now()
      ? lockedUntilOverride
      : Date.now() + durationMs;

  let resolvedEmail = email;
  let resolvedUserId = userId;
  try {
    const { data } = await supabase.auth.getSession();
    if (data.session?.user) {
      resolvedUserId = resolvedUserId || data.session.user.id;
      resolvedEmail = resolvedEmail || data.session.user.email;
    }
  } catch {
    // ignore
  }

  setLocalPassphraseLockout(
    lockedUntil,
    resolvedUserId,
    resolvedEmail,
    MAX_PASSPHRASE_ATTEMPTS,
    resolvedTier,
  );

  try {
    const token = await getFreshAccessToken();
    await Promise.allSettled([
      token
        ? fetch("/api/storage-proxy?action=passphrase-lockout-record", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ forceLockout: true, tier: resolvedTier }),
          })
        : Promise.resolve(),
      supabase.auth.updateUser({
        data: {
          papervault_lockout_until: lockedUntil,
          papervault_lockout_tier: resolvedTier,
        },
      }),
    ]);
  } catch {
    // ignore network errors during emergency logout
  }

  clearCryptoCache();
  clearAllOfflineUserData();
  setLocalPassphraseLockout(
    lockedUntil,
    resolvedUserId,
    resolvedEmail,
    MAX_PASSPHRASE_ATTEMPTS,
    resolvedTier,
  );

  try {
    await supabase.auth.signOut();
  } catch {
    // ignore
  }

  if (typeof window !== "undefined") {
    window.location.href = `/auth?locked=1&tier=${resolvedTier}`;
  }
}

type VaultContextValue = {
  status: VaultStatus;
  key: CryptoKey | null;
  recoveryKey: string | null;
  hasRecoveryKey: boolean;
  failedAttempts: number;
  attemptsRemaining: number;
  tier: number;
  nextLockoutDurationMs: number;
  setup: (passphrase: string) => Promise<CryptoKey>;
  unlock: (passphrase: string) => Promise<CryptoKey>;
  changePassphrase: (
    currentPassphrase: string,
    newPassphrase: string,
    onProgress?: (step: string) => void,
  ) => Promise<{ recoveryKey: string }>;
  recoverWithRecoveryKey: (
    recoveryKeyInput: string,
    newPassphrase: string,
    onProgress?: (step: string) => void,
  ) => Promise<CryptoKey>;
  regenerateRecoveryKey: (currentPassphrase: string) => Promise<string>;
  resetVaultAndSetup: (newPassphrase: string) => Promise<{ key: CryptoKey; recoveryKey: string }>;
  lock: () => void;
};

const IDLE_LOCK_MS = 15 * 60 * 1000; // 15 minutes of inactivity auto-locks the vault

const VaultContext = createContext<VaultContextValue | null>(null);
let moduleScopedVaultValue: VaultContextValue | null = null;

const FALLBACK_VAULT_CONTEXT: VaultContextValue = {
  status: "loading",
  key: null,
  recoveryKey: null,
  hasRecoveryKey: false,
  failedAttempts: 0,
  attemptsRemaining: MAX_PASSPHRASE_ATTEMPTS,
  tier: 0,
  nextLockoutDurationMs: getLockoutDurationMs(1),
  setup: async () => {
    throw new Error("Vault is still initializing");
  },
  unlock: async () => {
    throw new Error("Vault is still initializing");
  },
  changePassphrase: async () => {
    throw new Error("Vault is still initializing");
  },
  recoverWithRecoveryKey: async () => {
    throw new Error("Vault is still initializing");
  },
  regenerateRecoveryKey: async () => {
    throw new Error("Vault is still initializing");
  },
  resetVaultAndSetup: async () => {
    throw new Error("Vault is still initializing");
  },
  lock: () => {},
};

const VAULT_META_PREFIX = "papervault:vault_meta:";

type CachedVaultMeta = {
  kdf_salt: string;
  verifier: string;
  verifier_salt: string;
  updated_at?: string;
  recovery_envelope?: RecoveryEnvelope | null;
  encrypted_recovery_key?: { ct: string; iv: string } | null;
};

function isValidVaultMeta(meta: unknown): meta is CachedVaultMeta {
  if (!meta || typeof meta !== "object") return false;
  const m = meta as Record<string, unknown>;
  if (
    typeof m.kdf_salt !== "string" ||
    typeof m.verifier !== "string" ||
    typeof m.verifier_salt !== "string"
  ) {
    return false;
  }
  // Prevent salt-swap attacks where kdf_salt === verifier_salt
  if (
    m.kdf_salt.length < 16 ||
    m.verifier_salt.length < 16 ||
    m.verifier.length < 16 ||
    m.kdf_salt === m.verifier_salt
  ) {
    return false;
  }
  return true;
}

function getCachedVaultMeta(userId: string): CachedVaultMeta | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`${VAULT_META_PREFIX}${userId}`);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isValidVaultMeta(parsed)) return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

function cacheVaultMeta(userId: string, meta: CachedVaultMeta) {
  if (typeof window === "undefined" || !isValidVaultMeta(meta)) return;
  try {
    window.localStorage.setItem(`${VAULT_META_PREFIX}${userId}`, JSON.stringify(meta));
  } catch {
    // ignore
  }
}

async function persistVaultMetaEverywhere(userId: string, meta: CachedVaultMeta): Promise<void> {
  const nowIso = meta.updated_at || new Date().toISOString();
  const fullRecord: VaultMetaRecord = {
    user_id: userId,
    kdf_salt: meta.kdf_salt,
    verifier: meta.verifier,
    verifier_salt: meta.verifier_salt,
    updated_at: nowIso,
    recovery_envelope: meta.recovery_envelope ?? null,
    encrypted_recovery_key: meta.encrypted_recovery_key ?? null,
  };

  cacheVaultMeta(userId, fullRecord);

  await Promise.allSettled([
    writeRemoteVaultMeta(fullRecord),
    supabase.from("vault_keys").upsert(
      {
        user_id: userId,
        kdf_salt: meta.kdf_salt,
        verifier: meta.verifier,
        verifier_salt: meta.verifier_salt,
        updated_at: nowIso,
      },
      { onConflict: "user_id" },
    ),
    supabase
      .from("vault_keys")
      .update({
        kdf_salt: meta.kdf_salt,
        verifier: meta.verifier,
        verifier_salt: meta.verifier_salt,
        updated_at: nowIso,
      })
      .eq("user_id", userId),
  ]);
}

export function VaultProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const qc = useQueryClient();
  const initialCached = getCachedVaultMeta(userId);
  const [status, setStatus] = useState<VaultStatus>(initialCached ? "locked" : "loading");
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [failedAttempts, setFailedAttempts] = useState<number>(
    () => getPassphraseLockoutStatus(userId).failures,
  );
  const [lockoutTier, setLockoutTier] = useState<number>(
    () => getPassphraseLockoutStatus(userId).tier,
  );
  const [kdfSalt, setKdfSalt] = useState<string | null>(initialCached?.kdf_salt ?? null);
  const [verifier, setVerifier] = useState<string | null>(initialCached?.verifier ?? null);
  const [verifierSalt, setVerifierSalt] = useState<string | null>(
    initialCached?.verifier_salt ?? null,
  );
  const [recoveryEnvelope, setRecoveryEnvelope] = useState<RecoveryEnvelope | null>(
    initialCached?.recovery_envelope ?? null,
  );
  const [encryptedRecoveryKey, setEncryptedRecoveryKey] = useState<{
    ct: string;
    iv: string;
  } | null>(initialCached?.encrypted_recovery_key ?? null);

  const registerWrongPassphraseAttempt = useCallback(async (): Promise<never> => {
    const currentStatus = getPassphraseLockoutStatus(userId);
    const currentTier = currentStatus.tier || 0;
    const maxAttempts = currentTier > 0 ? 3 : MAX_PASSPHRASE_ATTEMPTS;
    const nextLocalFailures = currentStatus.failures + 1;
    let effectiveFailures = nextLocalFailures;
    const shouldLock = nextLocalFailures >= maxAttempts;
    const nextTier = shouldLock ? currentTier + 1 : currentTier;
    const nextDurationMs = getLockoutDurationMs(Math.max(1, nextTier));
    let lockedUntil = shouldLock ? Date.now() + nextDurationMs : 0;

    setLocalPassphraseLockout(lockedUntil, userId, undefined, effectiveFailures, nextTier);
    setFailedAttempts(effectiveFailures);
    setLockoutTier(nextTier);

    try {
      const token = await getFreshAccessToken();
      if (token) {
        const res = await fetch("/api/storage-proxy?action=passphrase-lockout-record", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            forceLockout: shouldLock,
            tier: nextTier,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            failures?: number;
            locked?: boolean;
            lockedUntil?: number;
            tier?: number;
          };
          if (typeof data.failures === "number" && data.failures > effectiveFailures) {
            effectiveFailures = data.failures;
          }
          if (typeof data.tier === "number" && data.tier > nextTier) {
            setLockoutTier(data.tier);
          }
          if (
            data.locked &&
            typeof data.lockedUntil === "number" &&
            data.lockedUntil > lockedUntil
          ) {
            lockedUntil = data.lockedUntil;
          }
        }
      }
    } catch {
      // continue with local enforcement
    }

    if (shouldLock || lockedUntil > Date.now()) {
      const finalLockedUntil = lockedUntil > Date.now() ? lockedUntil : Date.now() + nextDurationMs;
      await forceLogoutForPassphraseLockout(userId, undefined, finalLockedUntil, nextTier);
      throw new Error(
        `Maximum passphrase attempts exceeded (${effectiveFailures}/${maxAttempts}). You have been logged out and locked out for ${formatDurationLabel(nextDurationMs)}.`,
      );
    }

    setLocalPassphraseLockout(0, userId, undefined, effectiveFailures, currentTier);
    setFailedAttempts(effectiveFailures);
    const remaining = Math.max(1, maxAttempts - effectiveFailures);
    throw new Error(
      `Wrong passphrase. ${remaining} ${remaining === 1 ? "attempt" : "attempts"} remaining before automatic logout and ${formatDurationLabel(nextDurationMs)} lockout.`,
    );
  }, [userId]);

  const resetPassphraseFailureCounter = useCallback(
    (fullReset = false) => {
      clearPassphraseFailures(userId, undefined, fullReset);
      setFailedAttempts(0);
      if (fullReset) {
        setLockoutTier(0);
      }
      void (async () => {
        try {
          const token = await getFreshAccessToken();
          if (token) {
            await fetch("/api/storage-proxy?action=passphrase-lockout-clear", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ fullReset }),
            });
          }
        } catch {
          // ignore
        }
      })();
    },
    [userId],
  );

  const applyResolvedMeta = useCallback(
    (meta: CachedVaultMeta) => {
      setKdfSalt(meta.kdf_salt);
      setVerifier(meta.verifier);
      setVerifierSalt(meta.verifier_salt);
      if (meta.recovery_envelope !== undefined) {
        setRecoveryEnvelope(meta.recovery_envelope ?? null);
      }
      if (meta.encrypted_recovery_key !== undefined) {
        setEncryptedRecoveryKey(meta.encrypted_recovery_key ?? null);
      }
      cacheVaultMeta(userId, meta);
    },
    [userId],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = getCachedVaultMeta(userId);
      if (cached) {
        setKdfSalt(cached.kdf_salt);
        setVerifier(cached.verifier);
        setVerifierSalt(cached.verifier_salt);
        setRecoveryEnvelope(cached.recovery_envelope ?? null);
        setEncryptedRecoveryKey(cached.encrypted_recovery_key ?? null);
        setStatus((prev) => (prev === "unlocked" ? "unlocked" : "locked"));
      }

      try {
        const [remoteMeta, dbRes] = await Promise.all([
          fetchRemoteVaultMeta(userId),
          supabase.from("vault_keys").select("*").eq("user_id", userId).maybeSingle(),
        ]);
        if (cancelled) return;

        let dbData = dbRes.data;
        let dbError = dbRes.error;

        if (dbError && !remoteMeta && !cached) {
          await new Promise((r) => setTimeout(r, 1500));
          if (cancelled) return;
          const retry = await supabase
            .from("vault_keys")
            .select("*")
            .eq("user_id", userId)
            .maybeSingle();
          dbData = retry.data;
          dbError = retry.error;
        }

        if (cancelled) return;

        const validRemote = remoteMeta && isValidVaultMeta(remoteMeta) ? remoteMeta : null;
        const validDb = dbData && isValidVaultMeta(dbData) ? dbData : null;

        if (validRemote && validDb) {
          const remoteTs = Date.parse(validRemote.updated_at || "") || 0;
          const dbTs = Date.parse(validDb.updated_at || "") || 0;
          const winner: CachedVaultMeta =
            remoteTs >= dbTs
              ? validRemote
              : {
                  kdf_salt: validDb.kdf_salt,
                  verifier: validDb.verifier,
                  verifier_salt: validDb.verifier_salt,
                  updated_at: validDb.updated_at,
                  recovery_envelope:
                    validRemote.kdf_salt === validDb.kdf_salt
                      ? validRemote.recovery_envelope
                      : null,
                  encrypted_recovery_key:
                    validRemote.kdf_salt === validDb.kdf_salt
                      ? validRemote.encrypted_recovery_key
                      : null,
                };
          applyResolvedMeta(winner);
          setStatus((prev) => (prev === "unlocked" ? "unlocked" : "locked"));
          return;
        }

        if (validRemote) {
          applyResolvedMeta(validRemote);
          setStatus((prev) => (prev === "unlocked" ? "unlocked" : "locked"));
          return;
        }

        if (validDb) {
          const mergedMeta: CachedVaultMeta = {
            kdf_salt: validDb.kdf_salt,
            verifier: validDb.verifier,
            verifier_salt: validDb.verifier_salt,
            updated_at: validDb.updated_at,
            recovery_envelope:
              cached?.kdf_salt === validDb.kdf_salt ? (cached.recovery_envelope ?? null) : null,
            encrypted_recovery_key:
              cached?.kdf_salt === validDb.kdf_salt
                ? (cached.encrypted_recovery_key ?? null)
                : null,
          };
          applyResolvedMeta(mergedMeta);
          setStatus((prev) => (prev === "unlocked" ? "unlocked" : "locked"));
          return;
        }

        if (cached) {
          setStatus((prev) => (prev === "unlocked" ? "unlocked" : "locked"));
          return;
        }

        if (!dbError) {
          setStatus("needs_setup");
        } else {
          setStatus("needs_setup");
        }
      } catch {
        if (!cached && !cancelled) {
          setStatus("needs_setup");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, applyResolvedMeta]);

  const setup = useCallback(
    async (passphrase: string): Promise<CryptoKey> => {
      if (passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
      const newKdfSalt = toB64(randomBytes(16));
      let newVerifierSalt = toB64(randomBytes(16));
      while (newVerifierSalt === newKdfSalt) {
        newVerifierSalt = toB64(randomBytes(16));
      }
      const [newVerifier, dataKey] = await Promise.all([
        deriveVerifier(passphrase, newVerifierSalt),
        deriveDataKey(passphrase, newKdfSalt),
      ]);

      const newRecKey = generateRecoveryKey();
      const [envelope, encRecKey] = await Promise.all([
        createRecoveryEnvelope(passphrase, newRecKey),
        encryptText(dataKey, newRecKey),
      ]);

      const nowIso = new Date().toISOString();
      const meta: CachedVaultMeta = {
        kdf_salt: newKdfSalt,
        verifier: newVerifier,
        verifier_salt: newVerifierSalt,
        updated_at: nowIso,
        recovery_envelope: envelope,
        encrypted_recovery_key: encRecKey,
      };

      await persistVaultMetaEverywhere(userId, meta);

      resetPassphraseFailureCounter();
      setKdfSalt(newKdfSalt);
      setVerifier(newVerifier);
      setVerifierSalt(newVerifierSalt);
      setRecoveryEnvelope(envelope);
      setEncryptedRecoveryKey(encRecKey);
      setRecoveryKey(newRecKey);
      setKey(dataKey);
      setStatus("unlocked");
      return dataKey;
    },
    [userId, resetPassphraseFailureCounter],
  );

  const unlock = useCallback(
    async (passphrase: string): Promise<CryptoKey> => {
      const lockState = getPassphraseLockoutStatus(userId);
      if (lockState.locked) {
        await forceLogoutForPassphraseLockout(userId, undefined, lockState.lockedUntil);
        throw new Error(
          `Too many failed passphrase attempts. Login is locked for ${formatLockoutRemaining(lockState.remainingMs)}.`,
        );
      }
      if (!kdfSalt || !verifier || !verifierSalt) throw new Error("Vault not initialized");
      if (kdfSalt === verifierSalt) {
        throw new Error("Invalid vault key parameters detected");
      }
      const [check, dataKey] = await Promise.all([
        deriveVerifier(passphrase, verifierSalt),
        deriveDataKey(passphrase, kdfSalt),
      ]);
      if (!timingSafeEqualStr(check, verifier)) {
        return await registerWrongPassphraseAttempt();
      }
      resetPassphraseFailureCounter();
      setKey(dataKey);
      setStatus("unlocked");

      // Load or automatically enroll a Vault Recovery Key for this user
      void (async () => {
        try {
          if (encryptedRecoveryKey?.ct && encryptedRecoveryKey?.iv && recoveryEnvelope) {
            const plainRecKey = await decryptText(
              dataKey,
              encryptedRecoveryKey.ct,
              encryptedRecoveryKey.iv,
            );
            if (plainRecKey) {
              setRecoveryKey(plainRecKey);
              return;
            }
          }
          // Auto-enroll a Recovery Key for accounts that didn't have one yet
          const newRecKey = generateRecoveryKey();
          const [envelope, encRecKey] = await Promise.all([
            createRecoveryEnvelope(passphrase, newRecKey),
            encryptText(dataKey, newRecKey),
          ]);
          setRecoveryEnvelope(envelope);
          setEncryptedRecoveryKey(encRecKey);
          setRecoveryKey(newRecKey);
          await persistVaultMetaEverywhere(userId, {
            kdf_salt: kdfSalt,
            verifier,
            verifier_salt: verifierSalt,
            updated_at: new Date().toISOString(),
            recovery_envelope: envelope,
            encrypted_recovery_key: encRecKey,
          });
        } catch {
          // ignore background enrollment errors
        }
      })();

      return dataKey;
    },
    [
      userId,
      kdfSalt,
      verifier,
      verifierSalt,
      encryptedRecoveryKey,
      recoveryEnvelope,
      registerWrongPassphraseAttempt,
      resetPassphraseFailureCounter,
    ],
  );

  const changePassphrase = useCallback(
    async (
      currentPassphrase: string,
      newPassphrase: string,
      onProgress?: (step: string) => void,
    ): Promise<{ recoveryKey: string }> => {
      if (!kdfSalt || !verifier || !verifierSalt) {
        throw new Error("Vault is not initialized.");
      }
      if (newPassphrase.length < 8) {
        throw new Error("New passphrase must be at least 8 characters.");
      }
      onProgress?.("Verifying current passphrase...");
      const [check, oldKey] = await Promise.all([
        deriveVerifier(currentPassphrase, verifierSalt),
        deriveDataKey(currentPassphrase, kdfSalt),
      ]);
      if (!timingSafeEqualStr(check, verifier)) {
        return await registerWrongPassphraseAttempt();
      }
      resetPassphraseFailureCounter();

      onProgress?.("Deriving new encryption keys...");
      const newKdfSalt = toB64(randomBytes(16));
      let newVerifierSalt = toB64(randomBytes(16));
      while (newVerifierSalt === newKdfSalt) {
        newVerifierSalt = toB64(randomBytes(16));
      }
      const [newVerifier, newKey] = await Promise.all([
        deriveVerifier(newPassphrase, newVerifierSalt),
        deriveDataKey(newPassphrase, newKdfSalt),
      ]);

      await reencryptUserVaultData(userId, oldKey, newKey, onProgress);

      const activeRecKey = recoveryKey || generateRecoveryKey();
      const [envelope, encRecKey] = await Promise.all([
        createRecoveryEnvelope(newPassphrase, activeRecKey),
        encryptText(newKey, activeRecKey),
      ]);

      onProgress?.("Saving updated vault credentials...");
      const nowIso = new Date().toISOString();
      await persistVaultMetaEverywhere(userId, {
        kdf_salt: newKdfSalt,
        verifier: newVerifier,
        verifier_salt: newVerifierSalt,
        updated_at: nowIso,
        recovery_envelope: envelope,
        encrypted_recovery_key: encRecKey,
      });

      clearCryptoCache();
      setKdfSalt(newKdfSalt);
      setVerifier(newVerifier);
      setVerifierSalt(newVerifierSalt);
      setRecoveryEnvelope(envelope);
      setEncryptedRecoveryKey(encRecKey);
      setRecoveryKey(activeRecKey);
      setKey(newKey);
      setStatus("unlocked");
      qc.invalidateQueries();

      return { recoveryKey: activeRecKey };
    },
    [
      userId,
      kdfSalt,
      verifier,
      verifierSalt,
      recoveryKey,
      qc,
      registerWrongPassphraseAttempt,
      resetPassphraseFailureCounter,
    ],
  );

  const recoverWithRecoveryKey = useCallback(
    async (
      recoveryKeyInput: string,
      newPassphrase: string,
      onProgress?: (step: string) => void,
    ): Promise<CryptoKey> => {
      if (newPassphrase.length < 8) {
        throw new Error("New passphrase must be at least 8 characters.");
      }
      onProgress?.("Checking recovery key...");
      let activeEnvelope = recoveryEnvelope;
      let activeKdfSalt = kdfSalt;
      if (!activeEnvelope || !activeKdfSalt) {
        const remote = await fetchRemoteVaultMeta(userId);
        if (remote?.recovery_envelope && remote?.kdf_salt) {
          activeEnvelope = remote.recovery_envelope;
          activeKdfSalt = remote.kdf_salt;
        }
      }
      if (!activeEnvelope || !activeKdfSalt) {
        throw new Error("No recovery key backup was found for this vault.");
      }

      const oldPassphrase = await unwrapRecoveryEnvelope(activeEnvelope, recoveryKeyInput);
      const oldKey = await deriveDataKey(oldPassphrase, activeKdfSalt);

      onProgress?.("Deriving new vault key...");
      const newKdfSalt = toB64(randomBytes(16));
      let newVerifierSalt = toB64(randomBytes(16));
      while (newVerifierSalt === newKdfSalt) {
        newVerifierSalt = toB64(randomBytes(16));
      }
      const [newVerifier, newKey] = await Promise.all([
        deriveVerifier(newPassphrase, newVerifierSalt),
        deriveDataKey(newPassphrase, newKdfSalt),
      ]);

      await reencryptUserVaultData(userId, oldKey, newKey, onProgress);

      const formattedRecKey = recoveryKeyInput.trim().toUpperCase();
      const [newEnvelope, encRecKey] = await Promise.all([
        createRecoveryEnvelope(newPassphrase, formattedRecKey),
        encryptText(newKey, formattedRecKey),
      ]);

      onProgress?.("Saving new vault passphrase...");
      await persistVaultMetaEverywhere(userId, {
        kdf_salt: newKdfSalt,
        verifier: newVerifier,
        verifier_salt: newVerifierSalt,
        updated_at: new Date().toISOString(),
        recovery_envelope: newEnvelope,
        encrypted_recovery_key: encRecKey,
      });

      clearCryptoCache();
      resetPassphraseFailureCounter();
      setKdfSalt(newKdfSalt);
      setVerifier(newVerifier);
      setVerifierSalt(newVerifierSalt);
      setRecoveryEnvelope(newEnvelope);
      setEncryptedRecoveryKey(encRecKey);
      setRecoveryKey(formattedRecKey);
      setKey(newKey);
      setStatus("unlocked");
      qc.invalidateQueries();

      return newKey;
    },
    [userId, recoveryEnvelope, kdfSalt, qc, resetPassphraseFailureCounter],
  );

  const regenerateRecoveryKey = useCallback(
    async (currentPassphrase: string): Promise<string> => {
      if (!kdfSalt || !verifier || !verifierSalt || !key) {
        throw new Error("Vault must be unlocked to regenerate your recovery key.");
      }
      const check = await deriveVerifier(currentPassphrase, verifierSalt);
      if (!timingSafeEqualStr(check, verifier)) {
        return await registerWrongPassphraseAttempt();
      }
      resetPassphraseFailureCounter();
      const newRecKey = generateRecoveryKey();
      const [envelope, encRecKey] = await Promise.all([
        createRecoveryEnvelope(currentPassphrase, newRecKey),
        encryptText(key, newRecKey),
      ]);
      await persistVaultMetaEverywhere(userId, {
        kdf_salt: kdfSalt,
        verifier,
        verifier_salt: verifierSalt,
        updated_at: new Date().toISOString(),
        recovery_envelope: envelope,
        encrypted_recovery_key: encRecKey,
      });
      setRecoveryEnvelope(envelope);
      setEncryptedRecoveryKey(encRecKey);
      setRecoveryKey(newRecKey);
      return newRecKey;
    },
    [
      userId,
      kdfSalt,
      verifier,
      verifierSalt,
      key,
      registerWrongPassphraseAttempt,
      resetPassphraseFailureCounter,
    ],
  );

  const resetVaultAndSetup = useCallback(
    async (newPassphrase: string): Promise<{ key: CryptoKey; recoveryKey: string }> => {
      if (newPassphrase.length < 8) {
        throw new Error("New passphrase must be at least 8 characters.");
      }
      await wipeAndResetUserVault(userId);
      clearCryptoCache();
      qc.clear();

      const newKdfSalt = toB64(randomBytes(16));
      let newVerifierSalt = toB64(randomBytes(16));
      while (newVerifierSalt === newKdfSalt) {
        newVerifierSalt = toB64(randomBytes(16));
      }
      const [newVerifier, dataKey] = await Promise.all([
        deriveVerifier(newPassphrase, newVerifierSalt),
        deriveDataKey(newPassphrase, newKdfSalt),
      ]);

      const newRecKey = generateRecoveryKey();
      const [envelope, encRecKey] = await Promise.all([
        createRecoveryEnvelope(newPassphrase, newRecKey),
        encryptText(dataKey, newRecKey),
      ]);

      await persistVaultMetaEverywhere(userId, {
        kdf_salt: newKdfSalt,
        verifier: newVerifier,
        verifier_salt: newVerifierSalt,
        updated_at: new Date().toISOString(),
        recovery_envelope: envelope,
        encrypted_recovery_key: encRecKey,
      });

      resetPassphraseFailureCounter();
      setKdfSalt(newKdfSalt);
      setVerifier(newVerifier);
      setVerifierSalt(newVerifierSalt);
      setRecoveryEnvelope(envelope);
      setEncryptedRecoveryKey(encRecKey);
      setRecoveryKey(newRecKey);
      setKey(dataKey);
      setStatus("unlocked");
      return { key: dataKey, recoveryKey: newRecKey };
    },
    [userId, qc, resetPassphraseFailureCounter],
  );

  const lock = useCallback(() => {
    setKey(null);
    setRecoveryKey(null);
    setStatus(kdfSalt ? "locked" : "needs_setup");
    moduleScopedVaultValue = null;
    // Wipe all decrypted data from React Query memory cache immediately on lock
    clearCryptoCache();
    qc.clear();
    clearOfflineBlobUrls();
  }, [kdfSalt, qc]);

  // Auto-lock the vault and wipe memory after prolonged inactivity
  useEffect(() => {
    if (status !== "unlocked" || !key) return;
    let timer = window.setTimeout(lock, IDLE_LOCK_MS);
    const resetTimer = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(lock, IDLE_LOCK_MS);
    };
    const events: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "scroll", "focus"];
    for (const ev of events) window.addEventListener(ev, resetTimer, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const ev of events) window.removeEventListener(ev, resetTimer);
    };
  }, [status, key, lock]);

  const value = useMemo(
    () => ({
      status,
      key,
      recoveryKey,
      hasRecoveryKey: Boolean(recoveryEnvelope),
      failedAttempts,
      attemptsRemaining: Math.max(
        0,
        (lockoutTier > 0 ? 3 : MAX_PASSPHRASE_ATTEMPTS) - failedAttempts,
      ),
      tier: lockoutTier,
      nextLockoutDurationMs: getLockoutDurationMs(lockoutTier + 1),
      setup,
      unlock,
      changePassphrase,
      recoverWithRecoveryKey,
      regenerateRecoveryKey,
      resetVaultAndSetup,
      lock,
    }),
    [
      status,
      key,
      recoveryKey,
      recoveryEnvelope,
      failedAttempts,
      lockoutTier,
      setup,
      unlock,
      changePassphrase,
      recoverWithRecoveryKey,
      regenerateRecoveryKey,
      resetVaultAndSetup,
      lock,
    ],
  );

  moduleScopedVaultValue = value;

  useEffect(() => {
    return () => {
      moduleScopedVaultValue = null;
    };
  }, []);

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultContextValue {
  const v = useContext(VaultContext);
  if (v) return v;
  return moduleScopedVaultValue ?? FALLBACK_VAULT_CONTEXT;
}

// Throws if the vault is locked. Use inside mutations to fail fast with a helpful message.
export function useVaultKey(): CryptoKey {
  const { key } = useVault();
  if (!key) throw new Error("Your vault is locked. Unlock it to continue.");
  return key;
}
