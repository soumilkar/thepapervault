import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

export function useBrowserDraft<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(initialValue);
  const [ready, setReady] = useState(false);
  const skipNextWrite = useRef(false);

  useEffect(() => {
    setReady(false);
    skipNextWrite.current = false;
    try {
      const saved = window.localStorage.getItem(key);
      if (saved) setValue(JSON.parse(saved) as T);
    } catch {
      // Drafts are a convenience; an unavailable or malformed browser value is ignored.
    }
    setReady(true);
  }, [key]);

  useEffect(() => {
    if (!ready) return;
    if (skipNextWrite.current) {
      skipNextWrite.current = false;
      return;
    }
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Ignore storage quota and privacy-mode errors without interrupting writing.
    }
  }, [key, ready, value]);

  const clear = () => {
    skipNextWrite.current = true;
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Ignore storage errors; the in-memory form is still cleared.
    }
    setValue(initialValue);
  };

  return [value, setValue as Dispatch<SetStateAction<T>>, clear, ready] as const;
}