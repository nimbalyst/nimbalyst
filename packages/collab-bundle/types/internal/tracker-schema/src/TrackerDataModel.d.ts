/**
 * Core types and interfaces for the unified tracker system
 */
import type { StatusCategory } from './trackerStatusCategory.js';
import { type DerivedTrackerTypeDeclaration } from './trackerTypeInheritance.js';
import { type PredicateDefinition } from './predicateRegistry.js';
import { type EffectiveProperty, type LabeledItem, type LabelRegistry } from './labelRegistry.js';
export type FieldType = 'string' | 'text' | 'number' | 'select' | 'multiselect' | 'date' | 'datetime' | 'boolean' | 'user'
/** First-class link to other tracker item(s). See {@link RelationshipFieldDefinition}. */
 | 'relationship'
/** @deprecated Legacy inert link type; treated as a `relationship` alias. */
 | 'reference' | 'url'
/**
 * Multi-valued evidence: each entry names a `citation` item. See
 * {@link CitationFieldValue} and knowledge-scopes contract 4.1.
 */
 | 'citation'
/**
 * The id of a predicate in the project's registry, carried as DATA rather
 * than declared on the field (knowledge-scopes contract 4.1).
 *
 * The distinction is what the `claim` kind needs. A relationship field
 * declaring `predicate: integrates-with` binds one verb for every value it
 * will ever hold, which is right for a typed entity with an `integrations`
 * field. A claim's verb varies per item -- that is the whole point of a
 * generic statement kind -- so it cannot come from the declaration, and
 * without this type it was an unchecked string in which a typo produced a
 * statement that validated and meant nothing.
 */
 | 'predicate-ref'
/**
 * Label ids from the project's label registry (`labelRegistry.ts`), carried
 * as data like `predicate-ref`. Multi-valued; an unknown label is a warning,
 * never a rejection, because an agent may apply a label that is still a
 * pending proposal.
 */
 | 'label-ref' | 'array' | 'object';
/**
 * Declared shape of an `object` field's value (or of each entry, on an
 * `array` of objects). Without this a validator cannot tell a locator from any
 * other JSON blob, and the alternative -- keying validation off the field's
 * name -- would make `locator` mean something everywhere in the product.
 *
 * `citation-locator` is knowledge-scopes contract 4.4 (plus 4.9's `scope-node`),
 * validated by `validateCitationLocator` in `./citationLocator.ts`.
 */
export type TrackerObjectShape = 'citation-locator';
/**
 * Stored shape of a 'url' field. The label is optional and renders as the
 * display text when present; otherwise the URL itself is shown.
 */
