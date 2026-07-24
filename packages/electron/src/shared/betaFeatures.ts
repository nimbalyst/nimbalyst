/**
 * Beta Feature Registry
 *
 * Central registry for all beta features that can be individually toggled.
 * Unlike alpha features (hidden behind release channel), beta features are
 * always visible in Settings > Advanced > Beta Features.
 *
 * To add a new beta feature:
 * 1. Add an entry to BETA_FEATURES with a unique tag, display name, and description
 * 2. Use useBetaFeature('your-tag') hook to check if the feature is enabled
 */

export interface BetaFeatureDefinition {
  /** Unique identifier for this feature (used in storage and checks) */
  tag: string;
  /** Human-readable display name */
  name: string;
  /** Description of what this feature does */
  description: string;
  /** Icon name for the settings UI (Material Symbols) */
  icon?: string;
}

/**
 * Complete registry of beta features.
 * ALL beta features must be registered here.
 */
export const BETA_FEATURES: readonly BetaFeatureDefinition[] = [
] as const;

/**
 * Type-safe feature tags derived from the registry.
 */
export type BetaFeatureTag = typeof BETA_FEATURES[number]['tag'];

/**
 * Get the default enabled state for all beta features (all disabled).
 */
export function getDefaultBetaFeatures(): Record<BetaFeatureTag, boolean> {
  return BETA_FEATURES.reduce((acc, feature) => {
    acc[feature.tag] = false;
    return acc;
  }, {} as Record<BetaFeatureTag, boolean>);
}

/**
 * Check if all beta features are enabled.
 */
export function areAllBetaFeaturesEnabled(features: Record<BetaFeatureTag, boolean>): boolean {
  return BETA_FEATURES.every(feature => features[feature.tag] === true);
}

/**
 * Enable all beta features.
 */
export function enableAllBetaFeatures(): Record<BetaFeatureTag, boolean> {
  return BETA_FEATURES.reduce((acc, feature) => {
    acc[feature.tag] = true;
    return acc;
  }, {} as Record<BetaFeatureTag, boolean>);
}

/**
 * Disable all beta features.
 */
export function disableAllBetaFeatures(): Record<BetaFeatureTag, boolean> {
  return getDefaultBetaFeatures();
}

/**
 * Get feature definition by tag.
 */
export function getBetaFeatureDefinition(tag: string): BetaFeatureDefinition | undefined {
  return BETA_FEATURES.find(f => f.tag === tag);
}
