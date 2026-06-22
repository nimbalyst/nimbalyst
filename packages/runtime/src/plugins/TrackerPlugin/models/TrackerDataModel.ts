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
  | 'progress';

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

  get(type: string): TrackerDataModel | undefined {
    return this.models.get(type);
  }

  getAll(): TrackerDataModel[] {
    return Array.from(this.models.values());
  }

  has(type: string): boolean {
    return this.models.has(type);
  }

  isBuiltin(type: string): boolean {
    return this.builtinTypes.has(type);
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
          if (field.options && !field.options.some(opt => opt.value === value)) {
            errors.push({
              field: field.name,
              message: `Field '${field.name}' has invalid option: ${value}`,
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
    };
  }
}

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