export interface UrlFieldValue {
    url: string;
    label?: string;
}
export interface FieldOption {
    value: string;
    label: string;
    icon?: string;
    color?: string;
    /**
     * Lifecycle position, on the field carrying the `workflowStatus` role.
     * Declared rather than inferred from the value's name — see
     * `trackerStatusCategory.ts` for why, and for what an absent category
     * resolves to. Ignored on every other select field.
     */
    category?: StatusCategory;
}
export interface FieldDefinition {
    name: string;
    type: FieldType;
    required?: boolean;
    default?: any;
    displayInline?: boolean;
    readOnly?: boolean;
    minLength?: number;
    maxLength?: number;
    min?: number;
    max?: number;
    options?: FieldOption[];
    itemType?: FieldType;
    schema?: FieldDefinition[];
    /**
     * For `object` (and `array` of `object`): what the value is, so it can be
     * validated and rendered as that thing rather than as opaque JSON.
     */
    objectShape?: TrackerObjectShape;
    /** Vocabulary/behavior key, e.g. `depends-on`, `blocks`, `relates-to`. */
    relationshipTypeKey?: string;
    /**
     * Predicate id from the project's registry (knowledge-scopes contract 4.1).
     * Present makes this field's values STATEMENTS: the field's type must be able
     * to carry the predicate's value shape, and the owning type must be one of
     * its subject kinds. A statement is just the named relation; it carries no
     * qualifiers.
     *
     * Distinct from `relationshipTypeKey` on purpose. That key is a display and
     * behavior hint resolved against a hardcoded vocabulary and never validated;
     * a predicate is a declared contract the room owns and publishes. A field may
     * carry both -- the key drives the label and the inverse wiring, the
     * predicate drives validation -- and a field that carries neither is the
     * ordinary link every existing relationship field already is.
     */
    predicate?: string;
    /** Allowed target tracker types, or `'*'` for any. */
    targetTrackerTypes?: string[] | '*';
    /** True = array of targets (add-wins set); false/undefined = single target. */
    multiValue?: boolean;
    /** Field id on the target type that holds the inverse value (Phase 3). */
    inverseFieldId?: string;
    /** Relationship key of the inverse direction, e.g. `blocks` for `depends-on`. */
    inverseRelationshipTypeKey?: string;
    /** The relationship reads the same both directions (e.g. `relates-to`). */
    symmetric?: boolean;
    /** Unresolved targets block marking the owning item complete. */
    preventsCompletion?: boolean;
    /** Models a parent/child hierarchy edge (cycle-checked in field-aware tools). */
    childRelationship?: boolean;
    /** Allow an item to link to itself on this field (default: reject self-links). */
    allowSelfLink?: boolean;
}
/**
 * A single related-item reference stored inside a relationship field's value.
 *
 * Carries enough denormalized display data (title, type, issueKey) to render a
 * pill without a lookup on every paint. `itemId` is the stable identity used for
 * dedup and the add-wins set semantics.
 */
export interface TrackerRelationshipValue {
    itemId: string;
    issueKey?: string;
    title?: string;
    trackerType?: string;
    relationshipTypeKey?: string;
    direction?: 'out';
    metadata?: Record<string, unknown>;
    /**
     * Pins this reference to one exact revision of the target (knowledge-scopes
     * contract 4.2). Absent means the live item, which is the behavior every
     * existing relationship field has and keeps.
     *
     * A UUID, never the room-assigned number: `serverRevision` does not exist in
     * the personal scope and does not exist for a team item until its write
     * syncs, so pinning it would force this value to be rewritten later, and
     * rewriting a binding in place is what contract 4.9 forbids.
     */
    revisionId?: string;
    /** Room-assigned display number for `revisionId`. Advisory; never resolves. */
    serverRevision?: number;
}
/** What a citation says about the claim it is attached to (contract 4.4). */
export type CitationRelation = 'supports' | 'challenges' | 'context';
/**
 * One entry in a `citation` field: a reference to a `citation` tracker item.
 *
 * Deliberately does NOT denormalize the locator. The citation item owns it,
 * and a second copy sitting on every referencing item would drift with nothing
 * in the data saying which one the evidence actually rests on. `title` and
 * `relation` are copied because a chip has to render without a lookup on every
 * paint, and both are cosmetic if stale; a locator is not.
 */
export interface CitationFieldValue {
    itemId: string;
    issueKey?: string;
    title?: string;
    relation?: CitationRelation;
}
export interface StatusBarLayoutRow {
    row: Array<{
        field: string;
        width: number | 'auto';
    }>;
}
export interface TrackerModes {
    inline: boolean;
    fullDocument: boolean;
}
export interface TableViewConfig {
    defaultColumns: string[];
    sortable: boolean;
    filterable: boolean;
    exportable: boolean;
}
/** A tracker owns its schema and items together: personally or as a team artifact. */
export type TrackerSharing = 'personal' | 'team';
export interface TrackerSharingPolicy {
    sharing: TrackerSharing;
    /** Team trackers can create private drafts while reusing the existing per-item published bit. */
    draftByDefault: boolean;
}
/**
 * Semantic roles that map product concepts to schema-defined field names.
 * A role answers "which field in this schema represents X?" so the product
 * can find e.g. the workflow status field without assuming it's called "status".
 */
