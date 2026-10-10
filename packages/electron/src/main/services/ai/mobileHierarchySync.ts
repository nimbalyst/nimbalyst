import type { SyncProvider } from '@nimbalyst/runtime/sync';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { publishCanonicalHierarchy } from '../sync/sessionHierarchyPublication';
import { getLocalHostDeviceId } from './sessionHostAttribution';
import { SESSION_NOT_HOSTED } from '../sessionHierarchySyncStore';
import { logger } from '../../utils/logger';

/** Registration also receives verified bootstrap rows from the runtime dispatcher. */
export function registerMobileHierarchyAuthority(provider: SyncProvider): () => void {
  let active = true;
  const unsubscribe = provider.onHierarchySnapshot?.(async (entries, snapshotIsCurrent) => {
    const isCurrent = () => active && snapshotIsCurrent();
    const rows = entries.filter(entry => entry.parentSessionId !== undefined
      && (!entry.hostDeviceId || entry.hostDeviceId === getLocalHostDeviceId()))
      .map(entry => ({ sessionId: entry.sessionId, parentSessionId: entry.parentSessionId!,
        ...(entry.createdBySessionId !== undefined ? { createdBySessionId: entry.createdBySessionId } : {}) }));
    const store = AISessionsRepository.getStore();
    if (!isCurrent() || !rows.length || !store.applyRemoteHierarchySnapshot) return;
    // The store validates the final graph and checks freshness inside its write
    // lane. It also protects/acknowledges durable local intent transactionally.
    const results = await store.applyRemoteHierarchySnapshot(rows, isCurrent);
    const proposed = new Map(rows.map(row => [row.sessionId, row]));
    for (const result of results) {
      if (!isCurrent()) return;
      const incoming = proposed.get(result.sessionId);
      // The index carries every device's sessions; one we do not have is not a rejected move.
      if (!incoming || result.error === SESSION_NOT_HOSTED) continue;
      if (!result.accepted || result.parentSessionId !== incoming.parentSessionId
        || result.createdBySessionId !== incoming.createdBySessionId) {
        await publishCanonicalHierarchy(result.sessionId, isCurrent);
      }
      if (!result.accepted) logger.main.warn('[MobileSync] Session move rejected:', result.error);
    }
  });
  return () => { active = false; unsubscribe?.(); };
}
