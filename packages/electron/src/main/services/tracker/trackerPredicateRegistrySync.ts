/**
 * The predicate registry's half of the team schema lane (NIM-6653).
 *
 * The registry rides the lane under the reserved `__predicates__` schema type
 * (see `schemaSyncPayload.ts`), so the room stores, versions, encrypts and
 * gates it exactly as it does a tracker type. Until this module nothing ever
 * pushed it: the codec existed, the receive path existed, and the web console
 * had no registry to receive.
 *
 * Bookkeeping lives beside, not inside, `tracker_type_defs`. That table is read
 * as "this project's tracker types" by the registry, the CLI and drift checks,
 * and a `__predicates__` row would show up in all of them as a type. What the
 * lane needs is small and per workspace:
 *
 *  - `syncId`   the room version last applied, the same version gate a type row has;
 *  - `baseline` the room registry last applied, which is what makes the merge in
 *               `predicateRegistryMerge.ts` three-way, and what "pending" means:
 *               a local registry that differs from it has not reached the room;
 *  - `pushed`   the registry last offered, so the room echoing our own push back
 *               is not mistaken for a teammate's competing edit;
 *  - `rejected` a registry the room refused for good, so it is not re-sent on
 *               every connect (the analogue of `sync_status = 'rejected'`).
 *
 * `.nimbalyst/predicates.yaml` stays the local copy. It is only rewritten when
 * the merged registry actually differs from it, so a peer already in step with
 * the room never rewrites the file for nothing.
 */

