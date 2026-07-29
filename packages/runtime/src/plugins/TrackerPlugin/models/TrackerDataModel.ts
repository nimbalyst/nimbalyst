/**
 * Core types and interfaces for the unified tracker system
 */

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
  | 'array'
  | 'object';

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

  // For relationship (Epic C). Present when `type === 'relationship'` (or the
  // legacy `reference` alias). A relationship value is a collection field that
  // syncs on the metadata socket exactly like `labels` — see
  // tracker-relationships-design.md.
  /** Vocabulary/behavior key, e.g. `depends-on`, `blocks`, `relates-to`. */
  relationshipTypeKey?: string;
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

/**
 * Sync policy for a tracker type.
 * Controls whether tracked items of this type participate in collaborative sync.
 */
export type TrackerSyncMode = 'local' | 'shared' | 'hybrid';

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

export interface TrackerSyncPolicy {
  /** How items sync: local (never), shared (always), hybrid (per-item choice) */
  mode: TrackerSyncMode;
  /** Scope of sync: project (git remote) or workspace (local path) */
  scope: 'project' | 'workspace';
}

export interface TrackerDataModel {
  type: string;
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
  /** Sync policy for collaborative tracking. Defaults to local if omitted. */
  sync?: TrackerSyncPolicy;
  /** If false, items of this type cannot be created via tracker_create. Defaults to true. */
  creatable?: boolean;
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
export interface ValidationResult {
  valid: boolean;
  errors: Array<{
    field: string;
    message: string;
  }>;
  /**
   * Non-fatal issues that must NOT block a write. An unknown select value (a
   * status an override removed/renamed, or one a peer on a different schema set)
   * lands here so the value is preserved rather than destroyed — the write path
   * treats warnings as advisory. See configurable-builtin-tracker-types plan.
   */
  warnings?: Array<{
    field: string;
    message: string;
  }>;
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

  register(model: TrackerDataModel, builtin = false): void {
    const normalized = ensureTagsSupport(model);
    this.models.set(normalized.type, normalized);
    if (builtin) {
      this.builtinTypes.add(normalized.type);
      this.builtinModels.set(normalized.type, normalized);
    }
    this.listeners.forEach(fn => fn());
  }

  /** Remove a specific type from the registry. Cannot remove built-in types. */
  unregister(type: string): boolean {
    if (this.builtinTypes.has(type)) return false;
    const removed = this.models.delete(type);
    if (removed) this.listeners.forEach(fn => fn());
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
    }
    if (changed) this.listeners.forEach(fn => fn());
    return changed;
  }

  /**
   * Remove all workspace-specific (non-builtin) schemas.
   * Call this on workspace switch to prevent schemas from workspace A
   * leaking into workspace B.
   */
  clearWorkspaceSchemas(): void {
    let changed = false;
    for (const type of Array.from(this.models.keys())) {
      if (this.builtinTypes.has(type)) {
        const builtin = this.builtinModels.get(type);
        if (builtin && this.models.get(type) !== builtin) {
          this.models.set(type, builtin);
          changed = true;
        }
      } else {
        this.models.delete(type);
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
    if (workspacePath) this.workspaceLayers.delete(workspacePath);
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
  }

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

    const errors: Array<{ field: string; message: string }> = [];
    const warnings: Array<{ field: string; message: string }> = [];

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
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
}

/** Shared empty layer for a scoped read against a workspace we know nothing about. */
const EMPTY_LAYER: ReadonlyMap<string, TrackerDataModel> = new Map();

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
  // `labels`). Respect that completely and don't inject anything.
  if (model.roles?.tags != null) return model;

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
