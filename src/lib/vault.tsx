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
import { clearOfflineBlobUrls } from "@/lib/offline-supabase";
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
import {
  clearCachedLocalLockoutStatus,
  createDefaultLockoutStatus,
  fetchVaultLockoutStatus,
  formatLockoutCountdown,
  formatLockoutDuration,
  getCachedLocalLockoutStatus,
  reportVaultUnlockFailed,
  reportVaultUnlockSucceeded,
  requestForceSignOut,
  type VaultLockoutStatus,
} from "@/lib/vault-lockout";

type VaultStatus = "loading" | "needs_setup" | "locked" | "unlocked";

type VaultContextValue = {
  status: VaultStatus;
  key: CryptoKey | null;
  recoveryKey: string | null;
  hasRecoveryKey: boolean;
  lockoutStatus: VaultLockoutStatus | null;
  refreshLockoutStatus: () => Promise<void>;
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
  lockoutStatus: null,
  refreshLockoutStatus: async () => {},
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
  const [lockoutStatus, setLockoutStatus] = useState<VaultLockoutStatus | null>(
    () => getCachedLocalLockoutStatus(userId) ?? createDefaultLockoutStatus(),
  );

  const refreshLockoutStatus = useCallback(async () => {
    const fresh = await fetchVaultLockoutStatus(userId);
    setLockoutStatus(fresh);
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    void fetchVaultLockoutStatus(userId).then((fresh) => {
      if (!cancelled) setLockoutStatus(fresh);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

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
        const dbPromise = supabase
          .from("vault_keys")
          .select("*")
          .eq("user_id", userId)
          .maybeSingle()
          .then((res) => {
            if (!cancelled && res.data && isValidVaultMeta(res.data)) {
              const quickMeta: CachedVaultMeta = {
                kdf_salt: res.data.kdf_salt,
                verifier: res.data.verifier,
                verifier_salt: res.data.verifier_salt,
                updated_at: res.data.updated_at,
                recovery_envelope:
                  cached?.kdf_salt === res.data.kdf_salt
                    ? (cached.recovery_envelope ?? null)
                    : null,
                encrypted_recovery_key:
                  cached?.kdf_salt === res.data.kdf_salt
                    ? (cached.encrypted_recovery_key ?? null)
                    : null,
              };
              applyResolvedMeta(quickMeta);
              setStatus((prev) => (prev === "unlocked" ? "unlocked" : "locked"));
            }
            return res;
          });

        const remotePromise = fetchRemoteVaultMeta(userId).then((remote) => {
          if (!cancelled && remote && isValidVaultMeta(remote)) {
            applyResolvedMeta(remote);
            setStatus((prev) => (prev === "unlocked" ? "unlocked" : "locked"));
          }
          return remote;
        });

        const [remoteMeta, dbRes] = await Promise.all([remotePromise, dbPromise]);
        if (cancelled) return;

        let dbData = dbRes.data;
        let dbError = dbRes.error;

        if (dbError && !remoteMeta && !cached) {
          await new Promise((r) => setTimeout(r, 800));
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
      void reportVaultUnlockSucceeded(userId, newVerifier).catch(() => {});
      clearCachedLocalLockoutStatus(userId);
      setLockoutStatus(createDefaultLockoutStatus());

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
    [userId],
  );

  const unlock = useCallback(
    async (passphrase: string): Promise<CryptoKey> => {
      const activeLockout =
        lockoutStatus ?? getCachedLocalLockoutStatus(userId) ?? createDefaultLockoutStatus();
      const now = Date.now();
      if (activeLockout.lockedUntil > now) {
        const waitLabel = formatLockoutCountdown(activeLockout.lockedUntil - now);
        throw new Error(`Your vault is temporarily locked. Try again in ${waitLabel}.`);
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
        const failureResult = await reportVaultUnlockFailed(userId);
        setLockoutStatus({
          failedAttempts: failureResult.failedAttempts,
          maxAttemptsBeforeSignOut: failureResult.maxAttemptsBeforeSignOut,
          remainingAttempts: failureResult.remainingAttempts,
          escalationStage: failureResult.escalationStage,
          requireSecurityQuestionsOnSignIn: failureResult.requireSecurityQuestionsOnSignIn,
          needsSecurityQuestionsInGate: failureResult.needsSecurityQuestionsInGate,
          lockoutCount: failureResult.lockoutCount,
          lockedUntil: failureResult.lockedUntil,
          isLocked: failureResult.lockedUntil > Date.now(),
          lastLockDurationMs: failureResult.lastLockDurationMs,
          nextLockDurationMs: failureResult.nextLockDurationMs,
          lastEmailSentAt: failureResult.lastEmailSentAt,
        });

        if (failureResult.action === "sign_out") {
          requestForceSignOut({ notice: "vault_attempts_signout" });
          throw new Error(
            "Too many incorrect passphrase attempts. You have been signed out for your protection.",
          );
        }

        if (failureResult.action === "lock_and_sign_out") {
          const durationLabel = formatLockoutDuration(failureResult.lastLockDurationMs);
          requestForceSignOut({
            notice: "vault_locked",
            lockedUntil: failureResult.lockedUntil,
            durationMs: failureResult.lastLockDurationMs,
            lockoutCount: failureResult.lockoutCount,
            emailSent: failureResult.emailSent,
          });
          throw new Error(
            `Incorrect passphrase. Your vault has been locked for ${durationLabel} and you have been signed out.${
              failureResult.emailSent ? " A security alert has been emailed to you." : ""
            }`,
          );
        }

        if (failureResult.action === "locked") {
          const waitLabel = formatLockoutCountdown(failureResult.lockedUntil - Date.now());
          throw new Error(`Your vault is locked. Try again in ${waitLabel}.`);
        }

        const rem = failureResult.remainingAttempts;
        throw new Error(
          `Wrong passphrase (${rem} attempt${rem === 1 ? "" : "s"} remaining before sign-out).`,
        );
      }

      clearCachedLocalLockoutStatus(userId);
      setLockoutStatus(createDefaultLockoutStatus());
      setKey(dataKey);
      setStatus("unlocked");

      if (
        activeLockout.failedAttempts > 0 ||
        activeLockout.escalationStage > 0 ||
        activeLockout.requireSecurityQuestionsOnSignIn
      ) {
        void reportVaultUnlockSucceeded(userId, check).catch(() => {});
      }

      // Load or automatically enroll a Vault Recovery Key for this user in the background
      window.setTimeout(() => {
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
      }, 600);

      return dataKey;
    },
    [
      userId,
      lockoutStatus,
      kdfSalt,
      verifier,
      verifierSalt,
      encryptedRecoveryKey,
      recoveryEnvelope,
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
        throw new Error("Current passphrase is incorrect.");
      }

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
    [userId, kdfSalt, verifier, verifierSalt, recoveryKey, qc],
  );

  const recoverWithRecoveryKey = useCallback(
    async (
      recoveryKeyInput: string,
      newPassphrase: string,
      onProgress?: (step: string) => void,
    ): Promise<CryptoKey> => {
      const latestLockout = await fetchVaultLockoutStatus(userId);
      setLockoutStatus(latestLockout);
      if (latestLockout.lockedUntil > Date.now()) {
        const waitLabel = formatLockoutCountdown(latestLockout.lockedUntil - Date.now());
        throw new Error(`Your vault is temporarily locked. Try again in ${waitLabel}.`);
      }
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
      await reportVaultUnlockSucceeded(userId, newVerifier).catch(() => {});
      clearCachedLocalLockoutStatus(userId);
      setLockoutStatus(createDefaultLockoutStatus());
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
    [userId, recoveryEnvelope, kdfSalt, qc],
  );

  const regenerateRecoveryKey = useCallback(
    async (currentPassphrase: string): Promise<string> => {
      if (!kdfSalt || !verifier || !verifierSalt || !key) {
        throw new Error("Vault must be unlocked to regenerate your recovery key.");
      }
      const check = await deriveVerifier(currentPassphrase, verifierSalt);
      if (!timingSafeEqualStr(check, verifier)) {
        throw new Error("Current passphrase is incorrect.");
      }
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
    [userId, kdfSalt, verifier, verifierSalt, key],
  );

  const resetVaultAndSetup = useCallback(
    async (newPassphrase: string): Promise<{ key: CryptoKey; recoveryKey: string }> => {
      const latestLockout = await fetchVaultLockoutStatus(userId);
      setLockoutStatus(latestLockout);
      if (latestLockout.lockedUntil > Date.now()) {
        const waitLabel = formatLockoutCountdown(latestLockout.lockedUntil - Date.now());
        throw new Error(`Your vault is temporarily locked. Try again in ${waitLabel}.`);
      }
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

      await reportVaultUnlockSucceeded(userId, newVerifier).catch(() => {});
      clearCachedLocalLockoutStatus(userId);
      setLockoutStatus(createDefaultLockoutStatus());
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
    [userId, qc],
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
      lockoutStatus,
      refreshLockoutStatus,
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
      lockoutStatus,
      refreshLockoutStatus,
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
