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
import type { TrackerNavigationSyncHooks, TrackerSchemaSyncHooks } from '@nimbalyst/tracker-engine';
import { type TrackerNavigationEntry } from '../../../../runtime/src/sync/trackerNavigation';
import { type LabelRegistry, type PredicateDefinition, type TrackerDataModel } from '../../../../tracker-schema/src/browser';
import { type TrackerTypeDeclaration } from '../../../../tracker-schema/src/browser';
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
/** A type this host has no lane for: personal items never reach a team room. */
export declare function isPersonalTrackerModel(model: TrackerDataModel): boolean;
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
export declare function resolveBrowserTrackerSchema(type: string, json: string, builtinSeed: (type: string) => TrackerDataModel | undefined): TrackerDataModel | null;
export declare class BrowserTrackerSchemaStore {
    private readonly builtins;
    private readonly models;
    private readonly navigation;
    private predicates;
    private labels;
    private readonly listeners;
    private state;
    private disposed;
    /** New team types waiting on the room, by type id. */
    private readonly pendingDefinitions;
    private readonly reportError?;
    constructor(options: BrowserTrackerSchemaStoreOptions);
    /**
     * Schemas bootstrap from zero on every connect by design, so this lane needs
     * no cursor -- see the note on `TrackerSchemaSyncHooks`.
     */
    readonly schemaSync: TrackerSchemaSyncHooks;
    /**
     * A zero cursor every connect, on purpose: the whole tree is a handful of
     * rows, and holding it in memory means a tab never renders a folder layout
     * the room has since changed.
     */
    readonly navigationSync: TrackerNavigationSyncHooks;
    getState(): BrowserTrackerSchemaState;
    /**
     * Queue a brand-new team type for the room as a create-only mutation.
     * Resolves on the room's acceptance of this mutation, rejects on its refusal
     * (including `schemaExists` when another client created the id first, and a
     * room too old to refuse an existing type). The caller flushes the schema lane.
     *
     * Creation never replaces: an id this room already defines (or a builtin)
     * is refused here, before anything is sent.
     */
    defineTeamType(declared: TrackerTypeDeclaration): Promise<void>;
    subscribe(listener: (state: BrowserTrackerSchemaState) => void): () => void;
    dispose(): void;
    private project;
    private emit;
}
