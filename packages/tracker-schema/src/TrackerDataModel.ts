/**
 * Core types and interfaces for the unified tracker system
 */

// Type-only, so the mutual reference with trackerStatusCategory.ts (which reads
// the registry defined here) is erased at compile time rather than becoming a
// runtime import cycle.
import type { StatusCategory } from './trackerStatusCategory.js';
import {
  isDerivedTrackerTypeDeclaration,
  resolveTrackerTypeInheritance,
  type DerivedTrackerTypeDeclaration,
} from './trackerTypeInheritance.js';
import { validateCitationLocator, validateCitationLocatorList } from './citationLocator.js';
import {
  isSubjectKindAllowed,
  predicateValueShapeAcceptsFieldType,
  type PredicateDefinition,
} from './predicateRegistry.js';
import {
  effectiveProperties as resolveEffectiveProperties,
  emptyLabelRegistry,
  isLabelRegistryEmpty,
  labelDescendants as resolveLabelDescendants,
  resolveLabels as resolveItemLabels,
  tableColumns as resolveTableColumns,
  validateFieldPropertyValue,
  validateLabelRefValue,
  type EffectiveProperty,
  type LabeledItem,
  type LabelRegistry,
} from './labelRegistry.js';

export type FieldType =
  | 'string'
  | 'text'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'date'
  | 'datetime'
  | 'boolean'
  | 'user'
  /** First-class link to other tracker item(s). See {@link RelationshipFieldDefinition}. */
  | 'relationship'
  /** @deprecated Legacy inert link type; treated as a `relationship` alias. */
  | 'reference'
  | 'url'
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
  | 'label-ref'
  | 'array'
  | 'object';

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

  // For string/text
  minLength?: number;
  maxLength?: number;

  // For number
  min?: number;
  max?: number;

  // For select/multiselect
  options?: FieldOption[];

  // For array
  itemType?: FieldType;
  schema?: FieldDefinition[];

  /**
   * For `object` (and `array` of `object`): what the value is, so it can be
   * validated and rendered as that thing rather than as opaque JSON.
   */
  objectShape?: TrackerObjectShape;

  // For relationship (Epic C). Present when `type === 'relationship'` (or the
  // legacy `reference` alias). A relationship value is a collection field that
  // syncs on the metadata socket exactly like `labels` — see
  // tracker-relationships-design.md.
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
export type TrackerSchemaRole =
  | 'title'
  | 'workflowStatus'
  | 'priority'
  | 'assignee'
  | 'reporter'
  | 'tags'
  | 'startDate'
  | 'dueDate'
  | 'progress'
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
export class TrackerDataModelRegistry {
  private models: Map<string, TrackerDataModel> = new Map();
  /** Track which types are built-in (survive workspace switches) vs workspace-specific */
  private builtinTypes: Set<string> = new Set();
  /** Original built-in definitions, so a workspace override can be cleared. */
  private builtinModels: Map<string, TrackerDataModel> = new Map();
  private listeners: Set<() => void> = new Set();
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
  private workspaceLayers: Map<string, Map<string, TrackerDataModel>> = new Map();
  /** Workspace path that `models` currently represents, if any. */
  private activeWorkspace: string | null = null;
  /**
   * Supplies the workspace a read should resolve against, when the caller is
   * operating on behalf of a non-active workspace. Installed by the host
   * (Electron main uses AsyncLocalStorage); undefined means "use the active view".
   */
  private scopeProvider: (() => string | null | undefined) | null = null;
  /**
   * Declared form of every derived type (`extends`), keyed by type name. The
   * resolved form lives in `models`; keeping the declaration is what lets a
   * later change to a base type re-reach its derived types without anyone
   * editing them. Also what the sync payload carries alongside the resolved
   * form, so a peer resolves against ITS base.
   */
  private declarations: Map<string, { declared: DerivedTrackerTypeDeclaration; builtin: boolean }> = new Map();
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
  private predicates: Map<string, PredicateDefinition> = new Map();
  private workspacePredicateLayers: Map<string, Map<string, PredicateDefinition>> = new Map();
  /**
   * The project's label registry (`.nimbalyst/labels.yaml`), layered exactly
   * like predicates and for the same reason. Replaced whole on publish.
   */
  private labelRegistry: LabelRegistry = emptyLabelRegistry();
  private workspaceLabelLayers: Map<string, LabelRegistry> = new Map();

