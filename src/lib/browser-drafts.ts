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
  const userTouchedRef = useRef(false);

  const initialRef = useRef<T>(initialValue);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    skipNextWrite.current = false;
    userTouchedRef.current = false;
    if (!key) {
      setValue(initialRef.current);
      return;
    }
    (async () => {
      try {
        const saved = window.localStorage.getItem(storageKey);
        if (saved && !userTouchedRef.current) {
          const parsed = JSON.parse(saved) as { ct?: string; iv?: string };
          if (parsed && typeof parsed === "object" && parsed.ct && parsed.iv) {
            const plain = await decryptText(key, parsed.ct, parsed.iv);
            if (!cancelled && !userTouchedRef.current) {
              setValue(JSON.parse(plain) as T);
            }
          } else {
            // Legacy unencrypted draft: remove plaintext immediately and write encrypted version
            window.localStorage.removeItem(storageKey);
            const enc = await encryptText(key, JSON.stringify(parsed));
            if (!cancelled && !userTouchedRef.current) {
              window.localStorage.setItem(storageKey, JSON.stringify(enc));
              setValue(parsed as T);
            }
          }
        }
      } catch {
        // Unreadable drafts are ignored.
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
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
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [storageKey, ready, value, key]);

  const updateValue: Dispatch<SetStateAction<T>> = (next) => {
    userTouchedRef.current = true;
    setValue(next);
  };

  const clear = () => {
    userTouchedRef.current = true;
    skipNextWrite.current = true;
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
    setValue(initialRef.current);
  };

  return [value, updateValue, clear, ready] as const;
}
