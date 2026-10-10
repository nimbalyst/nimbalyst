import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';

interface TypeaheadOption {
  label: string;
  keywords?: string;
}

/** Shared matching and query lifetime for the AI input's dropdown menus. */
export function useMenuTypeahead(isOpen: boolean) {
  const queryRef = useRef('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetTypeahead = useCallback(() => {
    queryRef.current = '';
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => resetTypeahead, [resetTypeahead]);
  useEffect(() => {
    if (!isOpen) resetTypeahead();
  }, [isOpen, resetTypeahead]);

  const getTypeaheadMatch = useCallback((event: KeyboardEvent, options: TypeaheadOption[]): number => {
    if (
      event.key.length !== 1 || event.key.trim() === ''
      || event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing
    ) return -1;

    event.preventDefault();
    queryRef.current += event.key.toLowerCase();
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(resetTypeahead, 700);

    const query = queryRef.current;
    let bestIndex = -1;
    let bestScore = Infinity;
    options.forEach(({ label, keywords = '' }, index) => {
      const name = label.toLowerCase();
      const searchable = `${name} ${keywords.toLowerCase()}`;
      const tokens = searchable.split(/[^a-z0-9]+/).filter(Boolean);
      const score = name.startsWith(query)
        ? 0
        : tokens.some(token => token.startsWith(query))
          ? 1
          : searchable.includes(query) ? 2 : Infinity;
      if (score < bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    });
    return bestIndex;
  }, [resetTypeahead]);

  return { getTypeaheadMatch, resetTypeahead };
}
