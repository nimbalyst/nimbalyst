/**
 * YAML parser for tracker data model definitions
 */

import yaml from 'js-yaml';
import type { TrackerDataModel, FieldDefinition, FieldOption, TrackerSharing, TrackerSchemaRole } from './TrackerDataModel.js';
import { isStatusCategory } from './trackerStatusCategory.js';
import type { DerivedTrackerTypeDeclaration } from './trackerTypeInheritance.js';
import { validatePredicateRegistry, type PredicateDefinition, type PredicateRegistryValidation } from './predicateRegistry.js';
import type { LabelRegistry } from './labelRegistry.js';
import { validateLabelRegistry, type LabelRegistryValidation } from './labelRegistryAuthoring.js';

type LegacyTrackerSharing = 'local' | 'shared' | 'hybrid';

function legacySharing(mode: LegacyTrackerSharing): { sharing: TrackerSharing; draftByDefault: boolean } {
  if (mode === 'local') return { sharing: 'personal', draftByDefault: false };
  return { sharing: 'team', draftByDefault: mode === 'hybrid' };
}

/** Normalize a parsed/JSON model without requiring a full YAML validation pass. */
export function normalizeTrackerSharingModel<T extends TrackerDataModel>(model: T, fallbackSharing: TrackerSharing = 'personal'): T {
  const legacyMode = (model as TrackerDataModel & { sync?: { mode?: LegacyTrackerSharing } }).sync?.mode;
  const migrated = legacyMode && ['local', 'shared', 'hybrid'].includes(legacyMode)
    ? legacySharing(legacyMode)
    : null;
  const { sync: _legacySync, ...rest } = model as TrackerDataModel & { sync?: unknown };
  const sharing = model.sharing === 'team' || model.sharing === 'personal'
    ? model.sharing
    : migrated?.sharing ?? fallbackSharing;
  return {
    ...rest,
    sharing,
    draftByDefault: sharing === 'team' ? model.draftByDefault ?? migrated?.draftByDefault ?? false : false,
  } as T;
}

/**
 * Parse a YAML string into a TrackerDataModel
 *
 * Rejects a derived declaration (`extends:`), which has no complete model of
 * its own until it is resolved against its base. Use `parseTrackerTypeYAML`,
 * which handles both shapes.
 */
export function parseTrackerYAML(yamlString: string): TrackerDataModel {
  const data = yaml.load(yamlString) as any;

  if (!data) {
    throw new Error('Empty YAML document');
  }

  if (typeof data.extends === 'string' && data.extends.length > 0) {
    throw new Error(
      `Tracker type '${data.type ?? '(unnamed)'}' extends '${data.extends}'; use parseTrackerTypeYAML to parse a derived type`
    );
  }

  // Validate required fields
  if (!data.type) throw new Error('Missing required field: type');
  if (!data.displayName) throw new Error('Missing required field: displayName');
  if (!data.displayNamePlural) throw new Error('Missing required field: displayNamePlural');
  // A wiki type (one that declares `storage:`) follows local-wiki FORMAT.md,
  // which does not require the app-only keys. Rejecting it here hid the type's
  // tables and typed pages from the Local wiki with only a log line (NIM-7437).
  if (data.storage === 'pages' || data.storage === 'table') {
    data.icon ??= 'description';
    data.color ??= '#64748b';
    data.modes ??= { inline: true, fullDocument: false };
    data.idPrefix ??= String(data.type).slice(0, 3);
  }
  if (!data.icon) throw new Error('Missing required field: icon');
  if (!data.color) throw new Error('Missing required field: color');
  if (!data.modes) throw new Error('Missing required field: modes');
  if (!data.idPrefix) throw new Error('Missing required field: idPrefix');
  if (!data.fields || !Array.isArray(data.fields)) {
    throw new Error('Missing or invalid field: fields (must be an array)');
  }

  // Parse fields
  const fields = parseFieldDefinitions(data.fields);

  const model: TrackerDataModel = buildModelShell(data, fields);
  return applyOptionalModelProperties(model, data);
}

