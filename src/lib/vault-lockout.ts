import { getFreshAccessToken } from "@/lib/offline-supabase";
import type { SecurityQuestionsChallenge } from "@/lib/security-questions";

export const INITIAL_MAX_PASSPHRASE_ATTEMPTS = 5;
export const BASE_VAULT_LOCKOUT_MS = 60 * 60 * 1000; // 1 hour
export const MAX_VAULT_LOCKOUT_MS = 168 * 60 * 60 * 1000; // 7 days cap

export const SIGN_OUT_TO_AUTH_EVENT = "papervault:force-signout-to-auth";

export type ForceSignOutNotice = "vault_attempts_signout" | "vault_locked";

export type ForceSignOutDetail = {
  notice: ForceSignOutNotice;
  lockedUntil?: number;
  durationMs?: number;
  lockoutCount?: number;
  emailSent?: boolean;
};

export type VaultLockoutStatus = {
  failedAttempts: number;
  maxAttemptsBeforeSignOut: number;
  remainingAttempts: number;
  escalationStage: number;
  requireSecurityQuestionsOnSignIn: boolean;
  needsSecurityQuestionsInGate: boolean;
  lockoutCount: number;
  lockedUntil: number;
  isLocked: boolean;
  lastLockDurationMs: number;
  nextLockDurationMs: number;
  lastEmailSentAt: number;
};

export type VaultLockoutFailureResult = VaultLockoutStatus & {
  action: "warn" | "sign_out" | "lock_and_sign_out" | "locked";
  reason?: "wrong_passphrase" | "too_many_attempts" | "vault_locked";
  emailSent?: boolean;
  emailMethod?: string;
};

export type SigninPreflightResult = {
  requireSecurityQuestions: boolean;
  challenge?: SecurityQuestionsChallenge;
  session?: {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
    expires_at?: number;
    token_type?: string;
    user?: unknown;
  };
  lockout: {
    isLocked: boolean;
    lockedUntil: number;
    lockoutCount: number;
    escalationStage: number;
    lastLockDurationMs: number;
  };
};

export type SigninVerifyResult = {
  verified: boolean;
  session?: {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
    expires_at?: number;
    token_type?: string;
    user?: unknown;
  };
  lockout?: {
    isLocked: boolean;
    lockedUntil: number;
    lockoutCount: number;
    escalationStage: number;
    lastLockDurationMs: number;
  };
};

const LOCAL_LOCKOUT_PREFIX = "papervault:vault_lockout_ui:v1:";

export function computeVaultLockoutDurationMs(lockoutCount: number): number {
  const count = Math.max(1, Math.floor(lockoutCount));
  const multiplier = Math.pow(2, Math.min(count - 1, 10));
  return Math.min(MAX_VAULT_LOCKOUT_MS, BASE_VAULT_LOCKOUT_MS * multiplier);
}

export function formatLockoutDuration(ms: number): string {
  const safeMs = Math.max(0, ms);
  const totalMinutes = Math.round(safeMs / 60_000);
  if (totalMinutes < 60) {
    const mins = Math.max(1, totalMinutes);
    return `${mins} minute${mins === 1 ? "" : "s"}`;
  }
  const hours = Math.round((safeMs / 3_600_000) * 10) / 10;
  if (hours < 24 || hours % 24 !== 0) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function formatLockoutCountdown(remainingMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) {
    return `${hours}h ${String(mins).padStart(2, "0")}m ${String(secs).padStart(2, "0")}s`;
  }
  if (mins > 0) {
    return `${mins}m ${String(secs).padStart(2, "0")}s`;
  }
  return `${secs}s`;
}