import fs from 'fs';
import PrivateSettingsStore from '../../utils/privateSettingsStore';
import type { TrackerSchemaLocalChange } from '@nimbalyst/tracker-engine';
import type { PredicateDefinition } from '@nimbalyst/tracker-schema';
import {
  decodeTrackerSchemaPayload,
  encodeTrackerPredicateRegistryPayload,
  TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/schemaSyncPayload';
import {
  canonicalPredicateRegistryJson,
  mergePredicateRegistries,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/predicateRegistryMerge';
import { logger } from '../../utils/logger';
import {
  readWorkspacePredicateRegistry,
  workspacePredicateRegistryPath,
  writeWorkspacePredicateRegistry,
} from './trackerPredicateRegistryFile';
import { requestTrackerSchemaFlush } from './trackerSchemaFlush';
import type { ApplyRemoteSchemaResult, RemoteTrackerSchemaDef } from './trackerTypeDefStore';

export interface PredicateRegistrySyncState {
  syncId: number | null;
  baseline: string | null;
  pushed: string | null;
  rejected: string | null;
}

export interface PredicateRegistrySyncStateStore {
  get(workspacePath: string): PredicateRegistrySyncState;
  set(workspacePath: string, state: PredicateRegistrySyncState): void;
}

export interface PredicateRegistryLaneOptions {
  state?: PredicateRegistrySyncStateStore;
  /** Install the applied registry in-process (the desktop registry, a test's spy). */
  onApplied?: (workspacePath: string, predicates: PredicateDefinition[]) => void;
}

const EMPTY_STATE: PredicateRegistrySyncState = { syncId: null, baseline: null, pushed: null, rejected: null };

export function createInMemoryPredicateRegistrySyncStateStore(): PredicateRegistrySyncStateStore {
  const states = new Map<string, PredicateRegistrySyncState>();
  return {
    get: (workspacePath) => ({ ...EMPTY_STATE, ...states.get(workspacePath) }),
    set: (workspacePath, state) => { states.set(workspacePath, { ...state }); },
  };
}

let defaultStore: PredicateRegistrySyncStateStore | null = null;

/** Lazy: the settings store reads `app.getPath('userData')`. */
function getDefaultStateStore(): PredicateRegistrySyncStateStore {
  if (!defaultStore) {
    const store = new PrivateSettingsStore<Record<string, PredicateRegistrySyncState>>({
      name: 'tracker-predicate-registry-sync',
      clearInvalidConfig: true,
      // Keys are workspace paths, which contain dots.
      accessPropertiesByDotNotation: false,
    });
    defaultStore = {
      get: (workspacePath) => ({ ...EMPTY_STATE, ...store.get(workspacePath) }),
      set: (workspacePath, state) => store.set(workspacePath, state),
    };
  }
  return defaultStore;
}

function parseBaseline(json: string | null): PredicateDefinition[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed as PredicateDefinition[] : null;
  } catch {
    return null;
  }
}

/**
 * The registry's entry in the schema outbox, or nothing.
 *
 * An unreadable local copy is a half-typed hand edit and is never offered. A
 * missing one is never offered either: a peer with no `predicates.yaml` reads
 * as empty, and "this peer has no file" must not clear the team's verbs. An
 * existing file emptied after this peer applied a non-empty room registry is
 * the removal of the last verb, and is offered like any other edit.
 */
export function listUnsyncedPredicateRegistry(
  workspacePath: string,
  options: PredicateRegistryLaneOptions = {},
): TrackerSchemaLocalChange[] {
  const local = readWorkspacePredicateRegistry(workspacePath);
  if (!local) return [];
  const store = options.state ?? getDefaultStateStore();
  const state = store.get(workspacePath);
  if (local.length === 0) {
    const emptiedOnPurpose = fs.existsSync(workspacePredicateRegistryPath(workspacePath))
      && (parseBaseline(state.baseline)?.length ?? 0) > 0;
    if (!emptiedOnPurpose) return [];
  }
  const canonical = canonicalPredicateRegistryJson(local);
  if (canonical === state.baseline || canonical === state.rejected) return [];
  if (state.pushed !== canonical) store.set(workspacePath, { ...state, pushed: canonical });
  return [{
    type: TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE,
    model: encodeTrackerPredicateRegistryPayload(local),
    deleted: false,
  }];
}

/** Stop re-offering the registry the room refused, until the local copy changes. */
export function markPredicateRegistryRejected(
  workspacePath: string,
  options: PredicateRegistryLaneOptions = {},
): void {
  const local = readWorkspacePredicateRegistry(workspacePath);
  if (!local) return;
  const store = options.state ?? getDefaultStateStore();
  store.set(workspacePath, { ...store.get(workspacePath), rejected: canonicalPredicateRegistryJson(local) });
}

/**
 * Apply the room's registry: version-gate it, merge it with the local copy,
 * project the result onto disk, and queue whatever the room still lacks.
 */
export async function applyRemotePredicateRegistry(
  workspacePath: string,
  def: RemoteTrackerSchemaDef,
  options: PredicateRegistryLaneOptions = {},
): Promise<ApplyRemoteSchemaResult> {
  const store = options.state ?? getDefaultStateStore();
  const state = store.get(workspacePath);
  if (state.syncId != null && def.syncId < state.syncId) return { applied: false, reason: 'stale' };

  let remote: PredicateDefinition[] = [];
  if (def.model !== null) {
    const decoded = decodeTrackerSchemaPayload(def.type, def.model);
    if (decoded?.kind !== 'predicates') {
      logger.main.warn('[TrackerPredicateSync] dropped an unreadable predicate registry payload', {
        workspacePath,
        syncId: def.syncId,
      });
      return { applied: false, reason: 'invalid' };
    }
    remote = decoded.predicates;
  }

  const local = readWorkspacePredicateRegistry(workspacePath);
  if (local === null) {
    // A malformed local copy is someone's edit in progress. Overwriting it would
    // destroy it, and advancing the baseline past it would later push it over
    // the room's newer registry. Leave both; the next delivery retries.
    logger.main.warn('[TrackerPredicateSync] local predicates.yaml is invalid; not applying the room registry yet', {
      workspacePath,
      syncId: def.syncId,
    });
    return { applied: false, reason: 'invalid' };
  }

  const remoteCanonical = canonicalPredicateRegistryJson(remote);
  // The room echoing our own push is not a competing edit: measure local
  // changes against it, so an edit saved while the ack was in flight survives.
  const baseline = remoteCanonical === state.pushed ? remote : parseBaseline(state.baseline);
  const { merged, keptLocal, overriddenLocal } = mergePredicateRegistries({ baseline, local, remote });

  if (overriddenLocal.length > 0) {
    logger.main.warn('[TrackerPredicateSync] the room\'s newer registry replaced local edits', {
      workspacePath,
      syncId: def.syncId,
      replaced: local.filter(p => overriddenLocal.includes(p.id)),
    });
  }

  if (canonicalPredicateRegistryJson(merged) !== canonicalPredicateRegistryJson(local)) {
    try {
      await writeWorkspacePredicateRegistry(workspacePath, merged);
    } catch (err) {
      // Without the write the file still holds the old registry; recording the
      // room's version as the baseline would make that stale file look like a
      // local edit and push it over the room. Apply in-process only.
      logger.main.warn('[TrackerPredicateSync] could not write the predicate registry copy', err);
      options.onApplied?.(workspacePath, merged);
      return { applied: false, reason: 'error' };
    }
  }

  // Re-read: a push offered during the write above recorded `pushed`, and the
  // snapshot taken before it would erase that and misread our own ack.
  store.set(workspacePath, { ...store.get(workspacePath), syncId: def.syncId, baseline: remoteCanonical });
  options.onApplied?.(workspacePath, merged);

  if (keptLocal.length > 0) {
    logger.main.info('[TrackerPredicateSync] keeping local predicates the room lacks; publishing them', {
      workspacePath,
      predicates: keptLocal,
    });
    requestTrackerSchemaFlush(workspacePath);
  }
  return { applied: true, deleted: def.model === null };
}
