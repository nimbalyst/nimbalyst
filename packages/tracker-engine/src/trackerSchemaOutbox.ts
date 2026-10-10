/**
 * The push side of the schema lane: offer every locally-changed schema row to
 * the room.
 *
 * Runs at the end of every bootstrap and, since NIM-6654, whenever the host
 * reports a schema save while connected. Before that the only trigger was the
 * bootstrap, so an edit made mid-session sat at `pending` until the socket
 * happened to drop.
 *
 * Two runs can overlap -- a save lands while the post-bootstrap drain is still
 * awaiting `listUnsynced` -- and a row stays in the host's outbox until its ack
 * is applied. So the outbox remembers what it has sent and not yet heard back
 * about, and does not send the same content for the same type twice. Changed
 * content for a type already in flight is sent: the room orders the two by
 * arrival, and the later one is the one the author meant.
 */

import type { TrackerClientMessage } from './trackerProtocol.js';
import type { TrackerSchemaSyncHooks } from './TrackerSyncEngine.js';

export interface TrackerSchemaOutboxDeps {
  hooks: () => TrackerSchemaSyncHooks | undefined;
  isOpen: () => boolean;
  send: (message: TrackerClientMessage) => void;
  newMutationId: () => string;
  /** The engine's cmid -> lane id map, which rejection acks are resolved through. */
  pendingLaneIds: Map<string, string>;
  /** Whether the room advertised that it refuses a create-only mutation for an existing type. */
  createOnlySupported: () => boolean;
}

export class TrackerSchemaOutbox {
  /** clientMutationId -> the type and payload that mutation carried. */
  private readonly inFlight = new Map<string, { type: string; model: string | null }>();
  private running: Promise<void> | null = null;
  private rerun = false;

  constructor(private readonly deps: TrackerSchemaOutboxDeps) {}

  /** Push what the host has queued. Concurrent calls coalesce into one follow-up run. */
  push(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.rerun = false;
          await this.pushOnce();
        } while (this.rerun);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** The room answered this mutation, either way. Returns what it carried, if it was ours. */
  settle(clientMutationId: string): { type: string; model: string | null } | undefined {
    const sent = this.inFlight.get(clientMutationId);
    this.inFlight.delete(clientMutationId);
    return sent;
  }

  /** A new socket means nothing sent on the old one will be acked. */
  reset(): void {
    this.inFlight.clear();
  }

  private isInFlight(type: string, model: string | null): boolean {
    for (const sent of this.inFlight.values()) {
      if (sent.type === type && sent.model === model) return true;
    }
    return false;
  }

  private async pushOnce(): Promise<void> {
    const hooks = this.deps.hooks();
    if (!hooks || !this.deps.isOpen()) return;

    const pending = await hooks.listUnsynced();
    if (!this.deps.isOpen()) return;
    const createOnly = this.deps.createOnlySupported();
    const toSend: Array<{ type: string; model: string | null; createOnly: boolean }> = [];
    for (const def of pending) {
      const model = def.deleted ? null : def.model;
      if (this.isInFlight(def.type, model)) continue;
      if (def.createOnly === 'required' && model !== null && !createOnly) {
        // An older room would upsert over a definition someone else created.
        // Refusing here is the fail-safe; the host retires the creation.
        console.warn(`[TrackerSchemaSync] not sending create-only type=${def.type}: room cannot refuse an existing type`);
        try {
          hooks.onSettled?.({
            type: def.type,
            model,
            accepted: false,
            error: {
              code: 'createOnlyUnsupported',
              message: 'This team\'s server must be updated before new types can be created here.',
            },
          });
        } catch (err) {
          console.error('[TrackerSchemaSync] onSettled threw', err);
        }
        continue;
      }
      toSend.push({ type: def.type, model, createOnly: def.createOnly !== undefined && model !== null && createOnly });
    }
    if (toSend.length > 0) {
      console.info(`[TrackerSchemaSync] pushing ${toSend.length} unsynced schema mutation(s)`);
    }
    for (const def of toSend) {
      const clientMutationId = this.deps.newMutationId();
      this.deps.pendingLaneIds.set(clientMutationId, def.type);
      this.inFlight.set(clientMutationId, { type: def.type, model: def.model });
      // The model JSON travels as plaintext; the server encrypts it at rest
      // with the team DEK. A null payload is a tombstone.
      console.info(
        `[TrackerSchemaSync] -> mutation (${def.model === null ? 'delete' : 'upsert'}) type=${def.type} cmid=${clientMutationId}`,
      );
      this.deps.send({
        type: 'trackerSchemaMutation',
        clientMutationId,
        schemaType: def.type,
        encryptedPayload: def.model,
        ...(def.createOnly ? { createOnly: true } : {}),
      });
    }
  }
}