  register(model: TrackerDataModel | DerivedTrackerTypeDeclaration, builtin = false): void {
    if (isDerivedTrackerTypeDeclaration(model)) {
      this.registerDerived(model, builtin);
      return;
    }
    const normalized = ensureTagsSupport(model);
    this.models.set(normalized.type, normalized);
    if (builtin) {
      this.builtinTypes.add(normalized.type);
      this.builtinModels.set(normalized.type, normalized);
    }
    // A base change must reach everything that extends it, directly or not.
    this.resolveDeclarations();
    this.listeners.forEach(fn => fn());
  }

  /**
   * Store a derived declaration and resolve it. A declaration whose base is not
   * registered YET stays pending rather than throwing: types arrive in whatever
   * order the room published them. Any other resolution failure throws, so a
   * declaration that violates the narrowing rules cannot register a model that
   * silently drops base fields.
   */
  private registerDerived(declared: DerivedTrackerTypeDeclaration, builtin: boolean): void {
    const { errors } = resolveTrackerTypeInheritance(declared, type => this.declaredFor(type));
    const fatal = errors.filter(e => e.code !== 'INHERITANCE_UNKNOWN_BASE');
    if (fatal.length > 0) {
      throw new Error(`Cannot register tracker type '${declared.type}': ${fatal.map(e => e.message).join('; ')}`);
    }
    this.declarations.set(declared.type, { declared, builtin });
    if (builtin) this.builtinTypes.add(declared.type);
    this.resolveDeclarations();
    this.listeners.forEach(fn => fn());
  }

  /** The declaration a resolution should read for `type`: derived form first. */
  private declaredFor(type: string): TrackerDataModel | DerivedTrackerTypeDeclaration | undefined {
    return this.declarations.get(type)?.declared ?? this.models.get(type) ?? this.builtinModels.get(type);
  }

  /** Re-resolve every derived type against the current base set. */
  private resolveDeclarations(): void {
    for (const [type, { declared, builtin }] of this.declarations) {
      const { model } = resolveTrackerTypeInheritance(declared, t => this.declaredFor(t));
      if (!model) {
        // Base went away (or never arrived). Drop the stale resolved form
        // rather than leaving a model that no longer matches any declaration.
        this.models.delete(type);
        if (builtin) this.builtinModels.delete(type);
        continue;
      }
      const normalized = ensureTagsSupport(model);
      this.models.set(type, normalized);
      if (builtin) this.builtinModels.set(type, normalized);
    }
  }

  /** The authored form of a derived type, or undefined for a plain type. */
  getDeclaredModel(type: string): DerivedTrackerTypeDeclaration | undefined {
    return this.declarations.get(type)?.declared;
  }

  /** Derived types whose base has not been registered, for diagnostics. */
  getUnresolvedDerivedTypes(): string[] {
    return Array.from(this.declarations.keys()).filter(type => !this.models.has(type));
  }

  /** Remove a specific type from the registry. Cannot remove built-in types. */
  unregister(type: string): boolean {
    if (this.builtinTypes.has(type)) return false;
    const removed = this.models.delete(type);
    const removedDeclaration = this.declarations.delete(type);
    if (removed || removedDeclaration) this.listeners.forEach(fn => fn());
    return removed;
  }