export type TrackerSchemaRole = 'title' | 'workflowStatus' | 'priority' | 'assignee' | 'reporter' | 'tags' | 'startDate' | 'dueDate' | 'progress'
/**
 * Field carrying the item's external identity (e.g. a PR number or imported
 * issue key). Shown next to the local issue key on compact surfaces like
 * kanban cards. url-type fields contribute their display label.
 */
 | 'externalKey'
/**
 * Unlike the other roles, this maps to a STATUS VALUE (not a field name):
 * the workflow status to set when a pull request referenced by an item of
 * this type is merged from the PR view. Types that omit it get an activity
 * comment on merge instead of a status transition.
 */
 | 'prMergedStatus';
export interface TrackerDataModel {
    type: string;
    /**
     * Base type this one inherits fields, statuses, and roles from. Present on a
     * derived declaration and preserved on its resolved form so consumers can see
     * the lineage. See `trackerTypeInheritance.ts` for the narrowing rules.
     */
    extends?: string;
    displayName: string;
    displayNamePlural: string;
    icon: string;
    color: string;
    modes: TrackerModes;
    idPrefix: string;
    idFormat: 'ulid' | 'uuid' | 'sequential';
    fields: FieldDefinition[];
    statusBarLayout?: StatusBarLayoutRow[];
    inlineTemplate?: string;
    tableView?: TableViewConfig;
    /** Whether the tracker schema and its items are personal or team-owned. Defaults to personal. */
    sharing?: TrackerSharing;
    /** Whether new items in a team tracker begin as private drafts. Defaults to false. */
    draftByDefault?: boolean;
    /**
     * Retired: the tracker is no longer used, but every item is kept, stays
     * visible and searchable, and keeps its issue key. Archiving is the answer to
     * "we should stop using this tracker" — it is deliberately NOT a demotion
     * back to personal, which would strand teammates' items, and NOT a delete.
     * Read-only is the only behavioral consequence.
     */
    archived?: boolean;
    /**
     * Give items of this type machine-private local numbers (`NIM.75`). Off
     * unless the type opts in. Team issue keys (`NIM-123`) are unaffected, and a
     * number already issued stays readable and resolvable after opting out.
     */
    localNumbers?: boolean;
    /**
     * Where the type's items live in a Local wiki (`@nimbalyst/local-wiki`
     * FORMAT.md): one markdown page per item, or one CSV for the type. Only a
     * type that declares it is a wiki type; without it the items stay in the app
     * database. Kept as written so the `nim` CLI and the app agree.
     */
    storage?: 'pages' | 'table';
    /** If false, items of this type cannot be created via tracker_create. Defaults to true. */
    creatable?: boolean;
    /**
     * Keep this type out of type lists and create menus until the named type is
     * registered. It stays registered and resolvable, so existing items still
     * render. The knowledge evidence kinds use it to stay out of the way until a
     * workspace defines `claim`.
     */
    hiddenUntilType?: string;
    /** Whether this type can be used as a primary type. Defaults to true. */
    primaryCapable?: boolean;
    /**
     * Opt out of the auto-injected `tags` field/role. Defaults to true (tags supported).
     * The registry adds a standard `tags` array field and declares the `tags` role
     * when neither is already present, so every tracker type gets consistent tag
     * behavior without each schema needing to restate it.
     */
    supportsTags?: boolean;
    /**
     * Maps semantic roles to field names in this schema.
     * Allows the product to find e.g. "which field is the workflow status?"
     * without hardcoding field names like "status".
     */
    roles?: Partial<Record<TrackerSchemaRole, string>>;
}
/**
 * Validation result
 */
export interface ValidationIssue {
    field: string;
    message: string;
    /**
     * Stable machine-readable reason, when the check that produced this issue has
     * one. Messages are written for people and are free to change; a code is what
     * a caller may branch on, and it is how desktop, the web console, and both
     * MCP surfaces report the same rejection identically. Optional because most
     * of the checks here predate codes and have no caller that branches.
     */
    code?: string;
}
export interface ValidationResult {
    valid: boolean;
    errors: ValidationIssue[];
    /**
     * Non-fatal issues that must NOT block a write. An unknown select value (a
     * status an override removed/renamed, or one a peer on a different schema set)
     * lands here so the value is preserved rather than destroyed — the write path
     * treats warnings as advisory. See configurable-builtin-tracker-types plan.
     */
    warnings?: ValidationIssue[];
}
/**
 * Data model registry
 */
