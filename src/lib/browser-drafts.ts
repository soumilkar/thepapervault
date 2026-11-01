import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useVault } from "@/lib/vault";
import { decryptText, encryptText } from "@/lib/crypto";

// Drafts are stored in localStorage encrypted with the vault key (AES-GCM).
// Without an unlocked vault nothing is read or written.
export function useBrowserDraft<T>(storageKey: string, initialValue: T) {
  const { key } = useVault();
  const [value, setValue] = useState<T>(initialValue);
  const [ready, setReady] = useState(false);
  const skipNextWrite = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    skipNextWrite.current = false;
    if (!key) return;
    (async () => {
      try {
        const saved = window.localStorage.getItem(storageKey);
        if (saved) {
          const parsed = JSON.parse(saved) as { ct?: string; iv?: string };
          if (parsed && typeof parsed === "object" && parsed.ct && parsed.iv) {
            const plain = await decryptText(key, parsed.ct, parsed.iv);
            if (!cancelled) setValue(JSON.parse(plain) as T);
          } else {
            // Legacy unencrypted draft: drop it from storage, keep it in memory so it is re-saved encrypted.
            window.localStorage.removeItem(storageKey);
            if (!cancelled) setValue(parsed as T);
          }
        }
      } catch {
        // Unreadable drafts are ignored.
      }
      if (!cancelled) setReady(true);
    })();
    return () => { cancelled = true; };
  }, [storageKey, key]);

  useEffect(() => {
    if (!ready || !key) return;
    if (skipNextWrite.current) {
      skipNextWrite.current = false;
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const { ct, iv } = await encryptText(key, JSON.stringify(value));
        if (!cancelled) window.localStorage.setItem(storageKey, JSON.stringify({ ct, iv }));
      } catch {
        // Ignore storage quota and privacy-mode errors.
      }
    }, 300);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [storageKey, ready, value, key]);

  const clear = () => {
    skipNextWrite.current = true;
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
    setValue(initialValue);
  };

  return [value, setValue as Dispatch<SetStateAction<T>>, clear, ready] as const;
}