  /**
   * Remove one workspace-provided schema. Built-in overrides restore the
   * original built-in model; custom workspace types are deleted.
   */
  clearWorkspaceSchema(type: string): boolean {
    let changed = false;
    if (this.builtinTypes.has(type)) {
      const builtin = this.builtinModels.get(type);
      if (builtin && this.models.get(type) !== builtin) {
        this.models.set(type, builtin);
        changed = true;
      }
    } else {
      changed = this.models.delete(type);
      if (this.declarations.delete(type)) changed = true;
    }
    if (changed) this.listeners.forEach(fn => fn());
    return changed;
  }

  /**
   * Remove all workspace-specific (non-builtin) schemas.
   * Call this on workspace switch to prevent schemas from workspace A
   * leaking into workspace B.
   *
   * `keepVocabulary` is for reloading the SAME workspace's schemas: the label
   * and predicate registries stay in force, so no listener ever observes them
   * empty, and the caller replaces them whole once the fresh copy arrives.
   */
  clearWorkspaceSchemas(options: { keepVocabulary?: boolean } = {}): void {
    let changed = false;
    if (!options.keepVocabulary) {
      // Every predicate is workspace-provided -- there are no builtins -- so the
      // whole registry goes. Leaving it would let workspace A's verbs validate
      // workspace B's statements, which is the #1035 leak in a second artifact.
      if (this.predicates.size > 0) {
        this.predicates = new Map();
        changed = true;
      }
      if (!isLabelRegistryEmpty(this.labelRegistry)) changed = true;
      this.labelRegistry = emptyLabelRegistry();
    }
    for (const type of Array.from(this.models.keys())) {
      if (this.builtinTypes.has(type)) {
        const builtin = this.builtinModels.get(type);
        if (builtin && this.models.get(type) !== builtin) {
          this.models.set(type, builtin);
          changed = true;
        }
      } else {
        this.models.delete(type);
        this.declarations.delete(type);
        changed = true;
      }
    }
    if (changed) this.listeners.forEach(fn => fn());
  }

  /** Subscribe to registry changes. Returns an unsubscribe function. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  // -------------------------------------------------------------------------
  // Workspace scoping (#1035)
  // -------------------------------------------------------------------------

  /**
   * Install the ambient scope resolver. The host calls this once; returning a
   * workspace path from `fn` makes reads on the current async context resolve
   * against that workspace's layer instead of the active view.
   */
  setScopeProvider(fn: (() => string | null | undefined) | null): void {
    this.scopeProvider = fn;
  }

  /**
   * Declare which workspace the live `models` view represents. Any cached layer
   * for that workspace is dropped — the live view supersedes it (and the caller
   * reloads it from disk).
   */
  setActiveWorkspace(workspacePath: string | null): void {
    this.activeWorkspace = workspacePath;
    if (workspacePath) {
      this.workspaceLayers.delete(workspacePath);
      this.workspacePredicateLayers.delete(workspacePath);
      this.workspaceLabelLayers.delete(workspacePath);
    }
  }

  /** The workspace the live view currently represents, if declared. */
  getActiveWorkspace(): string | null {
    return this.activeWorkspace;
  }

  /**
   * Replace the cached schema layer for a NON-active workspace. Does not touch
   * the active view, so a read-only lookup for another project can never
   * clobber the open project's schemas. No change notification is emitted:
   * nothing the active workspace can observe has changed.
   */
  setWorkspaceLayer(workspacePath: string, models: TrackerDataModel[]): void {
    const layer = new Map<string, TrackerDataModel>();
    for (const model of models) {
      const normalized = ensureTagsSupport(model);
      layer.set(normalized.type, normalized);
    }
    this.workspaceLayers.set(workspacePath, layer);
  }

  /** Drop a cached non-active workspace layer. */
  clearWorkspaceLayer(workspacePath: string): void {
    this.workspaceLayers.delete(workspacePath);
    this.workspacePredicateLayers.delete(workspacePath);
    this.workspaceLabelLayers.delete(workspacePath);
  }

