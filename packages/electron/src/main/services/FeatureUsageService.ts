import Store from 'electron-store';
import {
  FEATURE_USAGE_KEYS,
  type FeatureUsageRecord,
} from '../../shared/featureUsage';

interface FeatureUsageStore {
  installDate: string;
  features: Record<string, FeatureUsageRecord>;
}

/**
 * Read the install date from the existing FeatureTrackingService store
 * so we preserve the original install date rather than creating a new one.
 */
function resolveInstallDate(): string {
  try {
    const legacyStore = new Store<{ installDate?: string }>({ name: 'feature-tracking' });
    const existing = legacyStore.get('installDate');
    if (existing) return existing;
  } catch {
    // Fall through to default
  }
  return new Date().toISOString();
}

/**
 * Well-known feature keys. Extensible -- any string key works,
 * but these constants provide discoverability and typo prevention.
 */
export const FEATURES = FEATURE_USAGE_KEYS;

/**
 * Tracks feature usage counts with first/last timestamps.
 * Used for local UX decisions (tips, walkthroughs, onboarding nudges).
 * NOT connected to PostHog -- purely local persistence.
 */
export class FeatureUsageService {
  private static instance: FeatureUsageService;
  private store: Store<FeatureUsageStore>;

  private constructor() {
    this.store = new Store<FeatureUsageStore>({
      name: 'feature-usage',
      defaults: {
        installDate: resolveInstallDate(),
        features: {},
      },
    });
  }

  public static getInstance(): FeatureUsageService {
    if (!this.instance) {
      this.instance = new FeatureUsageService();
    }
    return this.instance;
  }

  /**
   * Record a usage event. Increments count, updates lastUsed,
   * sets firstUsed on first occurrence.
   */
  public recordUsage(feature: string): FeatureUsageRecord {
    const features = this.store.get('features') || {};
    const now = new Date().toISOString();
    const existing = features[feature];

    const record: FeatureUsageRecord = existing
      ? { count: existing.count + 1, firstUsed: existing.firstUsed, lastUsed: now }
      : { count: 1, firstUsed: now, lastUsed: now };

    features[feature] = record;
    this.store.set('features', features);
    return record;
  }

  /**
   * Get the usage record for a feature, or undefined if never used.
   */
  public getUsage(feature: string): FeatureUsageRecord | undefined {
    const features = this.store.get('features') || {};
    return features[feature];
  }

  /**
   * Get the usage count for a feature (0 if never used).
   */
  public getCount(feature: string): number {
    return this.getUsage(feature)?.count ?? 0;
  }

  /**
   * Check if a feature has ever been used.
   */
  public hasBeenUsed(feature: string): boolean {
    return this.getCount(feature) > 0;
  }

  /**
   * Check if usage count has reached a threshold.
   */
  public hasReachedCount(feature: string, threshold: number): boolean {
    return this.getCount(feature) >= threshold;
  }

  /**
   * Get all usage records.
   */
  public getAllUsage(): Record<string, FeatureUsageRecord> {
    return this.store.get('features') || {};
  }
}
