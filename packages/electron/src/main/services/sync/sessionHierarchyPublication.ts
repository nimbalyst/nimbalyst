import type { ChatSession } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import type { PushChangeOutcome, SyncProvider } from '@nimbalyst/runtime/sync';
import { isRetainedSession } from '@nimbalyst/collab-protocol';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { onHierarchyMove, onSubtreeArchive } from '../sessionHierarchy';
import { logger } from '../../utils/logger';

/** Retain IDs, never snapshots: retry always publishes the latest durable hierarchy. */
export function createHierarchyPublisher(deps: {
  get(id: string): Promise<ChatSession | null>;
  push(id: string, metadata: { parentSessionId: string | null; createdBySessionId: string | null; isArchived: boolean }, isCurrent: () => boolean): Promise<PushChangeOutcome>;
  listPending?(): Promise<string[]>;
  confirm?(): Promise<void>;
  /** False while the transport would defer every push; ready/gate listeners call retry() when it flips. */
  canPublish?(): boolean;
  /** False when the server index cannot hold the row, so no push can ever be confirmed. */
  isRetained?(row: ChatSession): boolean;
  /** Clears a durable intent that can never be confirmed. */
  dropIntent?(row: ChatSession): Promise<void>;
  warn(error: unknown): void;
}) {
  type Publication = { isCurrent: () => boolean; durable?: boolean };
  const pending = new Map<string, Publication>();
  const lanes = new Map<string, Promise<void>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let enabled = true;
  let confirming: Promise<void> | undefined;
  let confirmationRequested = false;
  let retrying: Promise<void> | undefined;
  const transportUp = () => deps.canPublish?.() ?? true;
  const schedule = (discoveryFailed = false) => {
    if (!enabled || timer || (!pending.size && !discoveryFailed)) return;
    timer = setTimeout(() => { timer = undefined; void retry(); }, 5000);
    timer.unref?.();
  };
  function requestConfirmation() {
    if (!enabled || !deps.confirm) return;
    confirmationRequested = true;
    if (confirming) return;
    // Never await this from publish: the local writer may still own the
    // hierarchy lane, which the authoritative response needs to enter.
    confirming = Promise.resolve().then(async () => {
      for (let attempt = 0; enabled && attempt < 2; attempt++) {
        confirmationRequested = false;
        const observed = new Map(pending);
        await deps.confirm!();
        if (deps.listPending) {
          const durableIds = new Set(await deps.listPending());
          for (const [id, generation] of observed) {
            if (generation.durable && !durableIds.has(id) && pending.get(id) === generation) pending.delete(id);
          }
        }
        if (!confirmationRequested) break;
      }
    }).catch(error => { deps.warn(error); schedule(true); }).finally(() => {
      confirming = undefined;
      // A busy writer may outrun both barriers; the named retry remains bounded.
      if (confirmationRequested) schedule(true);
    });
  }
  function publish(id: string, isCurrent: () => boolean = () => true): Promise<void> {
    const generation: Publication = { isCurrent };
    pending.set(id, generation);
    const clear = () => { if (pending.get(id) === generation) pending.delete(id); };
    const task = (lanes.get(id) ?? Promise.resolve()).then(async () => {
      try {
        if (!isCurrent()) { clear(); return; }
        // Stay pending without touching the database: a migration can leave thousands
        // of intents, and reading each one only to have the push deferred starved the
        // SQLite worker on every retry tick.
        if (!transportUp()) return;
        const row = await deps.get(id);
        if (!row || !isCurrent()) { clear(); return; }
        // The migration wrote intents for months-old sessions. The index never holds
        // them, so every push deferred and was retried every 5s. When such a session
        // becomes active again, its full index entry carries the current parent.
        if (deps.isRetained && !deps.isRetained(row)) {
          if (row.metadata?.hierarchySyncIntent) await deps.dropIntent?.(row);
          clear();
          return;
        }
        generation.durable = !!row.metadata?.hierarchySyncIntent;
        const outcome = await deps.push(id, { parentSessionId: row.parentSessionId ?? null,
          createdBySessionId: row.createdBySessionId ?? null, isArchived: !!row.isArchived }, isCurrent);
        // A successful send is not acknowledgement. Durable local intent stays
        // pending until the store sees a matching authoritative server snapshot.
        if (outcome.published && generation.durable) requestConfirmation();
        if ((outcome.published || outcome.retryable === false) && !row.metadata?.hierarchySyncIntent) clear();
        else if (!outcome.published) deps.warn(outcome); // Retained for timer, readiness and reconnect retry.
      } catch (error) { deps.warn(error); } // Same named retry path.
      schedule();
    });
    lanes.set(id, task);
    void task.finally(() => { if (lanes.get(id) === task) lanes.delete(id); });
    return task;
  }
  function retry(): Promise<void> {
    if (!transportUp()) return Promise.resolve();
    retrying ??= (async () => {
      try {
        for (const id of await deps.listPending?.() ?? []) {
          if (!pending.has(id) || !pending.get(id)!.isCurrent()) pending.set(id, { isCurrent: () => true });
        }
        // One at a time so a large backlog never floods the database worker queue.
        for (const [id, generation] of [...pending]) {
          if (!transportUp()) break;
          if (lanes.has(id) || pending.get(id) !== generation) continue;
          await publish(id, generation.isCurrent);
        }
      } catch (error) { deps.warn(error); schedule(true); }
    })().finally(() => { retrying = undefined; });
    return retrying;
  }
  return { publish, retry, pause() { enabled = false; clearTimeout(timer); timer = undefined; },
    resume() { enabled = true; void retry(); }, pendingCount: () => pending.size };
}