  // -------------------------------------------------------------------------
  // Predicate registry (contract 4.1)
  // -------------------------------------------------------------------------

  /**
   * Replace the active view's predicate registry.
   *
   * Replace, not merge: the registry is published by the room as a whole
   * artifact, so a merge would silently keep a predicate the team deleted and
   * every client's view of "what verbs exist" would depend on what it happened
   * to have seen before.
   */
  setPredicates(predicates: readonly PredicateDefinition[]): void {
    this.predicates = new Map(predicates.map(predicate => [predicate.id, predicate]));
    this.listeners.forEach(fn => fn());
  }

  /** Replace the cached registry for a NON-active workspace. No notification. */
  setWorkspacePredicateLayer(workspacePath: string, predicates: readonly PredicateDefinition[]): void {
    this.workspacePredicateLayers.set(
      workspacePath,
      new Map(predicates.map(predicate => [predicate.id, predicate])),
    );
  }

  /**
   * The registry a read should resolve against.
   *
   * Note the absence of a builtin fallback, which `get()` has for types: there
   * are no builtin predicates. A project with no published registry has no
   * predicates, and a field declaring one there reports `PREDICATE_UNKNOWN`,
   * which is the truthful answer.
   */
  private scopedPredicates(): ReadonlyMap<string, PredicateDefinition> {
    if (!this.activeWorkspace) return this.predicates;
    const scope = this.scopeProvider?.();
    if (!scope || scope === this.activeWorkspace) return this.predicates;
    return this.workspacePredicateLayers.get(scope) ?? EMPTY_PREDICATE_LAYER;
  }

  getPredicate(id: string): PredicateDefinition | undefined {
    return this.scopedPredicates().get(id);
  }

  getAllPredicates(): PredicateDefinition[] {
    return Array.from(this.scopedPredicates().values());
  }

  /** Resolve for an EXPLICIT workspace, with no dependence on async context. */
  getPredicateForWorkspace(
    workspacePath: string | null | undefined,
    id: string,
  ): PredicateDefinition | undefined {
    if (!workspacePath || !this.activeWorkspace || workspacePath === this.activeWorkspace) {
      return this.predicates.get(id);
    }
    return this.workspacePredicateLayers.get(workspacePath)?.get(id);
  }

  // -------------------------------------------------------------------------
  // Label registry (see labelRegistry.ts)
  // -------------------------------------------------------------------------

  /** Replace the active view's label registry. */
  setLabels(registry: LabelRegistry): void {
    this.labelRegistry = registry;
    this.listeners.forEach(fn => fn());
  }

  /** Replace the cached label registry for a NON-active workspace. No notification. */
  setWorkspaceLabelLayer(workspacePath: string, registry: LabelRegistry): void {
    this.workspaceLabelLayers.set(workspacePath, registry);
  }

  /** The label registry a read should resolve against (scoped like predicates). */
  getLabelRegistry(): LabelRegistry {
    if (!this.activeWorkspace) return this.labelRegistry;
    const scope = this.scopeProvider?.();
    if (!scope || scope === this.activeWorkspace) return this.labelRegistry;
    return this.workspaceLabelLayers.get(scope) ?? EMPTY_LABEL_REGISTRY;
  }

  getLabelRegistryForWorkspace(workspacePath: string | null | undefined): LabelRegistry {
    if (!workspacePath || !this.activeWorkspace || workspacePath === this.activeWorkspace) return this.labelRegistry;
    return this.workspaceLabelLayers.get(workspacePath) ?? EMPTY_LABEL_REGISTRY;
  }

  /**
   * Whether items of this type carry labels: the type declares a `label-ref`
   * field. Everything else (a bug whose free-form tags live in a `labels`
   * array, a type with its own `kind`) gets no label fields, no label value
   * checks, and no unknown-label warnings. Rendering and validation gate
   * {@link resolveLabels} and {@link effectiveProperties} on this.
   */
  acceptsLabels(trackerType: string): boolean {
    const model = this.get(trackerType);
    return model ? carriesLabels(model) : false;
  }