/** Parse the `fields:` array of either model shape. */
function parseFieldDefinitions(rawFields: any[]): FieldDefinition[] {
  return rawFields.map((field: any) => {
    if (!field.name) throw new Error('Field missing required property: name');
    if (!field.type) throw new Error(`Field '${field.name}' missing required property: type`);

    const fieldDef: FieldDefinition = {
      name: field.name,
      type: field.type,
      required: field.required || false,
      default: field.default,
      displayInline: field.displayInline !== undefined ? field.displayInline : true,
    };

    if (field.readOnly !== undefined) fieldDef.readOnly = field.readOnly;

    // Add type-specific properties
    if (field.minLength !== undefined) fieldDef.minLength = field.minLength;
    if (field.maxLength !== undefined) fieldDef.maxLength = field.maxLength;
    if (field.min !== undefined) fieldDef.min = field.min;
    if (field.max !== undefined) fieldDef.max = field.max;
    if (field.itemType !== undefined) fieldDef.itemType = field.itemType;
    // Declared shape of an object value (knowledge-scopes 4.4/4.9). Dropping it
    // here would leave a `locator` or `governs` field validated as opaque JSON.
    if (field.objectShape !== undefined) fieldDef.objectShape = field.objectShape;

    // Relationship-field properties (Epic C / NIM-870). Without these the parsed
    // FieldDefinition collapses to a single-value link with no target/vocab
    // enforcement, even though the on-disk schema declared them.
    if (field.relationshipTypeKey !== undefined) fieldDef.relationshipTypeKey = field.relationshipTypeKey;
    // Predicate binding (knowledge-scopes 4.1). Dropping it here would load a
    // field whose statements validate against nothing, and the schema would
    // read as if it had never declared a predicate at all.
    if (field.predicate !== undefined) fieldDef.predicate = field.predicate;
    if (field.targetTrackerTypes !== undefined) fieldDef.targetTrackerTypes = field.targetTrackerTypes;
    if (field.multiValue !== undefined) fieldDef.multiValue = field.multiValue;
    if (field.inverseFieldId !== undefined) fieldDef.inverseFieldId = field.inverseFieldId;
    if (field.inverseRelationshipTypeKey !== undefined) fieldDef.inverseRelationshipTypeKey = field.inverseRelationshipTypeKey;
    if (field.symmetric !== undefined) fieldDef.symmetric = field.symmetric;
    if (field.preventsCompletion !== undefined) fieldDef.preventsCompletion = field.preventsCompletion;
    if (field.childRelationship !== undefined) fieldDef.childRelationship = field.childRelationship;
    if (field.allowSelfLink !== undefined) fieldDef.allowSelfLink = field.allowSelfLink;

    // Parse options for select/multiselect
    if (field.options && Array.isArray(field.options)) {
      fieldDef.options = field.options.map((opt: any) => {
        if (typeof opt === 'string') {
          // Simple string option
          return {
            value: opt.toLowerCase().replace(/\s+/g, '-'),
            label: opt,
          } as FieldOption;
        } else if (typeof opt === 'object') {
          // This picks keys explicitly rather than spreading, so a new
          // FieldOption key must be added here or it is silently dropped at
          // load and every schema declaring it reads as if it never did.
          return {
            value: opt.value,
            label: opt.label,
            icon: opt.icon,
            color: opt.color,
            ...(isStatusCategory(opt.category) ? { category: opt.category } : {}),
          } as FieldOption;
        }
        throw new Error(`Invalid option format in field '${field.name}'`);
      });
    }

    // Parse schema for array/object types
    if (field.schema && Array.isArray(field.schema)) {
      fieldDef.schema = field.schema.map((subField: any) => ({
        name: subField.name,
        type: subField.type,
        required: subField.required || false,
      }));
    }

    return fieldDef;
  });
}

/** The required half of a full (non-derived) model. */
function buildModelShell(data: any, fields: FieldDefinition[]): TrackerDataModel {
  return {
    type: data.type,
    displayName: data.displayName,
    displayNamePlural: data.displayNamePlural,
    icon: data.icon,
    color: data.color,
    modes: {
      inline: data.modes.inline !== false,
      fullDocument: data.modes.fullDocument === true,
    },
    idPrefix: data.idPrefix,
    idFormat: data.idFormat || 'ulid',
    fields,
  };
}

/**
 * Apply every optional property both model shapes share. A derived declaration
 * runs through the same code so a property that round-trips on a full model
 * cannot silently vanish on a derived one.
 */
