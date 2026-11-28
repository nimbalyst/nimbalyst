import { useMemo, useSyncExternalStore } from 'react';

/** Dispatched on `window` by the host after it changes the code font CSS variables. */
export const CODE_FONT_CHANGED_EVENT = 'nim:code-font-changed';

const DEFAULT_FONT_FAMILY = "'SF Mono', 'Monaco', 'Menlo', 'Consolas', monospace";
const DEFAULT_FONT_SIZE = 14;

export interface CodeFont {
  fontFamily: string;
  fontSize: number;
}

// One string per read, so useSyncExternalStore can compare snapshots by value.
function readSnapshot(): string {
  if (typeof document === 'undefined') return '';
  const style = getComputedStyle(document.documentElement);
  const size = style.getPropertyValue('--nim-code-font-size').trim();
  const family = style.getPropertyValue('--nim-code-font-family').trim();
  return `${size}\n${family}`;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CODE_FONT_CHANGED_EVENT, onChange);
  return () => window.removeEventListener(CODE_FONT_CHANGED_EVENT, onChange);
}

/**
 * The code font set by the host through `--nim-code-font-family` and
 * `--nim-code-font-size` on the document root. Hosts that set neither get the defaults.
 */
export function useCodeFont(): CodeFont {
  const snapshot = useSyncExternalStore(subscribe, readSnapshot, () => '');
  return useMemo(() => {
    const [size = '', family = ''] = snapshot.split('\n');
    const parsed = Number.parseInt(size, 10);
    return {
      fontFamily: family || DEFAULT_FONT_FAMILY,
      fontSize: Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FONT_SIZE,
    };
  }, [snapshot]);
}
