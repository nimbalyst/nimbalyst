import Store from '../utils/privateSettingsStore';
import {
  recordUsageWeekSamples,
  type UsageWeekRecord,
  type UsageWeekSample,
} from '../../shared/usageHistory';

interface UsageHistoryFile {
  weeks: UsageWeekRecord[];
}

/**
 * Persists weekly usage-meter readings so past weeks survive restarts.
 * Kept forever; one small record per meter per week.
 */
class UsageHistoryStore {
  private store: Store<UsageHistoryFile> | null = null;

  // Lazy so the store is not created (app.getPath) at import time.
  private getStore(): Store<UsageHistoryFile> {
    if (!this.store) {
      this.store = new Store<UsageHistoryFile>({ name: 'usage-history', defaults: { weeks: [] } });
    }
    return this.store;
  }

  /** Records the samples and returns this provider's history (meters starting with `${provider}:`). */
  record(provider: 'claude' | 'codex', samples: UsageWeekSample[], now = Date.now()): UsageWeekRecord[] {
    const store = this.getStore();
    const stored = store.get('weeks');
    let weeks = Array.isArray(stored) ? stored : [];
    if (samples.length > 0) {
      weeks = recordUsageWeekSamples(weeks, samples, now);
      store.set('weeks', weeks);
    }
    return weeks.filter(week => week.meter.startsWith(`${provider}:`));
  }
}

export const usageHistoryStore = new UsageHistoryStore();