let provider: SyncProvider | null = null;
const publisher = createHierarchyPublisher({
  get: id => AISessionsRepository.get(id),
  listPending: async () => (await AISessionsRepository.getStore().listPendingHierarchyIntents?.() ?? []).map(intent => intent.sessionId),
  confirm: async () => {
    const current = provider;
    if (!current?.fetchIndex) throw new Error('Hierarchy confirmation transport unavailable');
    // fetchIndex dispatches only authoritative server rows to the store reconciler.
    await current.fetchIndex();
  },
  push: async (id, metadata, isCurrent) => {
    const outcome = await provider?.pushChange(id, { type: 'metadata_updated', metadata }, { isCurrent });
    return outcome ?? { published: false, reason: 'Hierarchy transport did not report publication', retryable: true };
  },
  canPublish: () => !!provider && (provider.isIndexReady?.() ?? true)
    && (provider.getPersonalSyncWriteGate?.().state ?? 'verified') === 'verified',
  // Only a known-old timestamp drops an intent; missing activity is not evidence.
  isRetained: row => typeof row.updatedAt !== 'number' || isRetainedSession(row.updatedAt),
  dropIntent: async row => {
    const intent = row.metadata?.hierarchySyncIntent as { revision?: unknown } | undefined;
    if (typeof intent?.revision !== 'string') return;
    await AISessionsRepository.getStore().acknowledgeHierarchyIntent?.(
      row.id, intent.revision, row.parentSessionId ?? null, row.createdBySessionId ?? null);
  },
  warn: error => logger.main.warn('[HierarchySync] Canonical publication pending retry:', error),
});
export const publishCanonicalHierarchy = publisher.publish;

export function registerSessionHierarchyPublication(next: SyncProvider): () => void {
  provider = next;
  const move = onHierarchyMove(change => change.source === 'remote' ? Promise.resolve() : publisher.publish(change.sessionId));
  const archive = onSubtreeArchive(async ids => { await Promise.all(ids.map(id => publisher.publish(id))); });
  const ready = next.onIndexReadyChange?.(isReady => { if (isReady) void publisher.retry(); });
  const gate = next.onPersonalSyncWriteGateChange?.(state => { if (state.state === 'verified') void publisher.retry(); });
  publisher.resume();
  return () => { move(); archive(); ready?.(); gate?.(); if (provider === next) { provider = null; publisher.pause(); } };
}
