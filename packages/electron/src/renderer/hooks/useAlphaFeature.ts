/**
 * useAlphaFeature Hook
 *
 * Convenience hook for checking if an alpha feature is enabled.
 * This is the recommended way to check feature availability in components.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const isBlitzEnabled = useAlphaFeature('blitz');
 *
 *   if (!isBlitzEnabled) {
 *     return <div>Feature not available</div>;
 *   }
 *
 *   return <CollaborationFeature />;
 * }
 * ```
 */

import { useMemo } from 'react';
import { useAtomValue, atom, type Atom } from 'jotai';
import { alphaFeatureEnabledAtom } from '../store/atoms/appSettings';
import type { AlphaFeatureTag } from '../../shared/alphaFeatures';

/**
 * Check if an alpha feature is enabled.
 *
 * @param tag - The feature tag to check (must be registered in alphaFeatures.ts)
 * @returns true if the feature is enabled, false otherwise
 *
 * @throws TypeError in development if the tag is not registered
 */
export function useAlphaFeature(tag: AlphaFeatureTag): boolean {
  const enabledAtom = alphaFeatureEnabledAtom(tag);
  return useAtomValue(enabledAtom);
}

/**
 * Check if multiple alpha features are enabled.
 *
 * Note: This hook creates a derived atom that reads all requested features at once.
 * The tags array should be stable (defined outside component or memoized) to avoid
 * creating new atoms on every render.
 *
 * @example
 * ```tsx
 * const features = useAlphaFeatures(['blitz', 'super-loops']);
 * if (features.blitz) {
 *   // blitz is enabled
 * }
 * if (features['super-loops']) {
 *   // super-loops is enabled
 * }
 * ```
 */

// Cache for multi-feature atoms keyed by sorted tag string
const multiFeatureAtomCache = new Map<string, Atom<Record<string, boolean>>>();

export function useAlphaFeatures(tags: AlphaFeatureTag[]): Record<AlphaFeatureTag, boolean> {
  // Create a stable key from sorted tags
  const cacheKey = useMemo(() => [...tags].sort().join(','), [tags]);

  // Get or create the combined atom
  const combinedAtom = useMemo((): Atom<Record<string, boolean>> => {
    let cached = multiFeatureAtomCache.get(cacheKey);
    if (!cached) {
      // Get all the individual feature atoms
      const featureAtoms = tags.map(tag => ({ tag, featureAtom: alphaFeatureEnabledAtom(tag) }));

      // Create a single derived atom that reads all features
      cached = atom((get) => {
        const result: Record<string, boolean> = {};
        for (const { tag, featureAtom } of featureAtoms) {
          result[tag] = get(featureAtom);
        }
        return result;
      });
      multiFeatureAtomCache.set(cacheKey, cached);
    }
    return cached;
  }, [cacheKey, tags]);

  return useAtomValue(combinedAtom) as Record<AlphaFeatureTag, boolean>;
}
