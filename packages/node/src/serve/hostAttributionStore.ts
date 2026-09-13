/**
 * Stamp `metadata.hostDeviceId` on the way in, not after the fact.
 *
 * `hostDeviceId` is how every other device knows WHICH machine owns a session
 * and where a prompt for it should be routed. `SyncedSessionStore.create`
 * publishes its index entry from the payload it is handed, so a value written
 * afterwards is a second write racing the first -- and if it fails, or if the
 * process dies between the two, the session is published permanently
 * unattributed and the desktop offers it to nobody.
 *
 * This decorator therefore wraps the store OUTSIDE the synced one:
 *
 *     withHostAttribution(createSyncedSessionStore(base, provider), deviceId)
 *
 * so the attribution is already in `payload.metadata` when the synced store
 * builds its first push. Wrapping it the other way round would stamp the
 * database and miss the wire, which is the bug this exists to prevent.
 *
 * `updateMetadata` is stamped too: a caller that merges its own `metadata`
 * object would otherwise be able to drop the key, and a session that loses its
 * host attribution mid-life is as unroutable as one that never had it.
 */

import type {
  CreateSessionPayload,
  SessionStore,
  UpdateSessionMetadataPayload,
} from '@nimbalyst/runtime/ai/adapters/sessionStore';

export function withHostAttribution(store: SessionStore, hostDeviceId: string): SessionStore {
  return {
    ...store,

    async create(payload: CreateSessionPayload): Promise<void> {
      const metadata = (payload as { metadata?: Record<string, unknown> }).metadata;
      return store.create({
        ...payload,
        metadata: { ...(metadata ?? {}), hostDeviceId },
      } as CreateSessionPayload);
    },

    async updateMetadata(
      sessionId: string,
      update: UpdateSessionMetadataPayload,
    ): Promise<void> {
      // Only when the caller is already writing the metadata blob. Stamping an
      // update that does not touch metadata would turn every title change into
      // a metadata write, and the store merges blobs -- so an existing value
      // survives untouched anyway.
      if (update.metadata === undefined) {
        return store.updateMetadata(sessionId, update);
      }

      const metadata = update.metadata as Record<string, unknown> | null;
      if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
        // Not ours to fix: the underlying store refuses non-object metadata
        // deliberately, and it should see exactly what the caller sent.
        return store.updateMetadata(sessionId, update);
      }

      return store.updateMetadata(sessionId, {
        ...update,
        metadata: { ...metadata, hostDeviceId },
      });
    },
  };
}
