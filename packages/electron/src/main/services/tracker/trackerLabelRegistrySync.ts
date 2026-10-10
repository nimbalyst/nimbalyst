/**
 * The label registry's half of the team schema lane, under the reserved
 * `__labels__` schema type (see `schemaSyncPayload.ts`).
 *
 * A copy of `trackerPredicateRegistrySync.ts` for the second registry: the same
 * syncId / baseline / pushed / rejected bookkeeping, in its own private
 * settings store, and the same three-way per-entry merge
 * (`labelRegistryMerge.ts`). Read that module's header for why each piece of
 * state exists.
 */

import fs from 'fs';
import PrivateSettingsStore from '../../utils/privateSettingsStore';
import type { TrackerSchemaLocalChange } from '@nimbalyst/tracker-engine';
import { isLabelRegistryEmpty, validateLabelRegistry, type LabelRegistry } from '@nimbalyst/tracker-schema';
import {
  decodeTrackerSchemaPayload,
  encodeTrackerLabelRegistryPayload,
  TRACKER_LABEL_REGISTRY_SCHEMA_TYPE,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/schemaSyncPayload';
import {
  canonicalLabelRegistryJson,
  mergeLabelRegistries,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/labelRegistryMerge';
import { logger } from '../../utils/logger';
import {
  readWorkspaceLabelRegistry,
  workspaceLabelRegistryPath,
  writeWorkspaceLabelRegistry,
} from './trackerLabelRegistryFile';
import { requestTrackerSchemaFlush } from './trackerSchemaFlush';
import type { ApplyRemoteSchemaResult, RemoteTrackerSchemaDef } from './trackerTypeDefStore';

export interface LabelRegistrySyncState {
  syncId: number | null;
  baseline: string | null;
  pushed: string | null;
  rejected: string | null;
}

export interface LabelRegistrySyncStateStore {
  get(workspacePath: string): LabelRegistrySyncState;
  set(workspacePath: string, state: LabelRegistrySyncState): void;
}

export interface LabelRegistryLaneOptions {
  state?: LabelRegistrySyncStateStore;
  /** Install the applied registry in-process (the desktop registry, a test's spy). */
  onApplied?: (workspacePath: string, registry: LabelRegistry) => void;
}

const EMPTY_STATE: LabelRegistrySyncState = { syncId: null, baseline: null, pushed: null, rejected: null };

export function createInMemoryLabelRegistrySyncStateStore(): LabelRegistrySyncStateStore {
  const states = new Map<string, LabelRegistrySyncState>();
  return {
    get: (workspacePath) => ({ ...EMPTY_STATE, ...states.get(workspacePath) }),
    set: (workspacePath, state) => { states.set(workspacePath, { ...state }); },
  };
}

let defaultStore: LabelRegistrySyncStateStore | null = null;

/** Lazy: the settings store reads `app.getPath('userData')`. */
function getDefaultStateStore(): LabelRegistrySyncStateStore {
  if (!defaultStore) {
    const store = new PrivateSettingsStore<Record<string, LabelRegistrySyncState>>({
      name: 'tracker-label-registry-sync',
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

function parseBaseline(json: string | null): LabelRegistry | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && Array.isArray(parsed.labels) && Array.isArray(parsed.properties)
      ? { labels: parsed.labels, properties: parsed.properties, claimProperties: parsed.claimProperties ?? {} }
      : null;
  } catch {
    return null;
  }
}

/**
 * The registry's entry in the schema outbox, or nothing. An unreadable local
 * copy is never offered, and neither is a missing one: "this peer has no
 * labels.yaml" must not clear the team's labels. An existing file emptied
 * after this peer applied a non-empty room registry is a removal of the last
 * entry, and is offered like any other edit.
 */
export function listUnsyncedLabelRegistry(
  workspacePath: string,
  options: LabelRegistryLaneOptions = {},
): TrackerSchemaLocalChange[] {
  const local = readWorkspaceLabelRegistry(workspacePath);
  if (!local) return [];
  const store = options.state ?? getDefaultStateStore();
  const state = store.get(workspacePath);
  if (isLabelRegistryEmpty(local)) {
    const baseline = parseBaseline(state.baseline);
    const emptiedOnPurpose = fs.existsSync(workspaceLabelRegistryPath(workspacePath))
      && baseline !== null && !isLabelRegistryEmpty(baseline);
    if (!emptiedOnPurpose) return [];
  }
  const canonical = canonicalLabelRegistryJson(local);
  if (canonical === state.baseline || canonical === state.rejected) return [];
  if (state.pushed !== canonical) store.set(workspacePath, { ...state, pushed: canonical });
  return [{
    type: TRACKER_LABEL_REGISTRY_SCHEMA_TYPE,
    model: encodeTrackerLabelRegistryPayload(local),
    deleted: false,
  }];
}

/** Stop re-offering the registry the room refused, until the local copy changes. */
export function markLabelRegistryRejected(
  workspacePath: string,
  options: LabelRegistryLaneOptions = {},
): void {
  const local = readWorkspaceLabelRegistry(workspacePath);
  if (!local) return;
  const store = options.state ?? getDefaultStateStore();
  store.set(workspacePath, { ...store.get(workspacePath), rejected: canonicalLabelRegistryJson(local) });
}

/**
 * Apply the room's registry: version-gate it, merge it with the local copy,
 * project the result onto disk, and queue whatever the room still lacks.
 */
export async function applyRemoteLabelRegistry(
  workspacePath: string,
  def: RemoteTrackerSchemaDef,
  options: LabelRegistryLaneOptions = {},
): Promise<ApplyRemoteSchemaResult> {
  const store = options.state ?? getDefaultStateStore();
  const state = store.get(workspacePath);
  if (state.syncId != null && def.syncId < state.syncId) return { applied: false, reason: 'stale' };

  let remote: LabelRegistry = { labels: [], properties: [], claimProperties: {} };
  if (def.model !== null) {
    const decoded = decodeTrackerSchemaPayload(def.type, def.model);
    if (decoded?.kind !== 'labels') {
      logger.main.warn('[TrackerLabelSync] dropped an unreadable label registry payload', {
        workspacePath,
        syncId: def.syncId,
      });
      return { applied: false, reason: 'invalid' };
    }
    remote = decoded.registry;
  }

  const local = readWorkspaceLabelRegistry(workspacePath);
  if (local === null) {
    // Someone's edit in progress: neither overwrite it nor advance the baseline
    // past it. The next delivery retries.
    logger.main.warn('[TrackerLabelSync] local labels.yaml is invalid; not applying the room registry yet', {
      workspacePath,
      syncId: def.syncId,
    });
    return { applied: false, reason: 'invalid' };
  }

  const remoteCanonical = canonicalLabelRegistryJson(remote);
  // The room echoing our own push is not a competing edit.
  const baseline = remoteCanonical === state.pushed ? remote : parseBaseline(state.baseline);
  const { merged, keptLocal, overriddenLocal, conflicts } = mergeLabelRegistries({ baseline, local, remote });

  if (overriddenLocal.length > 0) {
    logger.main.warn('[TrackerLabelSync] the room\'s newer registry replaced local edits', {
      workspacePath,
      syncId: def.syncId,
      replaced: overriddenLocal,
    });
  }
  if (conflicts.length > 0) {
    logger.main.warn('[TrackerLabelSync] local edits conflicted with the room registry (cycle, dangling broader, or id clash); took the room\'s version', {
      workspacePath,
      syncId: def.syncId,
      conflicts,
    });
  }

  // A file every later read rejects would stop this lane for good. The merge
  // only returns an invalid registry when the room's own is invalid.
  const mergedValidation = validateLabelRegistry(merged);
  if (!mergedValidation.valid) {
    logger.main.warn('[TrackerLabelSync] the merged label registry is invalid; not installing it', {
      workspacePath,
      syncId: def.syncId,
      issues: mergedValidation.issues,
    });
    return { applied: false, reason: 'invalid' };
  }

  if (canonicalLabelRegistryJson(merged) !== canonicalLabelRegistryJson(local)) {
    try {
      await writeWorkspaceLabelRegistry(workspacePath, merged);
    } catch (err) {
      // Recording the room's version as the baseline without the write would
      // make the stale file look like a local edit and push it over the room.
      logger.main.warn('[TrackerLabelSync] could not write the label registry copy', err);
      options.onApplied?.(workspacePath, merged);
      return { applied: false, reason: 'error' };
    }
  }

  // Re-read: a push offered during the write above recorded `pushed`, and the
  // snapshot taken before it would erase that and misread our own ack.
  store.set(workspacePath, { ...store.get(workspacePath), syncId: def.syncId, baseline: remoteCanonical });
  options.onApplied?.(workspacePath, merged);

  if (keptLocal.length > 0) {
    logger.main.info('[TrackerLabelSync] keeping local label entries the room lacks; publishing them', {
      workspacePath,
      entries: keptLocal,
    });
    requestTrackerSchemaFlush(workspacePath);
  }
  return { applied: true, deleted: def.model === null };
}
