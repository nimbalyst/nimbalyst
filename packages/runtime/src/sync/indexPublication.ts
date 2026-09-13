/**
 * Publication gate for the personal session index.
 *
 * Why this exists: `SyncedSessionStore` pushes `{ updatedAt }` to the index on
 * every persisted message. `updatedAt` is on the
 * `INDEX_CLIENT_METADATA_PATCH_SAFE_KEYS` fast-path, and the
 * `indexClientMetadataPatch` wire message does not carry `updatedAt` at all --
 * so a streaming turn produced one packet per message whose payload was
 * byte-for-byte the same fields the server already had. `IndexRoom` still wrote
 * and broadcast the complete row for each one, and iOS re-sorted its list under
 * `withAnimation` each time.
 *
 * The gate compares the *projected outgoing fields* -- the plaintext values that
 * actually reach the wire -- rather than the ciphertext. AES-GCM uses a fresh
 * nonce per encryption, so two encryptions of identical metadata never compare
 * equal; ciphertext inequality is not evidence of a meaningful change.
 *
 * The recorded signature tracks what the *server* is believed to hold, so it is
 * updated from three directions: our own successful publish, a full
 * `indexUpdate` (whose payload is a superset of the patch projection), and rows
 * arriving from the server itself (index sync response / broadcast). It is
 * dropped whenever the index connection drops, because a fresh connection has
 * no proof of what survived on the other side.
 */

/**
 * The plaintext fields an `indexClientMetadataPatch` actually puts on the wire.
 * Anything outside this shape (updatedAt, lastMessageAt, messageCount, title,
 * ...) is not transmitted by a patch and therefore cannot make one meaningful.
 */
export interface IndexPatchWireProjection {
  isExecuting?: boolean;
  lastReadAt?: number;
  /** Plaintext client metadata, captured before encryption. */
  clientMetadata?: Record<string, unknown>;
}

/**
 * Order-independent, undefined-insensitive serialization. `JSON.stringify` is
 * not usable directly: key order follows insertion order, so two structurally
 * identical projections built by different code paths can serialize
 * differently, and `undefined` members vanish from objects but become `null`
 * inside arrays.
 */
function stableSerialize(value: unknown): string {
  if (value === undefined) return 'u';
  if (value === null) return 'n';
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableSerialize(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'u';
}

/** Stable signature of the fields a patch would transmit. */
export function indexPatchSignature(projection: IndexPatchWireProjection): string {
  return stableSerialize({
    isExecuting: projection.isExecuting,
    lastReadAt: projection.lastReadAt,
    clientMetadata: projection.clientMetadata,
  });
}

export interface IndexPublicationGate {
  /** True when the projection differs from what the server is believed to hold. */
  shouldPublish(sessionId: string, signature: string): boolean;
  /** Record the server-known projection (after a successful send, or from a server row). */
  recordPublished(sessionId: string, signature: string): void;
  /** Forget one session, e.g. after a failed send or a delete. */
  invalidate(sessionId: string): void;
  /** Forget everything, e.g. on index disconnect. */
  reset(): void;
}

export function createIndexPublicationGate(): IndexPublicationGate {
  const lastPublished = new Map<string, string>();
  return {
    shouldPublish(sessionId, signature) {
      // A session we have never published has nothing to compare against and
      // must always go out -- absence here is not evidence the server has it.
      const previous = lastPublished.get(sessionId);
      return previous === undefined || previous !== signature;
    },
    recordPublished(sessionId, signature) {
      lastPublished.set(sessionId, signature);
    },
    invalidate(sessionId) {
      lastPublished.delete(sessionId);
    },
    reset() {
      lastPublished.clear();
    },
  };
}

/**
 * Per-session publish sequence.
 *
 * Every index publication reads the cache, awaits encryption, and only then
 * sends. During that await a newer publication for the same session can be
 * built and sent -- notably the bulk reconciliation path, which encrypts
 * hundreds of entries and cannot sit inside the per-session queue. Comparing
 * the sequence captured at build time against the current one tells the slower
 * writer that its payload is stale: it must not send, must not overwrite the
 * cache, and must not record a gate signature the server never received.
 */
export interface PublishSequencer {
  /** Sequence to capture alongside a payload being built. */
  read(id: string): number;
  /** Call after a successful publish, so slower in-flight builds see the bump. */
  bump(id: string): void;
  isStale(id: string, capturedAt: number): boolean;
  reset(): void;
}

export function createPublishSequencer(): PublishSequencer {
  let sequences = new Map<string, number>();
  return {
    read(id) {
      return sequences.get(id) ?? 0;
    },
    bump(id) {
      sequences.set(id, (sequences.get(id) ?? 0) + 1);
    },
    isStale(id, capturedAt) {
      return (sequences.get(id) ?? 0) !== capturedAt;
    },
    reset() {
      sequences = new Map();
    },
  };
}

/**
 * Serializes async work per key. Index publications for one session must not
 * interleave: the gate check, the encryption `await`, and the send have to be
 * one atomic step or two concurrent bursts both read a stale "last published"
 * value and land out of order on the server.
 *
 * Tasks for different keys still run concurrently, and a rejected task does not
 * poison the chain for later ones.
 */
export function createKeyedSerialQueue(): {
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
} {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve();
      const result = previous.then(task, task);
      // Swallow rejections on the chain only; `result` still rejects for the caller.
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
  };
}
