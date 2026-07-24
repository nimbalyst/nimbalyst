import Store from 'electron-store';
import { app } from 'electron';

/**
 * Features that we track for first-time usage
 */
export type TrackedFeature =
  | 'ai_chat'
  | 'workspace'
  | 'excalidraw'
  | 'tracker'
  | 'attachments'
  | 'table'
  | 'code_block'
  | 'theme_changed';

interface FeatureTrackingStore {
  installDate?: string;
  featuresUsed: Record<TrackedFeature, string | undefined>; // timestamp of first use
}

/**
 * Service for tracking first-time feature usage.
 * Used to power analytics events about feature discovery and adoption.
 */
export class FeatureTrackingService {
  private static instance: FeatureTrackingService;
  private store: Store<FeatureTrackingStore>;

  private constructor() {
    this.store = new Store<FeatureTrackingStore>({
      name: 'feature-tracking',
      defaults: {
        installDate: new Date().toISOString(),
        featuresUsed: {} as Record<TrackedFeature, string | undefined>,
      },
    });
  }

  public static getInstance(): FeatureTrackingService {
    if (!this.instance) {
      this.instance = new FeatureTrackingService();
    }
    return this.instance;
  }

  /**
   * Check if this is the first time a feature has been used.
   * If it is, records the timestamp.
   * @returns true if this is the first use, false otherwise
   */
  public isFirstUse(feature: TrackedFeature): boolean {
    const featuresUsed = this.store.get('featuresUsed') || {};

    if (featuresUsed[feature]) {
      return false;
    }

    // First use - record the timestamp
    featuresUsed[feature] = new Date().toISOString();
    this.store.set('featuresUsed', featuresUsed);
    return true;
  }

  /**
   * Get the number of days since the app was first installed.
   * Returns bucketed values for anonymity.
   */
  public getDaysSinceInstall(): string {
    const installDate = this.store.get('installDate');
    if (!installDate) {
      return '0-7'; // Default bucket
    }

    const days = Math.floor(
      (Date.now() - new Date(installDate).getTime()) / (1000 * 60 * 60 * 24)
    );

    if (days < 7) return '0-7';
    if (days < 30) return '7-30';
    if (days < 90) return '30-90';
    if (days < 180) return '90-180';
    return '180+';
  }

  /**
   * Get the timestamp of when a feature was first used
   */
  public getFirstUseTimestamp(feature: TrackedFeature): string | undefined {
    const featuresUsed = this.store.get('featuresUsed') || {};
    return featuresUsed[feature];
  }

  /**
   * Check if a feature has ever been used
   */
  public hasBeenUsed(feature: TrackedFeature): boolean {
    const featuresUsed = this.store.get('featuresUsed') || {};
    return !!featuresUsed[feature];
  }
}
