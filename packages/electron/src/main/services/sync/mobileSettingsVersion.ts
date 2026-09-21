import { store } from '../../utils/store';
import { logger } from '../../utils/logger';

let lastVersion = 0;
const warned = new Set<string>();
function warnOnce(reason: string): void {
  if (warned.has(reason)) return;
  warned.add(reason);
  logger.main.warn(`[SyncManager] ${reason}`);
}

/** Persist before sending so a restart cannot reuse a published revision. */
export function nextMobileSettingsVersion(): number | undefined {
  try {
    const previous = store.get('mobileSettingsVersion');
    const valid = typeof previous === 'number' && Number.isSafeInteger(previous) && previous >= 0 && previous < Number.MAX_SAFE_INTEGER;
    if (previous !== undefined && !valid) warnOnce('Re-seeding invalid mobile settings version');
    // Epoch migration jumps over counters sent by older, non-persisting builds.
    // A process-local floor also protects a repair from moving backward in this run.
    const version = Math.max(lastVersion + 1, valid ? previous + 1 : Date.now());
    store.set('mobileSettingsVersion', version);
    warned.clear();
    lastVersion = version;
    return version;
  } catch {
    // Never send an unpersisted revision. The next settings edit/join/reconnect
    // retries the store write, including fire-and-forget credential listeners.
    warnOnce('Cannot persist mobile settings version; settings sync deferred until the next retry');
    return undefined;
  }
}
