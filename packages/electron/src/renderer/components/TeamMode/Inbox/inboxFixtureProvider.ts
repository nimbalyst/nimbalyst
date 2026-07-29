/**
 * Fixture-backed `InboxProvider` for tests and design review.
 *
 * Same pattern as `Comments/CommentsHarness.tsx`: nothing in the app imports
 * this module, so the fixtures never reach a packaged build. The surface
 * resolves its provider from `InboxProviderContext`, and a window without one
 * renders the empty state — to review the fixtures, mount the tree with
 *
 *   <InboxProviderContext.Provider value={createFixtureInboxProvider()}>
 *
 * or pass the provider to `<InboxSection provider={...} />` as the tests do.
 */

import { createInboxFixtures } from './inboxFixtures';
import type { InboxProvider } from './inboxProvider';
import type {
  HydratedInboxDelivery,
  InboxRowView,
  InboxSnapshot,
  InboxStatus,
} from './inboxTypes';

/** Snapshot store shared by the fixture provider. */
function createStore(initial: InboxSnapshot) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    set(next: InboxSnapshot) {
      snapshot = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export interface FixtureProviderOptions {
  now?: number;
  status?: InboxStatus;
  deliveries?: HydratedInboxDelivery[];
  unavailableOrganizations?: InboxSnapshot['unavailableOrganizations'];
  /** Overridden in tests to assert the mark-read-after-navigation contract. */
  navigate?: (row: InboxRowView) => Promise<boolean>;
}

export function createFixtureInboxProvider(options: FixtureProviderOptions = {}): InboxProvider {
  const now = options.now ?? Date.now();
  const store = createStore({
    status: options.status ?? 'ready',
    deliveries: options.deliveries ?? createInboxFixtures({ now }),
    unavailableOrganizations: options.unavailableOrganizations,
    lastSyncedAt: now,
  });

  const patch = (id: string, change: Partial<HydratedInboxDelivery>) => {
    const current = store.get();
    store.set({
      ...current,
      deliveries: current.deliveries.map((delivery) => (delivery.id === id ? { ...delivery, ...change } : delivery)),
    });
  };

  return {
    getSnapshot: store.get,
    subscribe: store.subscribe,
    async markRead(deliveryIds) {
      for (const id of deliveryIds) patch(id, { readAt: Date.now(), hasUnreadActivity: false });
    },
    async dismiss(deliveryId) {
      patch(deliveryId, { dismissedAt: Date.now() });
    },
    async setSubscriptionState(deliveryId, state) {
      patch(deliveryId, { subscription: state });
    },
    async migrateOrganization() {},
    async navigate(row) {
      // Deep-link navigation is a later slice. Reporting success here keeps the
      // mark-read-after-navigation path exercisable in the live window.
      return options.navigate ? options.navigate(row) : true;
    },
    simulateStatus(status) {
      const current = store.get();
      store.set({
        ...current,
        status,
        // "Offline without cache" means there are no cached rows to show.
        deliveries: status === 'offlineWithoutCache' ? [] : (options.deliveries ?? createInboxFixtures({ now })),
        lastSyncedAt: status === 'ready' ? Date.now() : current.lastSyncedAt,
      });
    },
  };
}
