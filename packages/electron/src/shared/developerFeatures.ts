/**
 * Developer Feature Registry
 *
 * Central registry for features that are only available in Developer Mode.
 * Similar to alphaFeatures.ts, but these features are gated by the developerMode setting.
 *
 * To add a new developer feature:
 * 1. Add an entry to DEVELOPER_FEATURES with a unique tag, display name, and description
 * 2. Use isDeveloperFeatureEnabled('your-tag') or the Jotai atom to check availability
 */

export interface DeveloperFeatureDefinition {
  /** Unique identifier for this feature (used in storage and checks) */
  tag: string;
  /** Human-readable display name */
  name: string;
  /** Description of what this feature does */
  description: string;
  /** Icon name for the settings UI */
  icon?: string;
}

/**
 * Complete registry of developer features.
 * ALL developer features must be registered here.
 */
export const DEVELOPER_FEATURES: readonly DeveloperFeatureDefinition[] = [
  {
    tag: 'worktrees',
    name: 'Git Worktrees',
    description: 'Create isolated git worktrees for AI coding sessions.',
    icon: 'account_tree',
  },
  {
    tag: 'terminal',
    name: 'Terminal',
    description: 'Access to an integrated terminal panel.',
    icon: 'terminal',
  },
] as const;

/**
 * Type-safe feature tags derived from the registry.
 */
export type DeveloperFeatureTag = typeof DEVELOPER_FEATURES[number]['tag'];

/**
 * Get the default enabled state for all developer features (all enabled by default).
 * When developer mode is on, all features are available by default.
 */
export function getDefaultDeveloperFeatures(): Record<DeveloperFeatureTag, boolean> {
  return DEVELOPER_FEATURES.reduce((acc, feature) => {
    acc[feature.tag] = true;
    return acc;
  }, {} as Record<DeveloperFeatureTag, boolean>);
}

/**
 * Check if all developer features are enabled.
 */
export function areAllDeveloperFeaturesEnabled(features: Record<DeveloperFeatureTag, boolean>): boolean {
  return DEVELOPER_FEATURES.every(feature => features[feature.tag] === true);
}

/**
 * Enable all developer features.
 */
export function enableAllDeveloperFeatures(): Record<DeveloperFeatureTag, boolean> {
  return getDefaultDeveloperFeatures();
}

/**
 * Disable all developer features.
 */
export function disableAllDeveloperFeatures(): Record<DeveloperFeatureTag, boolean> {
  return DEVELOPER_FEATURES.reduce((acc, feature) => {
    acc[feature.tag] = false;
    return acc;
  }, {} as Record<DeveloperFeatureTag, boolean>);
}

/**
 * Get feature definition by tag.
 * Returns undefined if tag is not found in registry.
 */
export function getDeveloperFeatureDefinition(tag: string): DeveloperFeatureDefinition | undefined {
  return DEVELOPER_FEATURES.find(f => f.tag === tag);
}

/**
 * Validate that all provided feature tags are registered.
 * Useful for catching typos or unregistered features during development.
 */
export function validateDeveloperFeatureTags(tags: string[]): { valid: boolean; unknown: string[] } {
  const knownTags = new Set(DEVELOPER_FEATURES.map(f => f.tag));
  const unknown = tags.filter(tag => !knownTags.has(tag));
  return {
    valid: unknown.length === 0,
    unknown,
  };
}
