import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DiffPeekPopover } from './DiffPeekPopover';

type DiffCacheEntry = {
  diff: string;
  isBinary: boolean;
  loading: boolean;
  error: string | null;
};

export interface UseDiffPeekOptions {
  /** Fetch the unified diff for a file. If undefined, peek is disabled. */
  getDiff?: (filePath: string) => Promise<{ unifiedDiff: string; isBinary: boolean } | null>;
  /** Persisted popover width (px). */
  width?: number;
  /** Persisted popover height (px). */
  height?: number;
  /** Called (debounced) when the user resizes the popover. */
  onResize?: (size: { width: number; height: number }) => void;
}

export interface UseDiffPeekResult {
  /** True when getDiff is provided. Use this to gate trigger UI. */
  peekSupported: boolean;
  /** Ref callback for the row container element (used to anchor the popover). */
  registerRowEl: (filePath: string, el: HTMLElement | null) => void;
  /** Click handler that toggles the pinned state for a file. */
  togglePeek: (filePath: string) => void;
  /** True when the popover is currently anchored to this file. */
  isActive: (filePath: string) => boolean;
  /** Pre-rendered popover. Render once inside the host component (returns null when nothing is active). */
  popoverElement: ReactNode;
}

/**
 * Encapsulates the diff peek state machine used by the git commit proposal widget,
 * the AgentMode Files Edited sidebar, and the git extension's changes panel.
 *
 * Callers render their own trigger button, attach `registerRowEl` to each row's
 * container, wire `togglePeek` to the click, and drop `popoverElement` somewhere
 * in their tree.
 */
export function useDiffPeek(options: UseDiffPeekOptions): UseDiffPeekResult {
  const { getDiff, width, height, onResize } = options;

  const [peekedFile, setPeekedFile] = useState<string | null>(null);
  const [pinnedFile, setPinnedFile] = useState<string | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const rowElsRef = useRef<Map<string, HTMLElement>>(new Map());
  const [diffCache, setDiffCache] = useState<Map<string, DiffCacheEntry>>(new Map());

  const peekSupported = typeof getDiff === 'function';
  const activeFile = peekedFile ?? pinnedFile;

  const registerRowEl = useCallback((filePath: string, el: HTMLElement | null) => {
    if (el) rowElsRef.current.set(filePath, el);
    else rowElsRef.current.delete(filePath);
  }, []);

  const togglePeek = useCallback((filePath: string) => {
    const rowEl = rowElsRef.current.get(filePath);
    if (rowEl) setAnchorRect(rowEl.getBoundingClientRect());
    setPinnedFile((prev) => (prev === filePath ? null : filePath));
    setPeekedFile(null);
  }, []);

  const closePeek = useCallback(() => {
    setPeekedFile(null);
    setPinnedFile(null);
    setAnchorRect(null);
  }, []);

  const promotePeekToPin = useCallback(() => {
    setPeekedFile((prev) => {
      if (prev) setPinnedFile(prev);
      return null;
    });
  }, []);

  const isActive = useCallback((filePath: string) => activeFile === filePath, [activeFile]);

  // Fetch the diff for whichever file is currently active. Cached per session.
  useEffect(() => {
    if (!activeFile || !getDiff) return;
    const cached = diffCache.get(activeFile);
    if (cached && !cached.loading) return;

    setDiffCache((prev) => {
      const next = new Map(prev);
      next.set(activeFile, { diff: '', isBinary: false, loading: true, error: null });
      return next;
    });

    let cancelled = false;
    getDiff(activeFile)
      .then((result) => {
        if (cancelled) return;
        setDiffCache((prev) => {
          const next = new Map(prev);
          if (result) {
            next.set(activeFile, {
              diff: result.unifiedDiff,
              isBinary: result.isBinary,
              loading: false,
              error: null,
            });
          } else {
            next.set(activeFile, {
              diff: '',
              isBinary: false,
              loading: false,
              error: 'Diff not available on this platform',
            });
          }
          return next;
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDiffCache((prev) => {
          const next = new Map(prev);
          next.set(activeFile, {
            diff: '',
            isBinary: false,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          });
          return next;
        });
      });

    return () => {
      cancelled = true;
    };
    // diffCache intentionally excluded — only refetch when activeFile changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile, getDiff]);

  const popoverElement = useMemo(() => {
    if (!activeFile || !anchorRect) return null;
    const cached = diffCache.get(activeFile);
    return (
      <DiffPeekPopover
        anchorRect={anchorRect}
        filePath={activeFile}
        mode={peekedFile ? 'peek' : 'pinned'}
        diff={cached?.diff ?? ''}
        isBinary={cached?.isBinary ?? false}
        loading={cached?.loading ?? true}
        error={cached?.error ?? null}
        onClose={closePeek}
        onPin={promotePeekToPin}
        width={width}
        height={height}
        onResize={onResize}
      />
    );
  }, [activeFile, anchorRect, diffCache, peekedFile, closePeek, promotePeekToPin, width, height, onResize]);

  return {
    peekSupported,
    registerRowEl,
    togglePeek,
    isActive,
    popoverElement,
  };
}
