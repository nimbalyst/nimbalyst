/**
 * Qualifiers on label-registry field properties.
 *
 * A field property may declare qualifiers, and its value is then stored as
 * `{ value, qualifiers }` (see `isQualifiedFieldProperty`). This module is the
 * declaration grammar, the value check, and the change verdicts for those
 * qualifiers. Relations do not carry qualifiers: a relation is a named
 * predicate with an inverse, nothing more.
 *
 * Pure: plain objects in, issues out. Declaration issues use the label
 * registry's own `LABEL_*_FIELD` codes; value issues carry `LABEL_QUALIFIER_*`.
 */

export type LabelPropertyQualifierType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'select'
  | 'relationship'
  | 'array';

export const LABEL_PROPERTY_QUALIFIER_TYPES: readonly LabelPropertyQualifierType[] = [
  'string',
  'number',
  'boolean',
  'date',
  'select',
  'relationship',
  'array',
];

/** Item types an `array` qualifier may hold. Nested objects are deliberately absent. */
export type LabelPropertyQualifierItemType = 'string' | 'number' | 'boolean';

export const LABEL_PROPERTY_QUALIFIER_ITEM_TYPES: readonly LabelPropertyQualifierItemType[] = [
  'string',
  'number',
  'boolean',
];

export interface LabelPropertyQualifierDefinition {
  type: LabelPropertyQualifierType;
  /** Absent means optional. A qualifier becoming required is a destructive change. */
  required?: boolean;
  /** For `array`. Absent accepts any of {@link LABEL_PROPERTY_QUALIFIER_ITEM_TYPES}. */
  itemType?: LabelPropertyQualifierItemType;
  /** For `select`. Values, not labels: a qualifier is data, not presentation. */
  options?: string[];
  /** For `relationship`. Allowed target tracker types, or `'*'` for any. */
  targetTrackerTypes?: string[] | '*';
  /** Presentation only; never affects validation or change classification. */
  label?: string;
  /** Presentation only. */
  description?: string;
}

export type LabelQualifierErrorCode =
  // Declaration shape
  | 'LABEL_MISSING_FIELD'
  | 'LABEL_INVALID_FIELD'
  | 'LABEL_UNKNOWN_FIELD'
  // Stored values
  | 'LABEL_QUALIFIERS_NOT_AN_OBJECT'
  | 'LABEL_QUALIFIER_REQUIRED'
  | 'LABEL_QUALIFIER_UNKNOWN'
  | 'LABEL_QUALIFIER_INVALID_TYPE'
  | 'LABEL_QUALIFIER_INVALID_OPTION';

export interface LabelQualifierIssue {
  code: LabelQualifierErrorCode;
  path: string;
  message: string;
}