export function createDefaultLockoutStatus(): VaultLockoutStatus {
  return {
    failedAttempts: 0,
    maxAttemptsBeforeSignOut: INITIAL_MAX_PASSPHRASE_ATTEMPTS,
    remainingAttempts: INITIAL_MAX_PASSPHRASE_ATTEMPTS,
    escalationStage: 0,
    requireSecurityQuestionsOnSignIn: false,
    needsSecurityQuestionsInGate: false,
    lockoutCount: 0,
    lockedUntil: 0,
    isLocked: false,
    lastLockDurationMs: 0,
    nextLockDurationMs: BASE_VAULT_LOCKOUT_MS,
    lastEmailSentAt: 0,
  };
}

export function getCachedLocalLockoutStatus(userId: string): VaultLockoutStatus | null {
  if (typeof window === "undefined" || !userId) return null;
  try {
    const raw = window.localStorage.getItem(`${LOCAL_LOCKOUT_PREFIX}${userId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<VaultLockoutStatus>;
    if (!parsed || typeof parsed !== "object") return null;
    const now = Date.now();
    const lockedUntil = typeof parsed.lockedUntil === "number" ? parsed.lockedUntil : 0;
    const escalationStage = typeof parsed.escalationStage === "number" ? parsed.escalationStage : 0;
    const lockoutCount = typeof parsed.lockoutCount === "number" ? parsed.lockoutCount : 0;
    const failedAttempts = typeof parsed.failedAttempts === "number" ? parsed.failedAttempts : 0;
    const maxAttempts = escalationStage >= 1 ? 1 : INITIAL_MAX_PASSPHRASE_ATTEMPTS;
    const remaining =
      escalationStage >= 1 ? 1 : Math.max(0, INITIAL_MAX_PASSPHRASE_ATTEMPTS - failedAttempts);
    return {
      failedAttempts,
      maxAttemptsBeforeSignOut: maxAttempts,
      remainingAttempts: remaining,
      escalationStage,
      requireSecurityQuestionsOnSignIn: Boolean(parsed.requireSecurityQuestionsOnSignIn),
      needsSecurityQuestionsInGate: Boolean(parsed.needsSecurityQuestionsInGate),
      lockoutCount,
      lockedUntil,
      isLocked: lockedUntil > now,
      lastLockDurationMs:
        typeof parsed.lastLockDurationMs === "number" ? parsed.lastLockDurationMs : 0,
      nextLockDurationMs: computeVaultLockoutDurationMs(lockoutCount + 1),
      lastEmailSentAt: typeof parsed.lastEmailSentAt === "number" ? parsed.lastEmailSentAt : 0,
    };
  } catch {
    return null;
  }
}

export function cacheLocalLockoutStatus(userId: string, status: VaultLockoutStatus): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    window.localStorage.setItem(`${LOCAL_LOCKOUT_PREFIX}${userId}`, JSON.stringify(status));
  } catch {
    // ignore storage errors
  }
}

export function clearCachedLocalLockoutStatus(userId: string): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    window.localStorage.removeItem(`${LOCAL_LOCKOUT_PREFIX}${userId}`);
  } catch {
    // ignore
  }
}

function mergeLockoutStatuses(
  local: VaultLockoutStatus | null,
  remote: VaultLockoutStatus | null,
): VaultLockoutStatus {
  if (!local && !remote) return createDefaultLockoutStatus();
  if (!local) return remote!;
  if (!remote) return local;
  const now = Date.now();
  const lockedUntil = Math.max(local.lockedUntil, remote.lockedUntil);
  const lockoutCount = Math.max(local.lockoutCount, remote.lockoutCount);
  const escalationStage = Math.max(local.escalationStage, remote.escalationStage);
  const failedAttempts =
    escalationStage > remote.escalationStage
      ? local.failedAttempts
      : remote.escalationStage > local.escalationStage
        ? remote.failedAttempts
        : Math.max(local.failedAttempts, remote.failedAttempts);
  const maxAttempts = escalationStage >= 1 ? 1 : INITIAL_MAX_PASSPHRASE_ATTEMPTS;
  const remaining =
    escalationStage >= 1 ? 1 : Math.max(0, INITIAL_MAX_PASSPHRASE_ATTEMPTS - failedAttempts);
  return {
    failedAttempts,
    maxAttemptsBeforeSignOut: maxAttempts,
    remainingAttempts: remaining,
    escalationStage,
    requireSecurityQuestionsOnSignIn:
      remote.requireSecurityQuestionsOnSignIn || local.requireSecurityQuestionsOnSignIn,
    needsSecurityQuestionsInGate: remote.needsSecurityQuestionsInGate,
    lockoutCount,
    lockedUntil,
    isLocked: lockedUntil > now,
    lastLockDurationMs: Math.max(local.lastLockDurationMs, remote.lastLockDurationMs),
    nextLockDurationMs: computeVaultLockoutDurationMs(lockoutCount + 1),
    lastEmailSentAt: Math.max(local.lastEmailSentAt, remote.lastEmailSentAt),
  };
}

export async function fetchVaultLockoutStatus(userId: string): Promise<VaultLockoutStatus> {
  const local = getCachedLocalLockoutStatus(userId);
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return local ?? createDefaultLockoutStatus();
  }
  try {
    const token = await getFreshAccessToken();
    if (!token) return local ?? createDefaultLockoutStatus();
    const res = await fetch(`/api/storage-proxy?action=vault-lockout-status&_t=${Date.now()}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
      cache: "no-store",
    });
    if (res.ok) {
      const remote = (await res.json()) as VaultLockoutStatus;
      // Trust server when server has state or cleared state; only preserve local if local had offline failures
      const merged =
        remote.escalationStage === 0 &&
        remote.failedAttempts === 0 &&
        remote.lockoutCount === 0 &&
        local &&
        (local.failedAttempts > 0 || local.lockedUntil > Date.now())
          ? mergeLockoutStatuses(local, remote)
          : {
              ...remote,
              isLocked: remote.lockedUntil > Date.now(),
            };
      cacheLocalLockoutStatus(userId, merged);
      return merged;
    }
  } catch {
    // fallback to local
  }
  return local ?? createDefaultLockoutStatus();
}

