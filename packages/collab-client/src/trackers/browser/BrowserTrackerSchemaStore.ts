/**
 * The schema and navigation lanes of a tracker room, for a browser host.
 *
 * `BrowserTrackerDataSource` carries items and saved views; it takes the other
 * two lanes as hooks because their storage is the host's business. On desktop
 * they land in PGLite tables and the workspace's YAML files. A browser tab has
 * neither, and it does not need either: both lanes are small, both bootstrap
 * from the room on every connect, and nothing in this host originates a change
 * to them. So they live in memory, and a reload replays them.
 *
 * Mostly read-only. Creating a folder, renaming a tracker, or editing an
 * existing type definition is a desktop action. The one write is a brand-new
 * team type from the Pages "New type..." dialog (`defineTeamType`): it waits
 * in memory until the room answers, so a refusal is reported to the person
 * who asked and is never re-sent on a later connect.
 *
 * Two things make the schema lane more than "parse the JSON":
 *
 *  - An override of a **builtin** arrives as a delta against the sender's
 *    builtin seed, never as a full model (#1178). It has to be resolved against
 *    *this* build's builtin, which is why the builtins are parsed here rather
 *    than assumed present.
 *  - Shared selectors read `globalRegistry`, not this store --
 *    `trackerCollections`, the grid's column derivation, the status-category
 *    lookups. Resolved models are registered there as well, exactly as the
 *    desktop schema service does, or the surfaces render a room whose types
 *    they cannot see.
 *
 * A **personal** tracker type never lands in either place. Its items live in
 * the author's own workspace and no room carries them, so projecting one here
 * would offer a selectable tracker that is permanently empty -- which reads as
 * a sync that failed, not as a tracker that was never the team's. The builtin
 * personal types are excluded at construction and an inbound definition that
 * resolves to `sharing: 'personal'` is refused, so the exclusion holds however
 * the type arrives.
 */

