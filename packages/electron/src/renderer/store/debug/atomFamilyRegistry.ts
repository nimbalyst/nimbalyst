/**
 * Tracked atomFamily wrapper for debug monitoring.
 *
 * Usage: import { atomFamily } from '../debug/atomFamilyRegistry' instead of 'jotai/utils'.
 * Every atomFamily created through this wrapper is automatically registered and its
 * live instance count can be inspected via Developer > AtomFamily Stats.
 *
 * The atom name is resolved lazily from jotai's debugLabel (if a debug plugin is active)
 * or extracted from the call-site stack trace.
 */
import { atomFamily as originalAtomFamily } from 'jotai/utils';

interface FamilyEntry {
  family: { getParams(): Iterable<unknown>; debugLabel?: string };
  file: string;
}

const registry: FamilyEntry[] = [];

/**
 * Extract source file name from the call-site stack trace.
 * Looks for patterns like `/atoms/sessions.ts` in the stack.
 */
function extractFile(stack: string): string {
  const lines = stack.split('\n');
  // Skip "Error" line, "atomFamily" wrapper frame -> caller is typically line 2 or 3
  for (let i = 2; i < Math.min(lines.length, 6); i++) {
    const line = lines[i];
    const match = line.match(/\/atoms\/([^:?]+)/);
    if (match) return match[1];
  }
  return '(unknown)';
}

/**
 * Drop-in replacement for jotai's atomFamily that auto-registers for debug tracking.
 * Signature matches the original so it works as a direct import swap.
 */
export const atomFamily: typeof originalAtomFamily = (initializeAtom, areEqual?) => {
  const family = originalAtomFamily(initializeAtom, areEqual);

  let file = '(unknown)';
  try {
    file = extractFile(new Error().stack || '');
  } catch { /* ignore */ }

  registry.push({ family, file });

  return family;
};

/**
 * Get live instance counts for all registered atomFamilies.
 * Returns sorted by count descending.
 */
export function getAtomFamilyStats(): { name: string; count: number; file: string; params: string[] }[] {
  return registry
    .map(({ family, file }) => {
      // Prefer jotai's debugLabel if set (via babel/SWC plugin), otherwise use "(unnamed)"
      const name = family.debugLabel || '(unnamed)';
      const params = [...family.getParams()].map(String);
      return { name, count: params.length, file, params };
    })
    .sort((a, b) => b.count - a.count);
}

// Expose on window for executeJavaScript access from main process
if (typeof window !== 'undefined') {
  (window as any).__atomFamilyStats = getAtomFamilyStats;
}