function issue(code: LabelQualifierErrorCode, path: string, message: string): LabelQualifierIssue {
  return { code, path, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Qualifier names are wire keys: no spaces, no dots. */
const QUALIFIER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

const QUALIFIER_KEYS: readonly string[] = [
  'type',
  'required',
  'itemType',
  'options',
  'targetTrackerTypes',
  'label',
  'description',
];

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

/**
 * Validate one qualifier declaration. An unknown KEY is a warning (a later
 * release may add keys, and rejecting them would drop the whole registry); an
 * unknown TYPE is an error. Paths are `qualifiers.<name>[.<key>]`.
 */
export function validateLabelPropertyQualifierDeclaration(
  name: string,
  declaration: unknown,
  issues: LabelQualifierIssue[],
  warnings: LabelQualifierIssue[] = issues,
): void {
  const base = `qualifiers.${name}`;
  if (!QUALIFIER_NAME_PATTERN.test(name)) {
    issues.push(
      issue('LABEL_INVALID_FIELD', base, `Qualifier name '${name}' must start with a letter and contain no spaces or dots`),
    );
  }
  if (!isPlainObject(declaration)) {
    issues.push(issue('LABEL_INVALID_FIELD', base, `Qualifier '${name}' must be an object`));
    return;
  }

  for (const key of Object.keys(declaration)) {
    if (!QUALIFIER_KEYS.includes(key)) {
      warnings.push(issue('LABEL_UNKNOWN_FIELD', `${base}.${key}`, `'${key}' is not part of a qualifier declaration`));
    }
  }

  const type = declaration.type;
  if (type === undefined) {
    issues.push(issue('LABEL_MISSING_FIELD', `${base}.type`, `Qualifier '${name}' is missing 'type'`));
  } else if (typeof type !== 'string' || !LABEL_PROPERTY_QUALIFIER_TYPES.includes(type as LabelPropertyQualifierType)) {
    issues.push(
      issue(
        'LABEL_INVALID_FIELD',
        `${base}.type`,
        `Qualifier '${name}' has unknown type '${String(type)}'; expected one of ${LABEL_PROPERTY_QUALIFIER_TYPES.join(', ')}`,
      ),
    );
  }

  if (declaration.required !== undefined && typeof declaration.required !== 'boolean') {
    issues.push(issue('LABEL_INVALID_FIELD', `${base}.required`, `'required' must be a boolean when present`));
  }

  if (declaration.itemType !== undefined) {
    if (
      typeof declaration.itemType !== 'string'
      || !LABEL_PROPERTY_QUALIFIER_ITEM_TYPES.includes(declaration.itemType as LabelPropertyQualifierItemType)
    ) {
      issues.push(
        issue(
          'LABEL_INVALID_FIELD',
          `${base}.itemType`,
          `'itemType' must be one of ${LABEL_PROPERTY_QUALIFIER_ITEM_TYPES.join(', ')}`,
        ),
      );
    } else if (type !== 'array') {
      issues.push(issue('LABEL_INVALID_FIELD', `${base}.itemType`, `'itemType' only applies to an 'array' qualifier`));
    }
  }

  if (declaration.options !== undefined) {
    if (
      !Array.isArray(declaration.options)
      || declaration.options.length === 0
      || declaration.options.some(option => typeof option !== 'string' || option.length === 0)
    ) {
      issues.push(issue('LABEL_INVALID_FIELD', `${base}.options`, `'options' must be a non-empty array of strings`));
    } else if (type !== 'select') {
      issues.push(issue('LABEL_INVALID_FIELD', `${base}.options`, `'options' only applies to a 'select' qualifier`));
    }
  } else if (type === 'select') {
    issues.push(issue('LABEL_MISSING_FIELD', `${base}.options`, `A 'select' qualifier must declare 'options'`));
  }

  if (declaration.targetTrackerTypes !== undefined) {
    const targets = declaration.targetTrackerTypes;
    const wellFormed = targets === '*'
      || (Array.isArray(targets)
        && targets.length > 0
        && targets.every(t => typeof t === 'string' && t.length > 0));
    if (!wellFormed) {
      issues.push(
        issue(
          'LABEL_INVALID_FIELD',
          `${base}.targetTrackerTypes`,
          `'targetTrackerTypes' must be '*' or a non-empty array of tracker type names`,
        ),
      );
    } else if (type !== 'relationship') {
      issues.push(
        issue(
          'LABEL_INVALID_FIELD',
          `${base}.targetTrackerTypes`,
          `'targetTrackerTypes' only applies to a 'relationship' qualifier`,
        ),
      );
    }
  }

  for (const key of ['label', 'description']) {
    if (declaration[key] !== undefined && typeof declaration[key] !== 'string') {
      issues.push(issue('LABEL_INVALID_FIELD', `${base}.${key}`, `'${key}' must be a string when present`));
    }
  }
}

// ---------------------------------------------------------------------------
// Stored values
// ---------------------------------------------------------------------------

/**
 * Validate the qualifier bag stored beside one property value.
 *
 * `undefined` is an empty bag rather than "skip", so a required qualifier is
 * reported when the bag is missing entirely.
 */
export function validateLabelPropertyQualifiers(
  propertyId: string,
  declarations: Record<string, LabelPropertyQualifierDefinition> | undefined,
  value: unknown,
): LabelQualifierIssue[] {
  if (value !== undefined && value !== null && !isPlainObject(value)) {
    return [issue('LABEL_QUALIFIERS_NOT_AN_OBJECT', '', `Qualifiers for '${propertyId}' must be an object`)];
  }

  const declared = declarations ?? {};
  const bag: Record<string, unknown> = isPlainObject(value) ? value : {};
  const issues: LabelQualifierIssue[] = [];

  for (const [name, declaration] of Object.entries(declared)) {
    const qualifier = bag[name];
    if (qualifier === undefined || qualifier === null || qualifier === '') {
      if (declaration.required) {
        issues.push(issue('LABEL_QUALIFIER_REQUIRED', name, `Property '${propertyId}' requires qualifier '${name}'`));
      }
      continue;
    }
    checkQualifierValue(propertyId, name, declaration, qualifier, issues);
  }

  for (const name of Object.keys(bag)) {
    if (!(name in declared)) {
      issues.push(issue('LABEL_QUALIFIER_UNKNOWN', name, `Property '${propertyId}' declares no qualifier '${name}'`));
    }
  }

  return issues;
}

function checkQualifierValue(
  propertyId: string,
  name: string,
  declaration: LabelPropertyQualifierDefinition,
  value: unknown,
  issues: LabelQualifierIssue[],
): void {
  const wrongType = (expected: string) =>
    issues.push(
      issue('LABEL_QUALIFIER_INVALID_TYPE', name, `Qualifier '${name}' of '${propertyId}' must be ${expected}`),
    );

  switch (declaration.type) {
    case 'string':
      if (typeof value !== 'string') wrongType('a string');
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) wrongType('a finite number');
      return;
    case 'boolean':
      if (typeof value !== 'boolean') wrongType('a boolean');
      return;
    case 'date':
      // An ISO string on the wire; `Date` does not survive the JSON round trip.
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) wrongType('an ISO date string');
      return;
    case 'select':
      if (typeof value !== 'string') {
        wrongType('a string');
        return;
      }
      if (declaration.options && !declaration.options.includes(value)) {
        issues.push(
          issue(
            'LABEL_QUALIFIER_INVALID_OPTION',
            name,
            `Qualifier '${name}' of '${propertyId}' must be one of ${declaration.options.join(', ')}`,
          ),
        );
      }
      return;
    case 'relationship': {
      // Same shape a relationship field value uses.
      const targets = Array.isArray(value) ? value : [value];
      if (targets.length === 0) {
        wrongType('a relationship reference with an itemId');
        return;
      }
      for (const target of targets) {
        const itemId = isPlainObject(target) ? target.itemId : undefined;
        if (typeof itemId !== 'string' || itemId.length === 0) {
          wrongType('a relationship reference with an itemId');
          return;
        }
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        wrongType('an array');
        return;
      }
      const itemType = declaration.itemType;
      if (itemType && !value.every(entry => typeof entry === itemType)) wrongType(`an array of ${itemType}`);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Change verdicts
// ---------------------------------------------------------------------------

export type LabelPropertyQualifierChangeKind =
  | 'qualifier-added'
  | 'qualifier-made-optional'
  | 'qualifier-option-added'
  | 'qualifier-removed'
  | 'qualifier-made-required'
  | 'qualifier-type-changed'
  | 'qualifier-option-removed'
  | 'qualifier-definition-changed';

/**
 * Keyed by kind so a new kind without a verdict is a compile error. Anything
 * not a PROVEN widening is destructive: a wrong "additive" silently invalidates
 * values already written; a wrong "destructive" costs a confirm click.
 */
const QUALIFIER_CHANGE_DESTRUCTIVE: Record<LabelPropertyQualifierChangeKind, boolean> = {
  'qualifier-added': false,
  'qualifier-made-optional': false,
  'qualifier-option-added': false,
  'qualifier-removed': true,
  'qualifier-made-required': true,
  'qualifier-type-changed': true,
  'qualifier-option-removed': true,
  'qualifier-definition-changed': true,
};

export interface LabelPropertyQualifierChange {
  kind: LabelPropertyQualifierChangeKind;
  qualifierName: string;
  destructive: boolean;
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableValue(child)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Everything the rules below classify, plus presentation (`label`,
 * `description`), stripped out. What survives (today `targetTrackerTypes`) has
 * no widening rule and is a destructive `qualifier-definition-changed`.
 */
function unclassifiedQualifier(qualifier: LabelPropertyQualifierDefinition): Record<string, unknown> {
  const {
    type: _type,
    required: _required,
    options: _options,
    label: _label,
    description: _description,
    ...rest
  } = qualifier;
  return rest as Record<string, unknown>;
}

/** Classify the data-bearing differences between two qualifier declaration sets. */
export function classifyLabelPropertyQualifierChanges(
  previous: Record<string, LabelPropertyQualifierDefinition> | undefined,
  next: Record<string, LabelPropertyQualifierDefinition> | undefined,
): LabelPropertyQualifierChange[] {
  const changes: LabelPropertyQualifierChange[] = [];
  const push = (kind: LabelPropertyQualifierChangeKind, qualifierName: string) =>
    changes.push({ kind, qualifierName, destructive: QUALIFIER_CHANGE_DESTRUCTIVE[kind] });
  const before = previous ?? {};
  const after = next ?? {};

  for (const name of Object.keys(before)) {
    if (!(name in after)) push('qualifier-removed', name);
  }

  for (const [name, qualifier] of Object.entries(after)) {
    const prior = before[name];
    if (!prior) {
      // Adding a required qualifier invalidates every value already written.
      push(qualifier.required ? 'qualifier-made-required' : 'qualifier-added', name);
      continue;
    }
    if (prior.type !== qualifier.type) push('qualifier-type-changed', name);
    const wasRequired = prior.required === true;
    const isRequired = qualifier.required === true;
    if (!wasRequired && isRequired) push('qualifier-made-required', name);
    else if (wasRequired && !isRequired) push('qualifier-made-optional', name);
    const priorOptions = prior.options ?? [];
    const nextOptions = qualifier.options ?? [];
    for (const option of priorOptions) if (!nextOptions.includes(option)) push('qualifier-option-removed', name);
    for (const option of nextOptions) if (!priorOptions.includes(option)) push('qualifier-option-added', name);
    if (stableValue(unclassifiedQualifier(prior)) !== stableValue(unclassifiedQualifier(qualifier))) {
      push('qualifier-definition-changed', name);
    }
  }

  return changes;
}