import { isPermanentTrackerRejection, type SyncId, type TrackerMutationRejectCode } from '@nimbalyst/tracker-engine';
import type {
  TrackerNavigationSyncHooks,
  TrackerSchemaSyncHooks,
} from '@nimbalyst/tracker-engine';
import {
  compareTrackerNavigationEntries,
  isTrackerNavigationEntry,
  type TrackerNavigationEntry,
} from '@nimbalyst/runtime/sync/trackerNavigation';
import {
  emptyLabelRegistry,
  globalRegistry,
  type LabelRegistry,
  type PredicateDefinition,
  type TrackerDataModel,
} from '@nimbalyst/tracker-schema';
import {
  isDerivedTrackerTypeDeclaration,
  resolveTrackerTypeInheritance,
  type TrackerTypeDeclaration,
} from '@nimbalyst/tracker-schema';
import {
  decodeTrackerSchemaPayload,
  encodeTrackerSchemaModelPayload,
  TRACKER_LABEL_REGISTRY_SCHEMA_TYPE,
  TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/schemaSyncPayload';
import { resolveTrackerSchemaPatch } from '@nimbalyst/tracker-schema';
import { normalizeTrackerSharingModel } from '@nimbalyst/tracker-schema';

export interface BrowserTrackerSchemaStoreOptions {
  /**
   * The builtin tracker types this build ships, the seed a delta resolves
   * against. Injected rather than imported: the builtins are authored as YAML
   * and loaded through Vite's `?raw` transform, which would drag a bundler
   * feature into the headless tracker graph the boundary gate compiles with
   * plain esbuild. A host that already carries them (`parseBuiltinTrackers`,
   * re-exported by `collab-bundle/trackers-ui`) passes them in.
   */
  builtins: readonly TrackerDataModel[];
  reportError?: (error: unknown, context: string) => void;
}

export interface BrowserTrackerSchemaState {
  /** Builtins, overlaid with whatever the room defines. Stable order by type. */
  trackerTypes: TrackerDataModel[];
  /** The team's synced sidebar tree, sorted the way every host sorts it. */
  navigationEntries: TrackerNavigationEntry[];
  /**
   * The room's predicate registry: the labels and inverse labels of the
   * relations wiki pages use. Empty until the room publishes
   * one; an unreadable publish leaves the previous registry in place.
   */
  predicates: PredicateDefinition[];
  /** The room's label registry (labels.yaml), same rules as `predicates`. */
  labels: LabelRegistry;
}

const EMPTY_STATE: BrowserTrackerSchemaState = {
  trackerTypes: [],
  navigationEntries: [],
  predicates: [],
  labels: emptyLabelRegistry(),
};

/** A type this host has no lane for: personal items never reach a team room. */
export function isPersonalTrackerModel(model: TrackerDataModel): boolean {
  return model.sharing === 'personal';
}

/**
 * Resolve one inbound schema payload into a full model.
 *
 * Returns null for a payload this build cannot resolve -- a delta against a
 * builtin it does not ship, or JSON that matches neither shape. Dropping it is
 * right: registering a half-understood type is how a tracker acquires fields
 * nobody can edit.
 *
 * Resolution only: whether the resolved type belongs on this host is the
 * store's decision, so that a personal definition and an unreadable one are
 * not confused for each other.
 */
export function resolveBrowserTrackerSchema(
  type: string,
  json: string,
  builtinSeed: (type: string) => TrackerDataModel | undefined,
): TrackerDataModel | null {
  const decoded = decodeTrackerSchemaPayload(type, json);
  if (!decoded) return null;
  if (decoded.kind === 'model') return normalizeTrackerSharingModel(decoded.model, 'team');
  // A predicate registry is not a tracker type. It arrives under its own
  // reserved schema type and is handled by `applyRemote` before this is called.
  if (decoded.kind === 'predicates' || decoded.kind === 'labels') return null;
  const seed = builtinSeed(type);
  if (!seed) return null;
  try {
    return resolveTrackerSchemaPatch(seed, decoded.patch);
  } catch {
    return null;
  }
}

export class BrowserTrackerSchemaStore {
  private readonly builtins = new Map<string, TrackerDataModel>();
  private readonly models = new Map<string, TrackerDataModel>();
  private readonly navigation = new Map<string, TrackerNavigationEntry>();
  private predicates: PredicateDefinition[] = [];
  private labels: LabelRegistry = emptyLabelRegistry();
  private readonly listeners = new Set<(state: BrowserTrackerSchemaState) => void>();
  private state: BrowserTrackerSchemaState = EMPTY_STATE;
  private disposed = false;
  /** New team types waiting on the room, by type id. */
  private readonly pendingDefinitions = new Map<string, {
    payload: string;
    resolve: () => void;
    reject: (error: Error) => void;
  }>();

  private readonly reportError?: (error: unknown, context: string) => void;

  constructor(options: BrowserTrackerSchemaStoreOptions) {
    this.reportError = options.reportError;
    for (const model of options.builtins) {
      // Every builtin stays available as a delta seed -- a room may well share
      // an override that turns one of them into a team tracker -- but only the
      // team ones are projected and registered as types this host can show.
      this.builtins.set(model.type, model);
      if (isPersonalTrackerModel(model)) continue;
      this.models.set(model.type, model);
      globalRegistry.register(model, true);
    }
    this.state = this.project();
  }

  /**
   * Schemas bootstrap from zero on every connect by design, so this lane needs
   * no cursor -- see the note on `TrackerSchemaSyncHooks`.
   */
  readonly schemaSync: TrackerSchemaSyncHooks = {
    listUnsynced: async () => [...this.pendingDefinitions.entries()]
      .map(([type, pending]) => ({ type, model: pending.payload, deleted: false, createOnly: 'required' as const })),
    // A new type settles only on the answer to its own mutation. A delta for the
    // same id from another client is that client's type, not this creation's
    // success; the room refuses this one with `schemaExists` instead.
    onSettled: ({ type, model, accepted, error }) => {
      const pending = this.pendingDefinitions.get(type);
      if (!pending || pending.payload !== model) return;
      if (accepted) {
        this.pendingDefinitions.delete(type);
        queueMicrotask(pending.resolve);
        return;
      }
      const code = error?.code ?? 'unknown';
      // A transient refusal (key rotation, custody) stays queued and is retried.
      if (code !== 'createOnlyUnsupported' && !isPermanentTrackerRejection(code as TrackerMutationRejectCode)) return;
      this.pendingDefinitions.delete(type);
      pending.reject(new Error(
        code === 'schemaExists'
          ? `Someone else just created a type named "${type}". Pick another name.`
          : error?.message || `The team room refused the new type (${code}).`,
      ));
    },
    applyRemote: async ({ type, model }) => {
      if (this.disposed) return;
      // The predicate registry (knowledge-scopes 4.1) rides this lane under a
      // reserved schema type. Registering it here is what makes section 7's
      // "the same violation reports the same code in the web console" true:
      // `TrackerDataModelRegistry.validate` is the same validator on both
      // hosts, and it needs the same registry in front of it.
      if (type === TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE) {
        const decoded = model === null ? null : decodeTrackerSchemaPayload(type, model);
        if (model !== null && decoded?.kind !== 'predicates') {
          this.reportError?.(new Error('Unreadable predicate registry'), 'tracker schema');
          return;
        }
        this.predicates = decoded?.kind === 'predicates' ? decoded.predicates : [];
        globalRegistry.setPredicates(this.predicates);
        this.emit();
        return;
      }
      if (type === TRACKER_LABEL_REGISTRY_SCHEMA_TYPE) {
        const decoded = model === null ? null : decodeTrackerSchemaPayload(type, model);
        if (model !== null && decoded?.kind !== 'labels') {
          this.reportError?.(new Error('Unreadable label registry'), 'tracker schema');
          return;
        }
        this.labels = decoded?.kind === 'labels' ? decoded.registry : emptyLabelRegistry();
        globalRegistry.setLabels(this.labels);
        this.emit();
        return;
      }
      if (model === null) {
        this.models.delete(type);
        const builtin = this.builtins.get(type);
        if (builtin && !isPersonalTrackerModel(builtin)) this.models.set(type, builtin);
        else globalRegistry.clearWorkspaceSchema(type);
      } else {
        const resolved = resolveBrowserTrackerSchema(type, model, (key) => this.builtins.get(key));
        if (!resolved) {
          this.reportError?.(new Error(`Unresolvable tracker schema for '${type}'`), 'tracker schema');
          return;
        }
        if (isPersonalTrackerModel(resolved)) {
          // Not an error: a room is free to carry a personal definition, and a
          // desktop peer will use it. This host has no personal lane, so the
          // type is dropped rather than offered as a tracker with no items.
          this.models.delete(type);
          globalRegistry.clearWorkspaceSchema(type);
        } else {
          this.models.set(type, resolved);
          globalRegistry.register(resolved);
        }
      }
      this.emit();
    },
  };

  /**
   * A zero cursor every connect, on purpose: the whole tree is a handful of
   * rows, and holding it in memory means a tab never renders a folder layout
   * the room has since changed.
   */
  readonly navigationSync: TrackerNavigationSyncHooks = {
    getMaxSyncId: async () => 0 as SyncId,
    listUnsynced: async () => [],
    applyRemote: async ({ entryId, payload }) => {
      if (this.disposed) return;
      if (payload === null) {
        this.navigation.delete(entryId);
        this.emit();
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        this.reportError?.(new Error(`Malformed navigation entry '${entryId}'`), 'tracker navigation');
        return;
      }
      if (!isTrackerNavigationEntry(parsed)) {
        this.reportError?.(new Error(`Unrecognized navigation entry '${entryId}'`), 'tracker navigation');
        return;
      }
      this.navigation.set(parsed.entryId, parsed);
      this.emit();
    },
  };

  getState(): BrowserTrackerSchemaState {
    return this.state;
  }

  /**
   * Queue a brand-new team type for the room as a create-only mutation.
   * Resolves on the room's acceptance of this mutation, rejects on its refusal
   * (including `schemaExists` when another client created the id first, and a
   * room too old to refuse an existing type). The caller flushes the schema lane.
   *
   * Creation never replaces: an id this room already defines (or a builtin)
   * is refused here, before anything is sent.
   */
  defineTeamType(declared: TrackerTypeDeclaration): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('The tracker room is closed.'));
    if (declared.sharing === 'personal') {
      return Promise.reject(new Error('The team section holds only team types.'));
    }
    const type = declared.type;
    if (this.models.has(type) || this.builtins.has(type) || this.pendingDefinitions.has(type)) {
      return Promise.reject(new Error(`A type named "${type}" already exists.`));
    }
    const { model, errors } = resolveTrackerTypeInheritance(declared, (key) => this.models.get(key));
    if (!model) return Promise.reject(new Error(errors[0]?.message ?? `Type '${type}' could not be resolved.`));
    const payload = encodeTrackerSchemaModelPayload(
      normalizeTrackerSharingModel(model, 'team'),
      isDerivedTrackerTypeDeclaration(declared) ? declared : null,
    );
    return new Promise<void>((resolve, reject) => {
      this.pendingDefinitions.set(type, { payload, resolve, reject });
    });
  }

  subscribe(listener: (state: BrowserTrackerSchemaState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    for (const pending of this.pendingDefinitions.values()) {
      pending.reject(new Error('The tracker room closed before the new type was saved.'));
    }
    this.pendingDefinitions.clear();
    // The registry is process-wide. Leaving one room's custom types registered
    // would let them surface in the next room this tab opens.
    globalRegistry.clearWorkspaceSchemas();
  }

  private project(): BrowserTrackerSchemaState {
    return {
      trackerTypes: [...this.models.values()].sort((left, right) => left.type.localeCompare(right.type)),
      navigationEntries: [...this.navigation.values()].sort(compareTrackerNavigationEntries),
      predicates: this.predicates,
      labels: this.labels,
    };
  }

  private emit(): void {
    if (this.disposed) return;
    this.state = this.project();
    for (const listener of this.listeners) listener(this.state);
  }
}