function applyOptionalModelProperties<T extends { type: string }>(target: T, data: any, derived = false): T {
  const model = target as T & Partial<TrackerDataModel>;

  // Optional properties
  if (data.statusBarLayout) {
    model.statusBarLayout = data.statusBarLayout;
  }

  if (data.inlineTemplate) {
    model.inlineTemplate = data.inlineTemplate;
  }

  // Optional plural + top-level behavior flags. These must round-trip so a
  // bundled builtin YAML reproduces the model exactly (e.g. automation is
  // `creatable: false`); without them the parsed model silently diverges.
  if (data.creatable !== undefined) model.creatable = data.creatable;
  if (typeof data.hiddenUntilType === 'string') model.hiddenUntilType = data.hiddenUntilType;
  if (data.primaryCapable !== undefined) model.primaryCapable = data.primaryCapable;
  if (data.supportsTags !== undefined) model.supportsTags = data.supportsTags;

  if (data.tableView) {
    model.tableView = {
      defaultColumns: data.tableView.defaultColumns || [],
      sortable: data.tableView.sortable !== false,
      filterable: data.tableView.filterable !== false,
      exportable: data.tableView.exportable !== false,
    };
  }

  // Parse roles
  if (data.roles && typeof data.roles === 'object') {
    const validRoles: TrackerSchemaRole[] = [
      'title', 'workflowStatus', 'priority', 'assignee', 'reporter',
      'tags', 'startDate', 'dueDate', 'progress', 'externalKey', 'prMergedStatus',
    ];
    const roles: Partial<Record<TrackerSchemaRole, string>> = {};
    for (const [key, value] of Object.entries(data.roles)) {
      if (validRoles.includes(key as TrackerSchemaRole) && typeof value === 'string') {
        roles[key as TrackerSchemaRole] = value;
      }
    }
    if (Object.keys(roles).length > 0) {
      model.roles = roles;
    }
  }

  // New files carry one tracker-level sharing axis. Legacy sync.mode remains a
  // permanent read format because users check these files into git.
  const validSharings: TrackerSharing[] = ['personal', 'team'];
  const legacyModes: LegacyTrackerSharing[] = ['local', 'shared', 'hybrid'];
  const legacyMode = legacyModes.includes(data.sync?.mode) ? data.sync.mode as LegacyTrackerSharing : null;
  const migrated = legacyMode ? legacySharing(legacyMode) : null;
  const declaredSharing = validSharings.includes(data.sharing)
    ? data.sharing as TrackerSharing
    : migrated?.sharing;
  // A derived type that says nothing about sharing inherits its base's, so no
  // default is applied here; only a full model falls back to 'personal'.
  if (declaredSharing || !derived) {
    model.sharing = declaredSharing ?? 'personal';
    model.draftByDefault = model.sharing === 'team'
      ? (typeof data.draftByDefault === 'boolean' ? data.draftByDefault : migrated?.draftByDefault ?? false)
      : false;
  } else if (typeof data.draftByDefault === 'boolean') {
    model.draftByDefault = data.draftByDefault;
  }
  // Only written when true: an unarchived tracker is the overwhelming majority
  // and `archived: false` on every file would be noise.
  if (data.archived === true) model.archived = true;
  // Same rule: only an opt-in is written, so absent means off.
  if (data.localNumbers === true) model.localNumbers = true;
  // A wiki type's storage; absent means the type is not in the wiki.
  if (data.storage === 'pages' || data.storage === 'table') model.storage = data.storage;

  return target;
}

/**
 * Parse either tracker type shape: a full model, or a derived declaration that
 * carries `extends` plus only what it overrides or adds.
 *
 * A derived declaration is deliberately NOT resolved here. Resolution needs the
 * base, which the parser has no access to, and storing the declared form is
 * what lets a later base change reach the derived type. See
 * `resolveTrackerTypeInheritance`.
 */
export function parseTrackerTypeYAML(yamlString: string): TrackerDataModel | DerivedTrackerTypeDeclaration {
  const data = yaml.load(yamlString) as any;
  if (!data) throw new Error('Empty YAML document');
  if (typeof data.extends !== 'string' || data.extends.length === 0) {
    return parseTrackerYAML(yamlString);
  }

  if (!data.type) throw new Error('Missing required field: type');
  if (data.type === data.extends) {
    throw new Error(`Tracker type '${data.type}' cannot extend itself`);
  }
  if (data.fields !== undefined && !Array.isArray(data.fields)) {
    throw new Error('Invalid field: fields (must be an array)');
  }

  const declared: DerivedTrackerTypeDeclaration = {
    type: data.type,
    extends: data.extends,
  };
  if (data.fields) declared.fields = parseFieldDefinitions(data.fields);
  if (data.displayName) declared.displayName = data.displayName;
  if (data.displayNamePlural) declared.displayNamePlural = data.displayNamePlural;
  if (data.icon) declared.icon = data.icon;
  if (data.color) declared.color = data.color;
  if (data.idPrefix) declared.idPrefix = data.idPrefix;
  if (data.idFormat) declared.idFormat = data.idFormat;
  if (data.modes) {
    declared.modes = {
      inline: data.modes.inline !== false,
      fullDocument: data.modes.fullDocument === true,
    };
  }

  return applyOptionalModelProperties(declared, data, true);
}