  /** Item labels plus legacy `kind`, closed under `broader`. */
  resolveLabels(item: LabeledItem): string[] {
    return resolveItemLabels(this.getLabelRegistry(), item);
  }

  /** Union of properties over the item's effective labels, own labels first. */
  effectiveProperties(item: LabeledItem): EffectiveProperty[] {
    return resolveEffectiveProperties(this.getLabelRegistry(), item, { isPredicate: this.isPredicate });
  }

  labelDescendants(labelId: string): string[] {
    return resolveLabelDescendants(this.getLabelRegistry(), labelId);
  }

  /** Instance-table columns: the label's properties, then its ancestors'. */
  tableColumns(labelId: string): EffectiveProperty[] {
    return resolveTableColumns(this.getLabelRegistry(), labelId, { isPredicate: this.isPredicate });
  }

  private isPredicate = (id: string): boolean => this.scopedPredicates().has(id);

  /** The `extends` base of a type, for predicate subject-kind resolution. */
  private baseOf = (type: string): string | undefined => this.get(type)?.extends;

  /**
   * The layer a read should resolve against, or null to use the active view.
   *
   * When no workspace has claimed the live view (`activeWorkspace === null`)
   * every read stays unscoped: the view is nobody's to corrupt, and scoping it
   * would hide types registered before any workspace window opened (NIM-760).
   */
  private scopedLayer(): ReadonlyMap<string, TrackerDataModel> | null {
    if (!this.activeWorkspace) return null;
    const scope = this.scopeProvider?.();
    if (!scope || scope === this.activeWorkspace) return null;
    return this.workspaceLayers.get(scope) ?? EMPTY_LAYER;
  }

  get(type: string): TrackerDataModel | undefined {
    const layer = this.scopedLayer();
    if (!layer) return this.models.get(type);
    // Fall back to the built-in seed, never to the active workspace's
    // override — that override belongs to a different project.
    return layer.get(type) ?? this.builtinModels.get(type);
  }

  /** True when a cached layer exists for a non-active workspace. */
  hasWorkspaceLayer(workspacePath: string): boolean {
    return this.workspaceLayers.has(workspacePath);
  }

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
  getForWorkspace(workspacePath: string | null | undefined, type: string): TrackerDataModel | undefined {
    // The live view is authoritative for the active workspace, and no layer is
    // cached for it — `setActiveWorkspace` drops one if it exists. Exactly one
    // of the two answers for any workspace.
    //
    // An absent path means the caller could not say which workspace it is
    // acting for (a row with no `workspace` column). Answer from the live view,
    // which is what an unscoped `get()` did before this method existed —
    // resolving such a caller against an empty layer would silently demote
    // every custom type to "unknown".
    if (!workspacePath || !this.activeWorkspace || workspacePath === this.activeWorkspace) {
      return this.models.get(type) ?? this.builtinModels.get(type);
    }
    return this.workspaceLayers.get(workspacePath)?.get(type) ?? this.builtinModels.get(type);
  }

  getAll(): TrackerDataModel[] {
    const layer = this.scopedLayer();
    if (!layer) return Array.from(this.models.values());
    const merged = new Map(this.builtinModels);
    for (const [type, model] of layer) merged.set(type, model);
    return Array.from(merged.values());
  }

  has(type: string): boolean {
    return this.get(type) !== undefined;
  }

  /** The types a user should be offered: `getAll()` minus types still waiting on `hiddenUntilType`. */
  getListed(): TrackerDataModel[] {
    return this.getAll().filter(model => !model.hiddenUntilType || this.has(model.hiddenUntilType));
  }

  isBuiltin(type: string): boolean {
    return this.builtinTypes.has(type);
  }

