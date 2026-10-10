/**
 * Predicate registry (knowledge-scopes contract 4.1).
 *
 * A predicate is the verb in a statement: `product --integrates-with--> product`.
 * A relation is just that: a named predicate with an inverse label, carrying no
 * qualifiers. The registry is the declaration of those verbs, and it is a
 * SCHEMA ARTIFACT, not project configuration. Per decision 12 the room owns it
 * and publishes it to every client exactly like a type definition;
 * `.nimbalyst/predicates.yaml` is a local copy, never the distribution
 * mechanism. The transport lives in `schemaSyncPayload.ts` and rides the lane
 * type definitions already ride.
 *
 * This module is pure: plain objects in, issues out. It is reachable from
 * desktop, the web console, the collab server, and both MCP surfaces, so a bad
 * declaration reports the SAME code on all of them.
 *
 * Three properties shape this file, and they are the same three that shape
 * `./citationLocator.ts` for the same reasons.
 *
 * **Stable codes.** Every failure carries a `PREDICATE_*` code and a property
 * path. A message is for a person; a code is what a caller may branch on.
 *
 * **Tolerant on declarations.** An unknown KEY on a predicate declaration is a
 * warning: a later release adds keys (`objectKinds`) to this file, and a
 * client that rejected them would drop the whole registry and every field's
 * contract with it. The key is kept, not stripped. A `qualifiers` key left over
 * from an earlier registry lands here too.
 *
 * **Every issue in one pass.** A form or an MCP caller fixes a declaration in
 * one round trip rather than one per property.
 *
 * What this module does NOT do: resolve a relationship target, read items, or
 * decide whether a registry change is safe. That last one is
 * `./trackerPredicateRegistryChangeClassifier.ts`, which applies the same
 * additive-versus-destructive rule type schemas already get.
 */

/**
 * What the object of a statement is. A predicate's value shape and the field
 * carrying it have to agree, or the field stores something the predicate does
 * not describe. See {@link predicateValueShapeAcceptsFieldType}.
 */
export type PredicateValueShape =
  | 'entity'
  | 'text'
  | 'boolean-assessment'
  | 'quantity'
  | 'select';

export const PREDICATE_VALUE_SHAPES: readonly PredicateValueShape[] = [
  'entity',
  'text',
  'boolean-assessment',
  'quantity',
  'select',
];

/** `symmetric` reads the same both ways (`relates-to`); `directed` does not. */
export type PredicateDirection = 'directed' | 'symmetric';

export const PREDICATE_DIRECTIONS: readonly PredicateDirection[] = ['directed', 'symmetric'];

export interface PredicateDefinition {
  id: string;
  label: string;
  /** How the statement reads from the object's side. Presentation only. */
  inverseLabel?: string;
  /**
   * Tracker types that may be the subject. `['*']` accepts any. A derived type
   * satisfies a base listed here -- see {@link isSubjectKindAllowed} -- which is
   * what lets a workspace declare predicates against `entity` while
   * domain-specific schemas narrow the kinds that extend it.
   */
  subjectKinds: string[];
  /**
   * Tracker types that may be the object of an `entity` statement, resolved
   * through `extends` like {@link subjectKinds}. Absent or `['*']` accepts any
   * type. This is what lets a link hover card offer only the relations that
   * make sense between two pages' types.
   */
  objectKinds?: string[];
  valueShape: PredicateValueShape;
  direction: PredicateDirection;
  /** Advisory for traversal; nothing in this package walks a transitive closure. */
  transitive?: boolean;
}

export type PredicateErrorCode =
  // Declaration shape
  | 'PREDICATE_NOT_AN_OBJECT'
  | 'PREDICATE_MISSING_FIELD'
  | 'PREDICATE_INVALID_FIELD'
  | 'PREDICATE_UNKNOWN_FIELD'
  | 'PREDICATE_DUPLICATE_ID'
  | 'PREDICATE_REGISTRY_NOT_AN_ARRAY'
  // Field declaration against the registry
  | 'PREDICATE_UNKNOWN'
  | 'PREDICATE_VALUE_SHAPE_MISMATCH'
  | 'PREDICATE_SUBJECT_KIND_NOT_ALLOWED';

