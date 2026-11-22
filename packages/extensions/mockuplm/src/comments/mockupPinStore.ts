/**
 * The narrow pin surface the overlay consumes.
 *
 * `MockupPinRepository` (Y.Doc backed) is the production implementation. The
 * overlay depends on this interface instead of the class so that measurement,
 * numbering, and rendering can be exercised without a Y.Doc -- and so a mockup
 * opened outside a collaborative room still has somewhere to put a pin.
 */

import { Doc as YDoc } from "yjs";
import type { MockupPin } from "../collab/seed";
import { MockupPinRepository, type MockupPinSnapshot } from "./mockupPinRepository";

export interface MockupPinStore {
  create(pin: MockupPin): void;
  updateSelector(pinId: string, selector: string): boolean;
  delete(pinId: string): boolean;
  snapshot(): readonly MockupPinSnapshot[];
  subscribe(listener: () => void): () => void;
}

/**
 * Wrap a store so its methods can be passed around detached from the instance
 * -- `useSyncExternalStore(store.subscribe, store.snapshot)` would otherwise
 * call the repository's class methods with no `this`.
 */
export function bindMockupPinStore(store: MockupPinStore): MockupPinStore {
  return {
    create: (pin) => store.create(pin),
    updateSelector: (pinId, selector) => store.updateSelector(pinId, selector),
    delete: (pinId) => store.delete(pinId),
    snapshot: () => store.snapshot(),
    subscribe: (listener) => store.subscribe(listener),
  };
}

/**
 * A store whose writes are skipped while `canWrite()` is false.
 *
 * Pins live in `mockupPins`, outside the `comments` array. A user who may not
 * write the body (a commenter) has every write there refused, and for a
 * commenter the refusal ends the session. Some writes happen with no action
 * from that user -- collecting a pin when another user deletes its thread,
 * healing a selector on render -- so the gate sits on the store itself rather
 * than on the overlay's buttons. Reads are untouched.
 */
export function guardMockupPinWrites(
  store: MockupPinStore,
  canWrite: () => boolean
): MockupPinStore {
  return {
    create: (pin) => {
      if (canWrite()) store.create(pin);
    },
    updateSelector: (pinId, selector) => (canWrite() ? store.updateSelector(pinId, selector) : false),
    delete: (pinId) => (canWrite() ? store.delete(pinId) : false),
    snapshot: () => store.snapshot(),
    subscribe: (listener) => store.subscribe(listener),
  };
}

/**
 * Whether a comments service lets this user write the document outside the
 * `comments` array. `editBody` absent means yes; no service (outside a room)
 * means the private store, which is always writable.
 */
export function canWriteMockupPins(
  service: { getCapabilities(): { editBody?: boolean } } | null | undefined
): boolean {
  return service?.getCapabilities().editBody !== false;
}

/**
 * A pin store over a private, unshared Y.Doc.
 *
 * This is the production repository, not a second implementation of it: an
 * earlier standalone version carried its own copies of the ordering and
 * freezing rules, which is exactly the kind of duplicate that answers
 * differently from the real one once either side is edited.
 *
 * Used by tests that exercise placement, numbering and measurement without a
 * room. Production reaches it only through `useMockupComments`, where a mockup
 * outside a room has no comments service either, so nothing ever writes to it.
 */
export function createInMemoryMockupPinStore(): MockupPinStore {
  return bindMockupPinStore(new MockupPinRepository(new YDoc()));
}
