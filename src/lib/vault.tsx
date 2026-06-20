import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { deriveDataKey, deriveVerifier, randomBytes, toB64 } from "@/lib/crypto";

type VaultStatus = "loading" | "needs_setup" | "locked" | "unlocked";

type VaultContextValue = {
  status: VaultStatus;
  key: CryptoKey | null;
  setup: (passphrase: string) => Promise<void>;
  unlock: (passphrase: string) => Promise<void>;
  lock: () => void;
};

const VaultContext = createContext<VaultContextValue | null>(null);

export function VaultProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [status, setStatus] = useState<VaultStatus>("loading");
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [kdfSalt, setKdfSalt] = useState<string | null>(null);
  const [verifier, setVerifier] = useState<string | null>(null);
  const [verifierSalt, setVerifierSalt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("vault_keys" as never).select("*").eq("user_id", userId).maybeSingle();
      if (cancelled) return;
      if (!data) {
        setStatus("needs_setup");
        return;
      }
      // @ts-expect-error generated types may lag the migration
      setKdfSalt(data.kdf_salt);
      // @ts-expect-error generated types may lag the migration
      setVerifier(data.verifier);
      // @ts-expect-error generated types may lag the migration
      setVerifierSalt(data.verifier_salt);
      setStatus("locked");
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const setup = useCallback(async (passphrase: string) => {
    if (passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
    const newKdfSalt = toB64(randomBytes(16));
    const newVerifierSalt = toB64(randomBytes(16));
    const newVerifier = await deriveVerifier(passphrase, newVerifierSalt);
    const dataKey = await deriveDataKey(passphrase, newKdfSalt);
    const { error } = await supabase.from("vault_keys" as never).insert({
      user_id: userId,
      kdf_salt: newKdfSalt,
      verifier: newVerifier,
      verifier_salt: newVerifierSalt,
    } as never);
    if (error) throw error;
    setKdfSalt(newKdfSalt);
    setVerifier(newVerifier);
    setVerifierSalt(newVerifierSalt);
    setKey(dataKey);
    setStatus("unlocked");
  }, [userId]);

  const unlock = useCallback(async (passphrase: string) => {
    if (!kdfSalt || !verifier || !verifierSalt) throw new Error("Vault not initialized");
    const check = await deriveVerifier(passphrase, verifierSalt);
    if (check !== verifier) throw new Error("Wrong passphrase");
    const dataKey = await deriveDataKey(passphrase, kdfSalt);
    setKey(dataKey);
    setStatus("unlocked");
  }, [kdfSalt, verifier, verifierSalt]);

  const lock = useCallback(() => {
    setKey(null);
    setStatus(kdfSalt ? "locked" : "needs_setup");
  }, [kdfSalt]);

  const value = useMemo(() => ({ status, key, setup, unlock, lock }), [status, key, setup, unlock, lock]);
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