export async function reportVaultUnlockFailed(userId: string): Promise<VaultLockoutFailureResult> {
  const now = Date.now();
  const local = getCachedLocalLockoutStatus(userId) ?? createDefaultLockoutStatus();

  if (typeof navigator !== "undefined" && navigator.onLine) {
    try {
      const token = await getFreshAccessToken();
      if (token) {
        const res = await fetch(`/api/storage-proxy?action=vault-unlock-failed`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            clientFailedAttempts: local.failedAttempts,
            clientEscalationStage: local.escalationStage,
            clientLockoutCount: local.lockoutCount,
          }),
        });
        if (res.ok || res.status === 423) {
          const data = (await res.json()) as VaultLockoutFailureResult;
          cacheLocalLockoutStatus(userId, {
            failedAttempts: data.failedAttempts,
            maxAttemptsBeforeSignOut: data.maxAttemptsBeforeSignOut,
            remainingAttempts: data.remainingAttempts,
            escalationStage: data.escalationStage,
            requireSecurityQuestionsOnSignIn: data.requireSecurityQuestionsOnSignIn,
            needsSecurityQuestionsInGate: data.needsSecurityQuestionsInGate,
            lockoutCount: data.lockoutCount,
            lockedUntil: data.lockedUntil,
            isLocked: data.lockedUntil > Date.now(),
            lastLockDurationMs: data.lastLockDurationMs,
            nextLockDurationMs: data.nextLockDurationMs,
            lastEmailSentAt: data.lastEmailSentAt,
          });
          return data;
        }
      }
    } catch {
      // fall through to offline tracking
    }
  }

  // Offline / unreachable fallback
  if (local.lockedUntil > now) {
    return {
      ...local,
      isLocked: true,
      action: "locked",
      reason: "vault_locked",
    };
  }

  const nextFailed = local.failedAttempts + 1;
  if (local.escalationStage === 0) {
    if (nextFailed < INITIAL_MAX_PASSPHRASE_ATTEMPTS) {
      const updated: VaultLockoutStatus = {
        ...local,
        failedAttempts: nextFailed,
        remainingAttempts: INITIAL_MAX_PASSPHRASE_ATTEMPTS - nextFailed,
        isLocked: false,
      };
      cacheLocalLockoutStatus(userId, updated);
      return {
        ...updated,
        action: "warn",
        reason: "wrong_passphrase",
      };
    }
    const updated: VaultLockoutStatus = {
      ...local,
      failedAttempts: nextFailed,
      maxAttemptsBeforeSignOut: 1,
      remainingAttempts: 1,
      escalationStage: 1,
      requireSecurityQuestionsOnSignIn: true,
      isLocked: false,
    };
    cacheLocalLockoutStatus(userId, updated);
    return {
      ...updated,
      action: "sign_out",
      reason: "too_many_attempts",
    };
  }

  const nextLockoutCount = local.lockoutCount + 1;
  const lockDurationMs = computeVaultLockoutDurationMs(nextLockoutCount);
  const lockedUntil = now + lockDurationMs;
  const updated: VaultLockoutStatus = {
    failedAttempts: nextFailed,
    maxAttemptsBeforeSignOut: 1,
    remainingAttempts: 1,
    escalationStage: local.escalationStage + 1,
    requireSecurityQuestionsOnSignIn: true,
    needsSecurityQuestionsInGate: true,
    lockoutCount: nextLockoutCount,
    lockedUntil,
    isLocked: true,
    lastLockDurationMs: lockDurationMs,
    nextLockDurationMs: computeVaultLockoutDurationMs(nextLockoutCount + 1),
    lastEmailSentAt: local.lastEmailSentAt,
  };
  cacheLocalLockoutStatus(userId, updated);
  return {
    ...updated,
    action: "lock_and_sign_out",
    reason: "vault_locked",
    emailSent: false,
  };
}

