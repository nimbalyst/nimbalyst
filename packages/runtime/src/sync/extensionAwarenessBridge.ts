/**
 * DocumentSync awareness -> y-protocols `Awareness`.
 *
 * Extension editors consume the SDK's `host.collaboration.awareness`, which is
 * a real `y-protocols/awareness` instance (numeric clientIDs, `change`/`update`
 * events). DocumentSync speaks a different dialect: string member ids and a
 * whole-roster broadcast. This bridge is the translation, and it lives here
 * rather than in the Electron renderer because the browser collaborative host
 * needs the identical mapping -- two copies would be two presence dialects on
 * one room.
 *
 * Wire-format choice: the extension awareness path puts the full y-protocols
 * local state on the wire as-is. DocumentSync's `AwarenessState` was widened to
 * `Record<string, unknown> & { user: { name, color, id? } }` precisely so this
 * works without translation.
 *
 * What this is NOT is an event log. DocumentSync coalesces awareness to ~2Hz,
 * so a field set and then changed inside one window is only ever observed by a
 * peer in its final form -- the intermediate state is not delivered late, it is
 * not delivered at all. That is right for a cursor (a continuous value where
 * only the latest matters) and a trap for a *latched* field like "I have an
 * editor open on this cell": one stray local write retracts the latch, no peer
 * ever sees it set, and on the browser host the 5s presence heartbeat then
 * re-affirms the retraction indefinitely, so nothing self-heals. An extension
 * publishing a latch needs a single writer whose lifetime is the thing being
 * latched; see the CSV editor's `collab/localPresence.ts`.
 *
 * Reconnect recovery (#3006) is the other thing this file owns, and the reason
 * it heartbeats. A dropped socket makes DocumentSync clear its awareness map,
 * which is honest -- we no longer know who is in the room -- but nothing in the
 * protocol replays a roster afterwards. `docSyncRequest` asks for content only,
 * and the server treats awareness as broadcast-only with no persistence. So the
 * two directions recover differently:
 *
 *  - "peers see me" is fixed by re-announcing on the transition to `connected`.
 *    The announcement that introduced us went down with the old socket.
 *  - "I see peers" cannot be fixed locally at all. It depends on peers speaking
 *    again, which is what the heartbeat guarantees: every client re-announces on
 *    a bounded cadence, so a reconnected client refills its map within one
 *    interval instead of waiting for someone to happen to move a cursor.
 *
 * A host that already owns presence freshness passes `heartbeatIntervalMs: 0`
 * rather than beating twice -- see the browser bundle's `CollabPresenceSurface`.
 */

import { Awareness } from 'y-protocols/awareness';
import type { Doc } from 'yjs';

import type {
  AwarenessState as WireAwarenessState,
  DocumentSyncStatus,
} from './documentSyncTypes';

/**
 * The slice of `DocumentSyncProvider` this bridge needs. Narrow on purpose:
 * the browser host wraps its provider in a presence surface, and a full
 * `DocumentSyncProvider` parameter would exclude it for no reason.
 */
export interface ExtensionAwarenessTransport {
  setLocalAwareness(state: WireAwarenessState): void;
  onAwarenessChange(listener: (states: Map<string, WireAwarenessState>) => void): () => void;
  /**
   * Optional: lets the bridge re-announce the moment a reconnect completes.
   * Without it the heartbeat still recovers presence, just a tick later.
   */
  onStatusChange?(listener: (status: DocumentSyncStatus) => void): () => void;
  /** Optional: seeds the heartbeat when the bridge attaches to a live provider. */
  getStatus?(): DocumentSyncStatus;
}

/**
 * Matches `CollabLexicalProvider`'s cadence and stays well inside DocumentSync's
 * 30s stale sweep, so a peer never ages out between beats.
 */
const DEFAULT_AWARENESS_HEARTBEAT_MS = 10_000;

/** Standard awareness block every host publishes for generic presence UI. */
export interface ExtensionAwarenessUser {
  id: string;
  name: string;
  color: string;
}

export interface ExtensionAwarenessBridge {
  awareness: Awareness;
  destroy: () => void;
}

/** Origin tag for awareness updates we inject from remote broadcasts. */
const REMOTE_AWARENESS_ORIGIN = Symbol('nimbalyst:collab-remote-awareness');

