/**
 * useBetaFeature Hook
 *
 * Convenience hook for checking if a beta feature is enabled.
 * This is the recommended way to check beta feature availability in components.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const isBlitzEnabled = useBetaFeature('blitz');
 *
 *   if (!isBlitzEnabled) {
 *     return null;
 *   }
 *
 *   return <BlitzPanel />;
 * }
 * ```
 */

import { useMemo } from 'react';
import { useAtomValue, atom, type Atom } from 'jotai';
import { betaFeatureEnabledAtom } from '../store/atoms/appSettings';
import type { BetaFeatureTag } from '../../shared/betaFeatures';

/**
 * Check if a beta feature is enabled.
 *
 * @param tag - The feature tag to check (must be registered in betaFeatures.ts)
 * @returns true if the feature is enabled, false otherwise
 */
export function useBetaFeature(tag: BetaFeatureTag): boolean {
  const enabledAtom = betaFeatureEnabledAtom(tag);
  return useAtomValue(enabledAtom);
}

/**
 * Check if multiple beta features are enabled.
 *
 * Note: This hook creates a derived atom that reads all requested features at once.
 * The tags array should be stable (defined outside component or memoized) to avoid
 * creating new atoms on every render.
 */

// Cache for multi-feature atoms keyed by sorted tag string
const multiBetaFeatureAtomCache = new Map<string, Atom<Record<string, boolean>>>();

export function useBetaFeatures(tags: BetaFeatureTag[]): Record<BetaFeatureTag, boolean> {
  // Create a stable key from sorted tags
  const cacheKey = useMemo(() => [...tags].sort().join(','), [tags]);

  // Get or create the combined atom
  const combinedAtom = useMemo((): Atom<Record<string, boolean>> => {
    let cached = multiBetaFeatureAtomCache.get(cacheKey);
    if (!cached) {
      // Get all the individual feature atoms
      const featureAtoms = tags.map(tag => ({ tag, featureAtom: betaFeatureEnabledAtom(tag) }));

      // Create a single derived atom that reads all features
      cached = atom((get) => {
        const result: Record<string, boolean> = {};
        for (const { tag, featureAtom } of featureAtoms) {
          result[tag] = get(featureAtom);
        }
        return result;
      });
      multiBetaFeatureAtomCache.set(cacheKey, cached);
    }
    return cached;
  }, [cacheKey, tags]);

  return useAtomValue(combinedAtom) as Record<BetaFeatureTag, boolean>;
}