export async function reportVaultUnlockSucceeded(userId: string, verifier?: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine) {
    const token = await getFreshAccessToken();
    if (token) {
      const res = await fetch(`/api/storage-proxy?action=vault-unlock-succeeded`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ verifier: verifier || "" }),
      });
      if (res.status === 423) {
        const errData = (await res.json().catch(() => ({}))) as {
          lockedUntil?: number;
          error?: string;
        };
        const remaining = errData.lockedUntil
          ? formatLockoutCountdown(errData.lockedUntil - Date.now())
          : "later";
        throw new Error(errData.error || `Your vault is locked. Try again in ${remaining}.`);
      }
    }
  }
  clearCachedLocalLockoutStatus(userId);
}

export async function signinSecurityPreflight(
  email: string,
  password: string,
): Promise<SigninPreflightResult> {
  const res = await fetch(`/api/storage-proxy?action=signin-security-preflight`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: email.trim().toLowerCase(),
      password,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<SigninPreflightResult> & {
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || "Invalid login credentials");
  }
  return data as SigninPreflightResult;
}

export async function signinSecurityVerify(params: {
  email: string;
  password: string;
  verifiers: string[];
  combined_verifier: string;
}): Promise<SigninVerifyResult> {
  const res = await fetch(`/api/storage-proxy?action=signin-security-verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: params.email.trim().toLowerCase(),
      password: params.password,
      verifiers: params.verifiers,
      combined_verifier: params.combined_verifier,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<SigninVerifyResult> & {
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || "One or more security question answers did not match.");
  }
  return data as SigninVerifyResult;
}

export function requestForceSignOut(detail: ForceSignOutDetail): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem("papervault:auth_notice", JSON.stringify(detail));
  } catch {
    // ignore
  }
  window.dispatchEvent(new CustomEvent<ForceSignOutDetail>(SIGN_OUT_TO_AUTH_EVENT, { detail }));
}
