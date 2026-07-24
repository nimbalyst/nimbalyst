/**
 * DocumentSync Registry
 *
 * Tracks live DocumentSyncProvider instances (one per open collaborative doc)
 * so the network-available cascade can trigger an immediate reconnect on all
 * of them after the CollabV3 index is confirmed healthy.
 *
 * CollaborativeTabEditor registers its provider on mount and unregisters on
 * unmount via the lifecycle helpers below.
 */

import type { DocumentSyncProvider } from '@nimbalyst/runtime/sync';

const providers = new Set<DocumentSyncProvider>();

export const documentSyncRegistry = {
  register(provider: DocumentSyncProvider): void {
    providers.add(provider);
  },

  unregister(provider: DocumentSyncProvider): void {
    providers.delete(provider);
  },

  /**
   * Call reconnectNow() on every registered provider. Used by the
   * network-available cascade after the CollabV3 index reaches `ready`.
   */
  reconnectAll(): void {
    for (const provider of providers) {
      try {
        provider.reconnectNow();
      } catch (err) {
        console.error('[documentSyncRegistry] reconnectNow failed:', err);
      }
    }
  },

  /** For tests / debugging. */
  size(): number {
    return providers.size;
  },

  clear(): void {
    providers.clear();
  },
};

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    providers.clear();
  });
}