  /**
   * The original built-in model for a type, if any — the seed that a workspace
   * or synced patch layers onto. Unaffected by workspace overrides currently in
   * the `models` map, so patch resolution never double-applies.
   */
  getBuiltinModel(type: string): TrackerDataModel | undefined {
    return this.builtinModels.get(type);
  }

  validate(type: string, data: Record<string, any>): ValidationResult {
    const model = this.get(type);
    if (!model) {
      return {
        valid: false,
        errors: [{ field: 'type', message: `Unknown tracker type: ${type}` }],
      };
    }

    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    for (const field of model.fields) {
      const value = data[field.name];

      // Check required fields
      if (field.required && (value === undefined || value === null || value === '')) {
        errors.push({
          field: field.name,
          message: `Field '${field.name}' is required`,
        });
        continue;
      }

      // Skip validation if field is not provided and not required
      if (value === undefined || value === null) {
        continue;
      }

      // Type validation
      switch (field.type) {
        case 'number':
          if (typeof value !== 'number') {
            errors.push({
              field: field.name,
              message: `Field '${field.name}' must be a number`,
            });
          } else {
            if (field.min !== undefined && value < field.min) {
              errors.push({
                field: field.name,
                message: `Field '${field.name}' must be >= ${field.min}`,
              });
            }
            if (field.max !== undefined && value > field.max) {
              errors.push({
                field: field.name,
                message: `Field '${field.name}' must be <= ${field.max}`,
              });
            }
          }
          break;

        case 'select':
          // Unknown option values are a WARNING, not an error: an override may
          // have removed/renamed the option, or a peer may be on a different
          // schema set. Never destroy the stored value on a write — preserve it
          // and let the UI render it neutrally. See the plan's back-compat net.
          if (field.options && !field.options.some(opt => opt.value === value)) {
            warnings.push({
              field: field.name,
              message: `Field '${field.name}' has an unrecognized option: ${value}`,
            });
          }
          break;

        case 'array':
          if (!Array.isArray(value)) {
            errors.push({
              field: field.name,
              message: `Field '${field.name}' must be an array`,
            });
          }
          break;

        case 'boolean':
          if (typeof value !== 'boolean') {
            errors.push({
              field: field.name,
              message: `Field '${field.name}' must be a boolean`,
            });
          }
          break;

        case 'url': {
          const urlString = typeof value === 'string'
            ? value
            : (value && typeof value === 'object' && typeof (value as any).url === 'string')
              ? (value as any).url
              : undefined;
          if (!urlString) {
            errors.push({
              field: field.name,
              message: `Field '${field.name}' must be a URL string or { url, label }`,
            });
            break;
          }
          try {
            // Throws on malformed URLs; accepts any scheme (http, https, mailto, etc.)
            new URL(urlString);
          } catch {
            errors.push({
              field: field.name,
              message: `Field '${field.name}' is not a valid URL: ${urlString}`,
            });
          }
          break;
        }

        case 'citation': {
          // Entries name `citation` items; the locator itself lives on the
          // cited item, not here. See {@link CitationFieldValue}.
          if (!Array.isArray(value)) {
            errors.push({
              field: field.name,
              message: `Field '${field.name}' must be an array of citation references`,
              code: 'CITATION_FIELD_NOT_AN_ARRAY',
            });
            break;
          }
          value.forEach((entry, index) => {
            const itemId = (entry as CitationFieldValue | null)?.itemId;
            if (!entry || typeof entry !== 'object' || typeof itemId !== 'string' || itemId === '') {
              errors.push({
                field: `${field.name}[${index}]`,
                message: `Field '${field.name}[${index}]' must reference a citation item by itemId`,
                code: 'CITATION_FIELD_INVALID_ENTRY',
              });
            }
          });
          break;
        }

        case 'predicate-ref': {
          if (typeof value !== 'string' || value === '') {
            errors.push({
              field: field.name,
              message: `Field '${field.name}' must be a predicate id`,
              code: 'PREDICATE_REF_NOT_A_STRING',
            });
            break;
          }
          // An empty registry means the project has not adopted predicates,
          // not that every verb is wrong. Reporting PREDICATE_UNKNOWN for all
          // of them would make the kind unusable before the pack is installed.
          if (this.predicates.size === 0) break;
          if (!this.predicates.has(value)) {
            errors.push({
              field: field.name,
              message: `Field '${field.name}': unknown predicate '${value}'`,
              code: 'PREDICATE_UNKNOWN',
            });
          }
          break;
        }

        case 'label-ref': {
          const result = validateLabelRefValue(this.getLabelRegistry(), value);
          for (const found of result.errors) errors.push({ field: field.name, message: `Field '${field.name}': ${found.message}`, code: found.code });
          for (const found of result.warnings) warnings.push({ field: field.name, message: `Field '${field.name}': ${found.message}`, code: found.code });
          break;
        }
      }

      // Declared object shapes validate after the type check, so a `governs`
      // that is not an array is reported once (as an array error) rather than
      // twice. One validator serves citations and decision bindings alike --
      // see the header of ./citationLocator.ts.
      if (field.objectShape === 'citation-locator') {
        const multi = field.type === 'array' || field.multiValue === true;
        const result = multi ? validateCitationLocatorList(value) : validateCitationLocator(value);
        for (const locatorIssue of result.issues) {
          errors.push({
            field: locatorIssue.path
              ? `${field.name}${locatorIssue.path.startsWith('[') ? '' : '.'}${locatorIssue.path}`
              : field.name,
            message: `Field '${field.name}': ${locatorIssue.message}`,
            code: locatorIssue.code,
          });
        }
      }

      if (field.predicate) {
        this.validatePredicateField(model, field, errors);
      }
    }

    if (carriesLabels(model)) checkFieldProperties(this.getLabelRegistry(), model, data, warnings);

    return {
      valid: errors.length === 0,
      errors,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

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
  private validatePredicateField(
    model: TrackerDataModel,
    field: FieldDefinition,
    errors: ValidationIssue[],
  ): void {
    const predicateId = field.predicate as string;
    const predicate = this.getPredicate(predicateId);
    if (!predicate) {
      errors.push({
        field: field.name,
        message: `Field '${field.name}' declares predicate '${predicateId}', which this project's registry does not define`,
        code: 'PREDICATE_UNKNOWN',
      });
      return;
    }

    if (!predicateValueShapeAcceptsFieldType(predicate.valueShape, field.type)) {
      errors.push({
        field: field.name,
        message: `Field '${field.name}' is a '${field.type}' field and cannot carry predicate '${predicateId}' (value shape '${predicate.valueShape}')`,
        code: 'PREDICATE_VALUE_SHAPE_MISMATCH',
      });
      return;
    }

    if (!isSubjectKindAllowed(predicate.subjectKinds, model.type, this.baseOf)) {
      errors.push({
        field: field.name,
        message: `Predicate '${predicateId}' accepts subjects of ${predicate.subjectKinds.join(', ')}, not '${model.type}'`,
        code: 'PREDICATE_SUBJECT_KIND_NOT_ALLOWED',
      });
    }
  }
}

/**
 * Field-stored label properties are checked against their declaration as
 * WARNINGS only, on a type that carries labels. They live in
 * `customFields[<id>]` (or flat in a write payload), and properties are
 * global, so any declared id present is checked whatever the item's labels are.
 */
function checkFieldProperties(
  registry: LabelRegistry,
  model: TrackerDataModel,
  data: Record<string, any>,
  warnings: ValidationIssue[],
): void {
  if (registry.properties.length === 0) return;
  const custom = data.customFields && typeof data.customFields === 'object' ? data.customFields : {};
  for (const property of registry.properties) {
    const flat = model.fields.some(f => f.name === property.id) ? undefined : data[property.id];
    const value = custom[property.id] ?? flat;
    if (value === undefined || value === null) continue;
    for (const found of validateFieldPropertyValue(property, value)) {
      warnings.push({
        field: found.path ? `${property.id}.${found.path}` : property.id,
        message: found.message,
        code: found.code,
      });
    }
  }
}

function carriesLabels(model: TrackerDataModel): boolean {
  return model.fields.some(field => field.type === 'label-ref');
}

/** Same, for the label registry. */
const EMPTY_LABEL_REGISTRY: LabelRegistry = emptyLabelRegistry();

/** Shared empty layer for a scoped read against a workspace we know nothing about. */
const EMPTY_LAYER: ReadonlyMap<string, TrackerDataModel> = new Map();

/** Same, for the predicate registry. */
const EMPTY_PREDICATE_LAYER: ReadonlyMap<string, PredicateDefinition> = new Map();

// Global registry instance
export const globalRegistry = new TrackerDataModelRegistry();

/**
 * Standard shape of the auto-injected tags field. Kept here so every tracker
 * type that doesn't opt out gets the exact same tags editor behavior.
 */
const TAGS_FIELD: FieldDefinition = {
  name: 'tags',
  type: 'array',
  itemType: 'string',
  displayInline: false,
};

/**
 * Ensure a tracker model has tag support unless it explicitly opts out via
 * `supportsTags: false`. Adds the `tags` field and/or the `tags` role if they
 * aren't already declared. Returns the original model unchanged when nothing
 * needs to be added, so models that already declare tags keep their exact
 * field ordering and custom role target.
 */
export function ensureTagsSupport(model: TrackerDataModel): TrackerDataModel {
  if (model.supportsTags === false) return model;
  // If the schema already declares a tags role, the author has explicitly
  // chosen where tags live (possibly under a different field name like
  // `labels`). Respect that completely and don't inject anything -- except
  // when the role names the default `tags` field the type never declared, which
  // would otherwise make adding `roles: {tags: tags}` drop the injected field.
  if (model.roles?.tags != null) {
    if (model.roles.tags !== 'tags' || model.fields.some(f => f.name === 'tags')) return model;
    return { ...model, fields: [...model.fields, TAGS_FIELD] };
  }

  const hasTagsField = model.fields.some(f => f.name === 'tags');
  const fields = hasTagsField ? model.fields : [...model.fields, TAGS_FIELD];
  const roles: Partial<Record<TrackerSchemaRole, string>> = {
    ...(model.roles ?? {}),
    tags: 'tags',
  };
  return { ...model, fields, roles };
}

/**
 * Get the field name that fulfills a given role in a tracker data model.
 * Returns undefined if the model doesn't declare that role.
 */
export function getRoleField(model: TrackerDataModel, role: TrackerSchemaRole): string | undefined {
  return model.roles?.[role];
}

/**
 * Look up the FieldDefinition for a role in a given tracker type.
 * Returns undefined if the type doesn't exist, doesn't declare the role,
 * or the role's field name doesn't match any field definition.
 */
export function getFieldByRole(
  registry: TrackerDataModelRegistry,
  type: string,
  role: TrackerSchemaRole
): FieldDefinition | undefined {
  const model = registry.get(type);
  if (!model) return undefined;
  const fieldName = getRoleField(model, role);
  if (!fieldName) return undefined;
  return model.fields.find(f => f.name === fieldName);
}

/**
 * Resolve the available fields for an item with multiple type tags.
 * Returns the union of all tag types' fields. Primary type (first tag) takes
 * precedence for duplicate field names.
 */
export function resolveFields(typeTags: string[]): FieldDefinition[] {
  const seen = new Set<string>();
  const fields: FieldDefinition[] = [];

  for (const tag of typeTags) {
    const model = globalRegistry.get(tag);
    if (!model) continue;
    for (const field of model.fields) {
      if (!seen.has(field.name)) {
        seen.add(field.name);
        fields.push(field);
      }
    }
  }

  return fields;
}
