/**
 * CommentCollabProvider
 *
 * Minimal `@lexical/yjs` Provider adapter that lets the (orphaned-upstream)
 * `CommentStore` attach to the *document's existing* Y.Doc. Comments are stored
 * under a top-level `comments` YArray in the same Y.Doc as the document
 * content, so they ride the document's already-open encrypted WebSocket — no
 * separate room, connection, or awareness channel is needed.
 *
 * `CommentStore` only ever reads `provider.doc` and calls `connect()` /
 * `disconnect()`. The connection is owned by the host's DocumentSyncProvider,
 * so connect/disconnect here are intentional no-ops; awareness is a stub.
 */

import type { Provider, ProviderAwareness } from '@lexical/yjs';
import type { Doc } from 'yjs';

const STUB_AWARENESS: ProviderAwareness = {
  getLocalState: () => null,
  getStates: () => new Map(),
  setLocalState: () => {},
  setLocalStateField: () => {},
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  on: () => {},
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  off: () => {},
};

export class CommentCollabProvider implements Provider {
  /** The shared document Y.Doc. `CommentStore` reads this via `provider.doc`. */
  doc: Doc;
  awareness: ProviderAwareness = STUB_AWARENESS;

  constructor(doc: Doc) {
    this.doc = doc;
  }

  // The document connection is owned elsewhere; comments sync as part of the
  // same Y.Doc, so these are no-ops.
  connect(): void {}
  disconnect(): void {}

  // eslint-disable-next-line @typescript-eslint/no-empty-function, @typescript-eslint/no-explicit-any
  on(_type: string, _cb: (...args: any[]) => void): void {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function, @typescript-eslint/no-explicit-any
  off(_type: string, _cb: (...args: any[]) => void): void {}
}
