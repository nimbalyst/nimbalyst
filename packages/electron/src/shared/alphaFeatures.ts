/**
 * Alpha Feature Registry
 *
 * Central registry for alpha features that can be individually toggled.
 * Features are available to all users regardless of release channel and default to disabled.
 *
 * To add a new alpha feature:
 * 1. Add an entry to ALPHA_FEATURES with a unique tag, display name, and description
 * 2. Use useAlphaFeature('your-tag') (renderer) or check via the alpha-features IPC (main)
 */

export interface AlphaFeatureDefinition {
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
 * Complete registry of alpha features.
 * ALL alpha features must be registered here.
 */
export const ALPHA_FEATURES: readonly AlphaFeatureDefinition[] = [
  {
    tag: "super-loops",
    name: "Super Loops",
    description:
      "Enable Super Loops for iterative agent workflows in dedicated worktrees.",
    icon: "sync",
  },
  {
    tag: "blitz",
    name: "Blitz",
    description:
      "Run the same prompt on multiple isolated worktrees to make more than one attempt at a task.",
    icon: "bolt",
  },
  {
    tag: "meta-agent",
    name: "Meta Agent",
    description:
      "Enable meta-agent sessions that orchestrate and delegate work to child sessions.",
    icon: "hub",
  },
] as const;

/**
 * Type-safe feature tags derived from the registry.
 */
export type AlphaFeatureTag = (typeof ALPHA_FEATURES)[number]["tag"];

/**
 * Get the default enabled state for all alpha features (all disabled).
 */
export function getDefaultAlphaFeatures(): Record<AlphaFeatureTag, boolean> {
  return ALPHA_FEATURES.reduce((acc, feature) => {
    acc[feature.tag] = false;
    return acc;
  }, {} as Record<AlphaFeatureTag, boolean>);
}

/**
 * Get feature definition by tag.
 * Throws if tag is not found in registry (enforces explicit registration).
 */
export function getAlphaFeatureDefinition(
  tag: string
): AlphaFeatureDefinition | undefined {
  return ALPHA_FEATURES.find((f) => f.tag === tag);
}

/**
 * Validate that all provided feature tags are registered.
 * Useful for catching typos or unregistered features during development.
 */
export function validateAlphaFeatureTags(tags: string[]): {
  valid: boolean;
  unknown: string[];
} {
  const knownTags = new Set(ALPHA_FEATURES.map((f) => f.tag));
  const unknown = tags.filter((tag) => !knownTags.has(tag));
  return {
    valid: unknown.length === 0,
    unknown,
  };
}