export function createExtensionAwarenessBridge(args: {
  syncProvider: ExtensionAwarenessTransport;
  /** The Y.Doc owned by the sync provider; Awareness clientID derives from it. */
  yDoc: Doc;
  /** Local user identity to set on the Awareness instance immediately. */
  user: ExtensionAwarenessUser;
  /**
   * Cadence for re-announcing local awareness while connected. 0 disables it,
   * for hosts that already run their own presence heartbeat.
   */
  heartbeatIntervalMs?: number;
}): ExtensionAwarenessBridge {
  const { syncProvider, yDoc, user } = args;
  const heartbeatIntervalMs = args.heartbeatIntervalMs ?? DEFAULT_AWARENESS_HEARTBEAT_MS;

  const awareness = new Awareness(yDoc);
  // Seed the local state with the standard user block so other clients can
  // dedupe and render avatars before the extension publishes anything.
  awareness.setLocalState({ user });

  /** Put our current local state on the DocumentSync wire. */
  const publishLocalState = () => {
    const state = awareness.getLocalState();
    if (state) {
      syncProvider.setLocalAwareness(state as WireAwarenessState);
    }
  };

  // Forward local awareness changes -> DocumentSync wire.
  // We listen to the 'update' event so we catch every state change (including
  // field changes via setLocalStateField). The origin guard prevents the echo
  // when we inject remote state below.
  const localUpdateHandler = (
    _changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => {
    if (origin === REMOTE_AWARENESS_ORIGIN) return;
    publishLocalState();
  };
  awareness.on('update', localUpdateHandler);

  let destroyed = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const stopHeartbeat = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  const startHeartbeat = () => {
    stopHeartbeat();
    if (destroyed || heartbeatIntervalMs <= 0) return;
    heartbeatTimer = setInterval(publishLocalState, heartbeatIntervalMs);
  };

  const statusUnsub = syncProvider.onStatusChange?.((status) => {
    if (destroyed) return;
    if (status !== 'connected') {
      stopHeartbeat();
      return;
    }
    publishLocalState();
    startHeartbeat();
  }) ?? null;

  // Transports that report status seed from it, so attaching to an already-live
  // provider (a cached one, a second mount) still beats without waiting for a
  // transition that has already happened. Transports that do not are assumed
  // live -- an unconnected one turns every beat into a no-op anyway.
  if (!syncProvider.getStatus || syncProvider.getStatus() === 'connected') {
    startHeartbeat();
  }

  // Map remote userIds (string) to stable numeric clientIDs in our Awareness.
  // Never reuse our own awareness.clientID for a remote user.
  const userIdToClientId = new Map<string, number>();
  let nextRemoteClientId = awareness.clientID + 1;
  // identity-scope-allow: awareness wire ids can come from either document-sync identity lane
  const allocateClientId = (userId: string): number => {
    const existing = userIdToClientId.get(userId);
    if (existing !== undefined) return existing;
    // Skip past our own clientID if we collide.
    while (nextRemoteClientId === awareness.clientID) nextRemoteClientId++;
    const id = nextRemoteClientId++;
    userIdToClientId.set(userId, id);
    return id;
  };

  // Receive remote awareness from DocumentSync -> inject into Awareness.
  const awarenessUnsub = syncProvider.onAwarenessChange((states) => {
    const presentClientIds = new Set<number>();
    const added: number[] = [];
    const updated: number[] = [];

    for (const [userId, state] of states) {
      const clientId = allocateClientId(userId);
      presentClientIds.add(clientId);
      const wasPresent = awareness.states.has(clientId);
      // Ensure remote state carries `user.id` so SDK consumers can use it
      // for deduping; the DocumentSync wrapper provides userId out-of-band.
      const stateWithId = {
        ...(state as Record<string, unknown>),
        user: {
          ...(state.user as { name: string; color: string }),
          id: (state.user as { id?: string }).id ?? userId,
        },
      };
      awareness.states.set(clientId, stateWithId);
      const prevMeta = awareness.meta.get(clientId);
      awareness.meta.set(clientId, {
        clock: (prevMeta?.clock ?? 0) + 1,
        lastUpdated: Date.now(),
      });
      if (wasPresent) updated.push(clientId);
      else added.push(clientId);
    }

    // Anyone in our remote map but missing from the broadcast has gone away.
    const removed: number[] = [];
    for (const clientId of awareness.states.keys()) {
      if (clientId === awareness.clientID) continue;
      if (presentClientIds.has(clientId)) continue;
      awareness.states.delete(clientId);
      removed.push(clientId);
    }

    if (added.length === 0 && updated.length === 0 && removed.length === 0) {
      return;
    }
    const event = { added, updated, removed };
    awareness.emit('change', [event, REMOTE_AWARENESS_ORIGIN]);
    awareness.emit('update', [event, REMOTE_AWARENESS_ORIGIN]);
  });

  return {
    awareness,
    destroy: () => {
      destroyed = true;
      stopHeartbeat();
      statusUnsub?.();
      awarenessUnsub();
      awareness.off('update', localUpdateHandler);
      awareness.destroy();
    },
  };
}