export interface PredicateIssue {
  code: PredicateErrorCode;
  /** The offending property, or `''` when the subject as a whole is at fault. */
  path: string;
  message: string;
}

function issue(code: PredicateErrorCode, path: string, message: string): PredicateIssue {
  return { code, path, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Predicate ids are wire keys: kebab-ish, no spaces, no dots. */
const PREDICATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const PREDICATE_KEYS: readonly string[] = [
  'id',
  'label',
  'inverseLabel',
  'subjectKinds',
  'objectKinds',
  'valueShape',
  'direction',
  'transitive',
];

// ---------------------------------------------------------------------------
// Declaration validation
// ---------------------------------------------------------------------------

export type PredicateDefinitionValidation =
  | { valid: true; predicate: PredicateDefinition; issues: []; warnings?: PredicateIssue[] }
  | { valid: false; predicate: null; issues: PredicateIssue[]; warnings?: PredicateIssue[] };

/** Only present when non-empty, so a clean result keeps its historical shape. */
function withWarnings<T extends object>(result: T, warnings: PredicateIssue[]): T & { warnings?: PredicateIssue[] } {
  return warnings.length > 0 ? { ...result, warnings } : result;
}

/**
 * Validate one predicate declaration. Returns the narrowed definition on
 * success and every issue on failure, never a partially-accepted value: a
 * half-valid predicate types fields against a contract nobody authored.
 */
export function validatePredicateDefinition(value: unknown): PredicateDefinitionValidation {
  if (!isPlainObject(value)) {
    return {
      valid: false,
      predicate: null,
      issues: [issue('PREDICATE_NOT_AN_OBJECT', '', 'A predicate declaration must be an object')],
    };
  }

  const issues: PredicateIssue[] = [];
  const warnings: PredicateIssue[] = [];

  for (const key of Object.keys(value)) {
    if (!PREDICATE_KEYS.includes(key)) {
      warnings.push(issue('PREDICATE_UNKNOWN_FIELD', key, `'${key}' is not part of a predicate declaration`));
    }
  }

  requireString(value, 'id', issues, {
    re: PREDICATE_ID_PATTERN,
    expectation: 'must be lowercase letters, digits, and hyphens',
  });
  requireString(value, 'label', issues);
  checkOptionalString(value, 'inverseLabel', issues);

  if (value.subjectKinds === undefined) {
    issues.push(issue('PREDICATE_MISSING_FIELD', 'subjectKinds', `'subjectKinds' is required`));
  } else if (
    !Array.isArray(value.subjectKinds)
    || value.subjectKinds.length === 0
    || value.subjectKinds.some(kind => typeof kind !== 'string' || kind.trim().length === 0)
  ) {
    issues.push(
      issue(
        'PREDICATE_INVALID_FIELD',
        'subjectKinds',
        `'subjectKinds' must be a non-empty array of tracker type names, or ['*']`,
      ),
    );
  }

  if (
    value.objectKinds !== undefined
    && (
      !Array.isArray(value.objectKinds)
      || value.objectKinds.length === 0
      || value.objectKinds.some(kind => typeof kind !== 'string' || kind.trim().length === 0)
    )
  ) {
    issues.push(
      issue(
        'PREDICATE_INVALID_FIELD',
        'objectKinds',
        `'objectKinds' must be a non-empty array of tracker type names, or ['*'], when present`,
      ),
    );
  }

  requireEnum(value, 'valueShape', PREDICATE_VALUE_SHAPES, issues);
  requireEnum(value, 'direction', PREDICATE_DIRECTIONS, issues);

  if (value.transitive !== undefined && typeof value.transitive !== 'boolean') {
    issues.push(issue('PREDICATE_INVALID_FIELD', 'transitive', `'transitive' must be a boolean when present`));
  }

  if (issues.length > 0) return withWarnings({ valid: false as const, predicate: null, issues }, warnings);
  return withWarnings(
    { valid: true as const, predicate: value as unknown as PredicateDefinition, issues: [] as [] },
    warnings,
  );
}

export type PredicateRegistryValidation =
  | { valid: true; predicates: PredicateDefinition[]; issues: []; warnings?: PredicateIssue[] }
  | { valid: false; predicates: null; issues: PredicateIssue[]; warnings?: PredicateIssue[] };

/**
 * Validate a whole registry. Entry issues are prefixed with the index, and a
 * duplicate id is reported on the later entry: two declarations of one verb
 * means every write validates against whichever happened to be registered last.
 */
export function validatePredicateRegistry(value: unknown): PredicateRegistryValidation {
  if (!Array.isArray(value)) {
    return {
      valid: false,
      predicates: null,
      issues: [issue('PREDICATE_REGISTRY_NOT_AN_ARRAY', '', 'A predicate registry must be an array of declarations')],
    };
  }

  const issues: PredicateIssue[] = [];
  const warnings: PredicateIssue[] = [];
  const predicates: PredicateDefinition[] = [];
  const seen = new Set<string>();

  value.forEach((entry, index) => {
    const result = validatePredicateDefinition(entry);
    for (const entryWarning of result.warnings ?? []) {
      warnings.push({
        ...entryWarning,
        path: entryWarning.path ? `[${index}].${entryWarning.path}` : `[${index}]`,
      });
    }
    if (!result.valid) {
      for (const entryIssue of result.issues) {
        issues.push({
          ...entryIssue,
          path: entryIssue.path ? `[${index}].${entryIssue.path}` : `[${index}]`,
        });
      }
      return;
    }
    if (seen.has(result.predicate.id)) {
      issues.push(
        issue('PREDICATE_DUPLICATE_ID', `[${index}].id`, `Predicate '${result.predicate.id}' is declared more than once`),
      );
      return;
    }
    seen.add(result.predicate.id);
    predicates.push(result.predicate);
  });

  if (issues.length > 0) return withWarnings({ valid: false as const, predicates: null, issues }, warnings);
  return withWarnings({ valid: true as const, predicates, issues: [] as [] }, warnings);
}

// ---------------------------------------------------------------------------
// Subject kinds and value shape
// ---------------------------------------------------------------------------

/**
 * Whether `type` may be the subject of a predicate declaring `subjectKinds`.
 *
 * `baseOf` walks the `extends` chain, so a predicate declared against `entity`
 * accepts `product extends entity` with no edit to the predicate. Without this
 * every pack would have to restate its predicates for each derived kind, which
 * is the drift N5's inheritance resolver exists to prevent.
 *
 * Depth is bounded because a corrupted chain must not hang a write path; the
 * inheritance resolver rejects cycles, and this is the second line.
 */
export function isSubjectKindAllowed(
  subjectKinds: readonly string[],
  type: string,
  baseOf?: (type: string) => string | undefined,
): boolean {
  if (subjectKinds.includes('*')) return true;
  let current: string | undefined = type;
  for (let depth = 0; current && depth < 16; depth += 1) {
    if (subjectKinds.includes(current)) return true;
    current = baseOf?.(current);
  }
  return false;
}

/**
 * Whether a field of `fieldType` can carry a predicate of `valueShape`.
 *
 * Today only `entity` is exercised: 4.1 attaches `predicate` to a relationship
 * field, whose value IS the object of the statement. The rest of the table is
 * stated because the `claim` kind (N11) carries `value` shaped per its
 * predicate, and leaving the mapping implicit is how the two halves drift.
 */
export function predicateValueShapeAcceptsFieldType(
  valueShape: PredicateValueShape,
  fieldType: string,
): boolean {
  switch (valueShape) {
    case 'entity':
      // `reference` is the legacy relationship alias.
      return fieldType === 'relationship' || fieldType === 'reference';
    case 'text':
      return fieldType === 'string' || fieldType === 'text';
    case 'quantity':
      return fieldType === 'number';
    case 'boolean-assessment':
      // A select, not a boolean: an assessment has to be able to say "partial"
      // and "unknown", and collapsing those to false is how a documented gap
      // becomes a recorded denial.
      return fieldType === 'select';
    case 'select':
      return fieldType === 'select' || fieldType === 'multiselect';
  }
}

// ---------------------------------------------------------------------------
// Field declarations
// ---------------------------------------------------------------------------

export interface PredicateFieldDeclarationContext {
  /** Tracker type declaring the field: the subject of every statement it holds. */
  ownerType: string;
  /** The field's `type`, checked against the predicate's value shape. */
  fieldType: string;
  /** Resolve a tracker type's `extends` base, for {@link isSubjectKindAllowed}. */
  baseOf?: (type: string) => string | undefined;
}

/**
 * Validate a field's `predicate:` against the registry, at the moment the type
 * is declared rather than at the moment an item is written.
 *
 * A value-shape or subject-kind mismatch is a defect in the SCHEMA, and
 * reporting it on every item write would point the author at data that is
 * fine. `tracker_define_type` and the schema editor call this.
 */
export function validatePredicateFieldDeclaration(
  predicateId: string,
  predicate: PredicateDefinition | undefined,
  context: PredicateFieldDeclarationContext,
): PredicateIssue[] {
  if (!predicate) {
    return [
      issue(
        'PREDICATE_UNKNOWN',
        'predicate',
        `No predicate '${predicateId}' is declared in this project's registry`,
      ),
    ];
  }

  const issues: PredicateIssue[] = [];

  if (!predicateValueShapeAcceptsFieldType(predicate.valueShape, context.fieldType)) {
    issues.push(
      issue(
        'PREDICATE_VALUE_SHAPE_MISMATCH',
        'predicate',
        `Predicate '${predicate.id}' has value shape '${predicate.valueShape}', which a '${context.fieldType}' field cannot carry`,
      ),
    );
  }

  if (!isSubjectKindAllowed(predicate.subjectKinds, context.ownerType, context.baseOf)) {
    issues.push(
      issue(
        'PREDICATE_SUBJECT_KIND_NOT_ALLOWED',
        'predicate',
        `Predicate '${predicate.id}' accepts subjects of ${predicate.subjectKinds.join(', ')}, not '${context.ownerType}'`,
      ),
    );
  }

  return issues;
}

/** The subset of a tracker type this check needs, so it stays free of the model. */
export interface PredicateDeclaringType {
  type: string;
  extends?: string;
  fields: ReadonlyArray<{ name: string; type: string; predicate?: string }>;
}

/**
 * Check every `predicate:` a type declares against the registry, at the moment
 * the type is authored.
 *
 * Issue paths are `fields.<name>.predicate`, so an authoring surface can point
 * at the row that is wrong rather than reporting "the schema is invalid".
 */
export function validateTrackerTypePredicateDeclarations(
  model: PredicateDeclaringType,
  lookup: (id: string) => PredicateDefinition | undefined,
  baseOf?: (type: string) => string | undefined,
): PredicateIssue[] {
  const issues: PredicateIssue[] = [];
  for (const field of model.fields) {
    if (!field.predicate) continue;
    const fieldIssues = validatePredicateFieldDeclaration(field.predicate, lookup(field.predicate), {
      ownerType: model.type,
      fieldType: field.type,
      baseOf,
    });
    for (const fieldIssue of fieldIssues) {
      issues.push({ ...fieldIssue, path: `fields.${field.name}.${fieldIssue.path}` });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function requireString(
  raw: Record<string, unknown>,
  key: string,
  issues: PredicateIssue[],
  pattern?: { re: RegExp; expectation: string },
): void {
  const value = raw[key];
  if (value === undefined || value === null) {
    issues.push(issue('PREDICATE_MISSING_FIELD', key, `'${key}' is required`));
    return;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(issue('PREDICATE_INVALID_FIELD', key, `'${key}' must be a non-empty string`));
    return;
  }
  if (pattern && !pattern.re.test(value)) {
    issues.push(issue('PREDICATE_INVALID_FIELD', key, `'${key}' ${pattern.expectation}`));
  }
}

function checkOptionalString(
  raw: Record<string, unknown>,
  key: string,
  issues: PredicateIssue[],
): void {
  const value = raw[key];
  if (value === undefined) return;
  if (typeof value !== 'string') {
    issues.push(issue('PREDICATE_INVALID_FIELD', key, `'${key}' must be a string when present`));
  }
}

function requireEnum<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  issues: PredicateIssue[],
): void {
  const value = raw[key];
  if (value === undefined || value === null) {
    issues.push(issue('PREDICATE_MISSING_FIELD', key, `'${key}' is required`));
    return;
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    issues.push(
      issue(
        'PREDICATE_INVALID_FIELD',
        key,
        `'${key}' must be one of ${allowed.join(', ')}`,
      ),
    );
  }
}
