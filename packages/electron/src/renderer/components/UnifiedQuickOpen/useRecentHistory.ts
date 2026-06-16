/**
 * Hook for a small, globally persisted "recent values" list.
 *
 * Reads once on mount from `app-settings:get <key>`, writes debounced.
 * Used by the unified quick-open filter chips (file-extension, tracker-type).
 */
import { useEffect, useRef, useState, useCallback } from 'react';

const MAX_ENTRIES = 10;
const PERSIST_DEBOUNCE_MS = 400;

export function useRecentHistory(storageKey: string): {
  history: string[];
  remember: (value: string) => void;
  forget: (value: string) => void;
} {
  const [history, setHistory] = useState<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const api = (window as any).electronAPI;
    if (!api?.invoke) return;
    api
      .invoke('app-settings:get', storageKey)
      .then((value: unknown) => {
        if (cancelled) return;
        if (Array.isArray(value)) {
          const cleaned = value.filter((v): v is string => typeof v === 'string').slice(0, MAX_ENTRIES);
          setHistory(cleaned);
          latestRef.current = cleaned;
        }
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  // Clear any pending debounced persist on unmount so the timer can't fire
  // after the component (or, in tests, the environment) is torn down.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const schedulePersist = useCallback(
    (next: string[]) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        const api = (window as any).electronAPI;
        if (!api?.invoke) return;
        api.invoke('app-settings:set', storageKey, next).catch(() => {
          /* ignore */
        });
      }, PERSIST_DEBOUNCE_MS);
    },
    [storageKey],
  );

  const remember = useCallback(
    (value: string) => {
      const v = value.trim();
      if (!v) return;
      const next = [v, ...latestRef.current.filter((e) => e !== v)].slice(0, MAX_ENTRIES);
      latestRef.current = next;
      setHistory(next);
      schedulePersist(next);
    },
    [schedulePersist],
  );

  const forget = useCallback(
    (value: string) => {
      const next = latestRef.current.filter((e) => e !== value);
      latestRef.current = next;
      setHistory(next);
      schedulePersist(next);
    },
    [schedulePersist],
  );

  return { history, remember, forget };
}