export declare class TrackerDataModelRegistry {
    private models;
    /** Track which types are built-in (survive workspace switches) vs workspace-specific */
    private builtinTypes;
    /** Original built-in definitions, so a workspace override can be cleared. */
    private builtinModels;
    private listeners;
    /**
     * Schema layers for workspaces OTHER than the active one (path -> type -> model).
     *
     * The `models` map above is the resolved view of the ACTIVE workspace. A
     * background reader (the in-process MCP server serving a tool call for a
     * different project) must be able to see that project's custom types without
     * overwriting the active project's identically-named types — the registry is
     * keyed by type name only, so `register()` from workspace B used to silently
     * replace workspace A's `widget` schema and corrupt A's validation (#1035).
     */
    private workspaceLayers;
    /** Workspace path that `models` currently represents, if any. */
    private activeWorkspace;
    /**
     * Supplies the workspace a read should resolve against, when the caller is
     * operating on behalf of a non-active workspace. Installed by the host
     * (Electron main uses AsyncLocalStorage); undefined means "use the active view".
     */
    private scopeProvider;
    /**
     * Declared form of every derived type (`extends`), keyed by type name. The
     * resolved form lives in `models`; keeping the declaration is what lets a
     * later change to a base type re-reach its derived types without anyone
     * editing them. Also what the sync payload carries alongside the resolved
     * form, so a peer resolves against ITS base.
     */
    private declarations;
    /**
     * The project's predicate registry (contract 4.1), the sibling schema
     * artifact to the type definitions above. It lives here rather than in its
     * own singleton for one reason: `validate()` is where a statement-bearing
     * field is checked against its predicate, and it already has the model in hand. Splitting the
     * two would mean every write path had to thread a second registry through to
     * the place that needs both.
     *
     * Layered exactly like `models`, and for the same reason (#1035): a
     * background read on behalf of a NON-active workspace must see that project's
     * predicates without overwriting the open project's. Predicates are
     * server-owned per project, so a `team:` id collision across two open
     * projects is the expected case, not an edge one.
     */
    private predicates;
    private workspacePredicateLayers;
    /**
     * The project's label registry (`.nimbalyst/labels.yaml`), layered exactly
     * like predicates and for the same reason. Replaced whole on publish.
     */
    private labelRegistry;
    private workspaceLabelLayers;
    register(model: TrackerDataModel | DerivedTrackerTypeDeclaration, builtin?: boolean): void;
    /**
     * Store a derived declaration and resolve it. A declaration whose base is not
     * registered YET stays pending rather than throwing: types arrive in whatever
     * order the room published them. Any other resolution failure throws, so a
     * declaration that violates the narrowing rules cannot register a model that
     * silently drops base fields.
     */
    private registerDerived;
    /** The declaration a resolution should read for `type`: derived form first. */
    private declaredFor;
    /** Re-resolve every derived type against the current base set. */
    private resolveDeclarations;
    /** The authored form of a derived type, or undefined for a plain type. */
    getDeclaredModel(type: string): DerivedTrackerTypeDeclaration | undefined;
    /** Derived types whose base has not been registered, for diagnostics. */
    getUnresolvedDerivedTypes(): string[];
    /** Remove a specific type from the registry. Cannot remove built-in types. */
    unregister(type: string): boolean;
    /**
     * Remove one workspace-provided schema. Built-in overrides restore the
     * original built-in model; custom workspace types are deleted.
     */
    clearWorkspaceSchema(type: string): boolean;
    /**
     * Remove all workspace-specific (non-builtin) schemas.
     * Call this on workspace switch to prevent schemas from workspace A
     * leaking into workspace B.
     *
     * `keepVocabulary` is for reloading the SAME workspace's schemas: the label
     * and predicate registries stay in force, so no listener ever observes them
     * empty, and the caller replaces them whole once the fresh copy arrives.
     */
    clearWorkspaceSchemas(options?: {
        keepVocabulary?: boolean;
    }): void;
    /** Subscribe to registry changes. Returns an unsubscribe function. */
    onChange(fn: () => void): () => void;
    /**
     * Install the ambient scope resolver. The host calls this once; returning a
     * workspace path from `fn` makes reads on the current async context resolve
     * against that workspace's layer instead of the active view.
     */
    setScopeProvider(fn: (() => string | null | undefined) | null): void;
    /**
     * Declare which workspace the live `models` view represents. Any cached layer
     * for that workspace is dropped — the live view supersedes it (and the caller
     * reloads it from disk).
     */
    setActiveWorkspace(workspacePath: string | null): void;
    /** The workspace the live view currently represents, if declared. */
    getActiveWorkspace(): string | null;
    /**
     * Replace the cached schema layer for a NON-active workspace. Does not touch
     * the active view, so a read-only lookup for another project can never
     * clobber the open project's schemas. No change notification is emitted:
     * nothing the active workspace can observe has changed.
     */
    setWorkspaceLayer(workspacePath: string, models: TrackerDataModel[]): void;
    /** Drop a cached non-active workspace layer. */
    clearWorkspaceLayer(workspacePath: string): void;
    /**
     * Replace the active view's predicate registry.
     *
     * Replace, not merge: the registry is published by the room as a whole
     * artifact, so a merge would silently keep a predicate the team deleted and
     * every client's view of "what verbs exist" would depend on what it happened
     * to have seen before.
     */
    setPredicates(predicates: readonly PredicateDefinition[]): void;
    /** Replace the cached registry for a NON-active workspace. No notification. */
    setWorkspacePredicateLayer(workspacePath: string, predicates: readonly PredicateDefinition[]): void;
    /**
     * The registry a read should resolve against.
     *
     * Note the absence of a builtin fallback, which `get()` has for types: there
     * are no builtin predicates. A project with no published registry has no
     * predicates, and a field declaring one there reports `PREDICATE_UNKNOWN`,
     * which is the truthful answer.
     */
    private scopedPredicates;
    getPredicate(id: string): PredicateDefinition | undefined;
    getAllPredicates(): PredicateDefinition[];
    /** Resolve for an EXPLICIT workspace, with no dependence on async context. */
    getPredicateForWorkspace(workspacePath: string | null | undefined, id: string): PredicateDefinition | undefined;
    /** Replace the active view's label registry. */
    setLabels(registry: LabelRegistry): void;
    /** Replace the cached label registry for a NON-active workspace. No notification. */
    setWorkspaceLabelLayer(workspacePath: string, registry: LabelRegistry): void;
    /** The label registry a read should resolve against (scoped like predicates). */
    getLabelRegistry(): LabelRegistry;
    getLabelRegistryForWorkspace(workspacePath: string | null | undefined): LabelRegistry;
    /**
     * Whether items of this type carry labels: the type declares a `label-ref`
     * field. Everything else (a bug whose free-form tags live in a `labels`
     * array, a type with its own `kind`) gets no label fields, no label value
     * checks, and no unknown-label warnings. Rendering and validation gate
     * {@link resolveLabels} and {@link effectiveProperties} on this.
     */
    acceptsLabels(trackerType: string): boolean;
    /** Item labels plus legacy `kind`, closed under `broader`. */
    resolveLabels(item: LabeledItem): string[];
    /** Union of properties over the item's effective labels, own labels first. */
    effectiveProperties(item: LabeledItem): EffectiveProperty[];
    labelDescendants(labelId: string): string[];
    /** Instance-table columns: the label's properties, then its ancestors'. */
    tableColumns(labelId: string): EffectiveProperty[];
    private isPredicate;
    /** The `extends` base of a type, for predicate subject-kind resolution. */
    private baseOf;
    /**
     * The layer a read should resolve against, or null to use the active view.
     *
     * When no workspace has claimed the live view (`activeWorkspace === null`)
     * every read stays unscoped: the view is nobody's to corrupt, and scoping it
     * would hide types registered before any workspace window opened (NIM-760).
     */
    private scopedLayer;
    get(type: string): TrackerDataModel | undefined;
    /** True when a cached layer exists for a non-active workspace. */
    hasWorkspaceLayer(workspacePath: string): boolean;
    /**
     * Resolve a type on behalf of an EXPLICIT workspace, with no dependence on
     * ambient async context (#1359 / NIM-3702).
     *
     * `get()` reaches the right answer only when a scope provider is installed on
     * the current async context, which is true for exactly one consumer — the MCP
     * HTTP server, which wraps a whole request. The tracker sync lane is driven
     * from a WebSocket `onStatusChange` callback that has no such relationship to
     * whoever opened the workspace, so it lost the scope and read the *other*
     * project's schemas. Callers that already hold a workspace path use this.
     *
     * Note the builtin fallback: `get()`'s unscoped branch does not have one, so
     * a miss there returned `undefined` even for `bug`/`task`/`plan`/`decision`,
     * all of which ship `sharing: team`. Both branches fall back here.
     */
    getForWorkspace(workspacePath: string | null | undefined, type: string): TrackerDataModel | undefined;
    getAll(): TrackerDataModel[];
    has(type: string): boolean;
    /** The types a user should be offered: `getAll()` minus types still waiting on `hiddenUntilType`. */
    getListed(): TrackerDataModel[];
    isBuiltin(type: string): boolean;
    /**
     * The original built-in model for a type, if any — the seed that a workspace
     * or synced patch layers onto. Unaffected by workspace overrides currently in
     * the `models` map, so patch resolution never double-applies.
     */
    getBuiltinModel(type: string): TrackerDataModel | undefined;
    validate(type: string, data: Record<string, any>): ValidationResult;
    /**
     * Validate one statement-bearing field against the project's predicate
     * registry (contract 4.1).
     *
     * Two checks, in the order they answer "whose fault is this":
     *
     *  1. The predicate exists. If it does not, nothing below is knowable.
     *  2. The registry still agrees with the field DECLARATION -- value shape and
     *     subject kind. These are schema properties, not data properties, so they
     *     are reported ONCE for the field rather than per entry, and they are
     *     checked here as well as at declaration time because the registry can
     *     move under a field that was valid when it was written. That is exactly
     *     the destructive case `trackerPredicateRegistryChangeClassifier` exists
     *     to gate, and this is what the gate protects.
     */
    private validatePredicateField;
}
export declare const globalRegistry: TrackerDataModelRegistry;
/**
 * Ensure a tracker model has tag support unless it explicitly opts out via
 * `supportsTags: false`. Adds the `tags` field and/or the `tags` role if they
 * aren't already declared. Returns the original model unchanged when nothing
 * needs to be added, so models that already declare tags keep their exact
 * field ordering and custom role target.
 */
export declare function ensureTagsSupport(model: TrackerDataModel): TrackerDataModel;
/**
 * Get the field name that fulfills a given role in a tracker data model.
 * Returns undefined if the model doesn't declare that role.
 */
export declare function getRoleField(model: TrackerDataModel, role: TrackerSchemaRole): string | undefined;
/**
 * Look up the FieldDefinition for a role in a given tracker type.
 * Returns undefined if the type doesn't exist, doesn't declare the role,
 * or the role's field name doesn't match any field definition.
 */
export declare function getFieldByRole(registry: TrackerDataModelRegistry, type: string, role: TrackerSchemaRole): FieldDefinition | undefined;
/**
 * Resolve the available fields for an item with multiple type tags.
 * Returns the union of all tag types' fields. Primary type (first tag) takes
 * precedence for duplicate field names.
 */
export declare function resolveFields(typeTags: string[]): FieldDefinition[];