/**
 * Serialize a TrackerDataModel to YAML string
 */
export function serializeTrackerYAML(model: TrackerDataModel | DerivedTrackerTypeDeclaration): string {
  // A derived type that says nothing about sharing inherits its base's; the
  // normalizer would stamp it `personal`.
  const inheritsSharing = typeof model.extends === 'string' && model.extends.length > 0 && model.sharing === undefined;
  return yaml.dump(inheritsSharing ? model : normalizeTrackerSharingModel(model as TrackerDataModel), {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
  });
}

/**
 * Validate a YAML string without fully parsing
 */
export function validateTrackerYAML(yamlString: string): { valid: boolean; error?: string } {
  try {
    parseTrackerTypeYAML(yamlString);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ---------------------------------------------------------------------------
// Predicate registry (knowledge-scopes contract 4.1)
// ---------------------------------------------------------------------------

/**
 * Parse the LOCAL COPY of the predicate registry (`.nimbalyst/predicates.yaml`).
 *
 * The file is a copy, never the distribution mechanism: per decision 12 the
 * room owns the registry and publishes it like a type definition, and this file
 * is the projection of what arrived, plus the authoring surface for a project
 * that has no room yet.
 *
 * Returns issues rather than throwing, and returns every issue: a registry is
 * authored by hand and a reader who is told about one bad field at a time
 * edits the file once per mistake. A `qualifiers` key left from an earlier
 * registry is an unknown-field warning, not a failure.
 */
export function parsePredicateRegistryYAML(yamlString: string): PredicateRegistryValidation {
  let data: unknown;
  try {
    data = yaml.load(yamlString);
  } catch (error) {
    return {
      valid: false,
      predicates: null,
      issues: [{
        code: 'PREDICATE_REGISTRY_NOT_AN_ARRAY',
        path: '',
        message: error instanceof Error ? error.message : 'Unparseable YAML',
      }],
    };
  }
  // An empty file is an empty registry, not a failure: deleting every predicate
  // is a legal (destructive, gated) registry state.
  if (data === null || data === undefined || data === '') {
    return { valid: true, predicates: [], issues: [] };
  }
  const predicates = (data as { predicates?: unknown }).predicates;
  return validatePredicateRegistry(predicates === undefined ? data : predicates);
}

/**
 * Serialize a registry to the `.nimbalyst/predicates.yaml` shape. Relations
 * carry no qualifiers, so a retired `qualifiers` block an older registry still
 * holds is dropped here rather than written back.
 */
export function serializePredicateRegistryYAML(predicates: readonly PredicateDefinition[]): string {
  const cleaned = predicates.map(predicate => {
    if (!('qualifiers' in predicate)) return predicate;
    const { qualifiers: _retired, ...rest } = predicate as PredicateDefinition & { qualifiers?: unknown };
    return rest;
  });
  return yaml.dump({ predicates: cleaned }, { indent: 2, lineWidth: 120, noRefs: true });
}

// ---------------------------------------------------------------------------
// Label registry (labelRegistry.ts)
// ---------------------------------------------------------------------------

/**
 * Parse the local copy of the label registry (`.nimbalyst/labels.yaml`). An
 * empty file is an empty registry. Cross-registry checks are left to callers
 * that hold the predicate registry.
 */
export function parseLabelRegistryYAML(yamlString: string): LabelRegistryValidation {
  let data: unknown;
  try {
    data = yaml.load(yamlString);
  } catch (error) {
    return {
      valid: false,
      registry: null,
      issues: [{
        code: 'LABEL_REGISTRY_NOT_AN_OBJECT',
        path: '',
        message: error instanceof Error ? error.message : 'Unparseable YAML',
      }],
      warnings: [],
    };
  }
  if (data === null || data === undefined || data === '') {
    return { valid: true, registry: { labels: [], properties: [], claimProperties: {} }, issues: [], warnings: [] };
  }
  return validateLabelRegistry(data);
}

/** Serialize a registry to the `.nimbalyst/labels.yaml` shape. */
export function serializeLabelRegistryYAML(registry: LabelRegistry): string {
  return yaml.dump(
    { labels: registry.labels, properties: registry.properties, claimProperties: registry.claimProperties },
    { indent: 2, lineWidth: 120, noRefs: true },
  );
}
