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
  deriveDataKey,
  deriveVerifier,
  randomBytes,
  timingSafeEqualStr,
  toB64,
} from "@/lib/crypto";
import { clearOfflineBlobUrls } from "@/lib/offline-supabase";

type VaultStatus = "loading" | "needs_setup" | "locked" | "unlocked";

type VaultContextValue = {
  status: VaultStatus;
  key: CryptoKey | null;
  setup: (passphrase: string) => Promise<CryptoKey>;
  unlock: (passphrase: string) => Promise<CryptoKey>;
  lock: () => void;
};

const IDLE_LOCK_MS = 15 * 60 * 1000; // 15 minutes of inactivity auto-locks the vault

const VaultContext = createContext<VaultContextValue | null>(null);

const VAULT_META_PREFIX = "papervault:vault_meta:";

function getCachedVaultMeta(
  userId: string,
): { kdf_salt: string; verifier: string; verifier_salt: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`${VAULT_META_PREFIX}${userId}`);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return null;
}

function cacheVaultMeta(
  userId: string,
  meta: { kdf_salt: string; verifier: string; verifier_salt: string },
) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${VAULT_META_PREFIX}${userId}`, JSON.stringify(meta));
  } catch {
    // ignore
  }
}

export function VaultProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const qc = useQueryClient();
  const initialCached = getCachedVaultMeta(userId);
  const [status, setStatus] = useState<VaultStatus>(initialCached ? "locked" : "loading");
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [kdfSalt, setKdfSalt] = useState<string | null>(initialCached?.kdf_salt ?? null);
  const [verifier, setVerifier] = useState<string | null>(initialCached?.verifier ?? null);
  const [verifierSalt, setVerifierSalt] = useState<string | null>(
    initialCached?.verifier_salt ?? null,
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // If we already have cached meta, status is locked and user can unlock offline immediately
      const cached = getCachedVaultMeta(userId);
      if (cached) {
        setKdfSalt(cached.kdf_salt);
        setVerifier(cached.verifier);
        setVerifierSalt(cached.verifier_salt);
        setStatus("locked");
      }

      try {
        let { data, error } = await supabase
          .from("vault_keys")
          .select("*")
          .eq("user_id", userId)
          .maybeSingle();
        if (cancelled) return;

        // If transient error and no cache, retry once after 1.5s
        if (error && !cached) {
          await new Promise((r) => setTimeout(r, 1500));
          if (cancelled) return;
          const retry = await supabase
            .from("vault_keys")
            .select("*")
            .eq("user_id", userId)
            .maybeSingle();
          data = retry.data;
          error = retry.error;
        }

        if (cancelled) return;

        if (data) {
          setKdfSalt(data.kdf_salt);
          setVerifier(data.verifier);
          setVerifierSalt(data.verifier_salt);
          cacheVaultMeta(userId, {
            kdf_salt: data.kdf_salt,
            verifier: data.verifier,
            verifier_salt: data.verifier_salt,
          });
          setStatus("locked");
          return;
        }

        if (cached) {
          setStatus("locked");
          return;
        }

        if (!error) {
          setStatus("needs_setup");
        } else {
          // If error happened and no cache, wait or fallback
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
  }, [userId]);

  const setup = useCallback(
    async (passphrase: string): Promise<CryptoKey> => {
      if (passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
      const newKdfSalt = toB64(randomBytes(16));
      const newVerifierSalt = toB64(randomBytes(16));
      const newVerifier = await deriveVerifier(passphrase, newVerifierSalt);
      const dataKey = await deriveDataKey(passphrase, newKdfSalt);
      cacheVaultMeta(userId, {
        kdf_salt: newKdfSalt,
        verifier: newVerifier,
        verifier_salt: newVerifierSalt,
      });
      const { error } = await supabase.from("vault_keys").insert({
        user_id: userId,
        kdf_salt: newKdfSalt,
        verifier: newVerifier,
        verifier_salt: newVerifierSalt,
      });
      if (error) throw error;
      setKdfSalt(newKdfSalt);
      setVerifier(newVerifier);
      setVerifierSalt(newVerifierSalt);
      setKey(dataKey);
      setStatus("unlocked");
      return dataKey;
    },
    [userId],
  );

  const unlock = useCallback(
    async (passphrase: string): Promise<CryptoKey> => {
      if (!kdfSalt || !verifier || !verifierSalt) throw new Error("Vault not initialized");
      const check = await deriveVerifier(passphrase, verifierSalt);
      if (!timingSafeEqualStr(check, verifier)) throw new Error("Wrong passphrase");
      const dataKey = await deriveDataKey(passphrase, kdfSalt);
      setKey(dataKey);
      setStatus("unlocked");
      return dataKey;
    },
    [kdfSalt, verifier, verifierSalt],
  );

  const lock = useCallback(() => {
    setKey(null);
    setStatus(kdfSalt ? "locked" : "needs_setup");
    // Wipe all decrypted data from React Query memory cache immediately on lock
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
    () => ({ status, key, setup, unlock, lock }),
    [status, key, setup, unlock, lock],
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault() {
  const v = useContext(VaultContext);
  if (!v) throw new Error("useVault must be used within VaultProvider");
  return v;
}

// Throws if the vault is locked. Use inside mutations to fail fast with a helpful message.
export function useVaultKey(): CryptoKey {
  const { key } = useVault();
  if (!key) throw new Error("Your vault is locked. Unlock it to continue.");
  return key;
}
