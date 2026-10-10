// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  TrackerDataModelRegistry,
  type TrackerDataModel,
} from '../TrackerDataModel.js';
import {
  isSubjectKindAllowed,
  predicateValueShapeAcceptsFieldType,
  validatePredicateDefinition,
  validatePredicateRegistry,
  validateTrackerTypePredicateDeclarations,
  type PredicateDefinition,
} from '../predicateRegistry.js';
import {
  classifyPredicateRegistryChanges,
  isDestructivePredicateRegistryChange,
} from '../trackerPredicateRegistryChangeClassifier.js';
import { parsePredicateRegistryYAML, serializePredicateRegistryYAML } from '../YAMLParser.js';
import { validateCitationLocator } from '../citationLocator.js';

/** Contract 4.1's example, verbatim. Anything that breaks this breaks the contract. */
const INTEGRATES_WITH: PredicateDefinition = {
  id: 'integrates-with',
  label: 'integrates with',
  inverseLabel: 'is integrated by',
  subjectKinds: ['product'],
  valueShape: 'entity',
  direction: 'directed',
  transitive: false,
};

function codes(issues: ReadonlyArray<{ code: string }>): string[] {
  return issues.map(issue => issue.code);
}

function productType(overrides: Partial<TrackerDataModel> = {}): TrackerDataModel {
  return {
    type: 'product',
    displayName: 'Product',
    displayNamePlural: 'Products',
    icon: 'inventory_2',
    color: '#888888',
    modes: { inline: true, fullDocument: true },
    idPrefix: 'PRD',
    idFormat: 'ulid',
    fields: [
      {
        name: 'integrations',
        type: 'relationship',
        relationshipTypeKey: 'integrates-with',
        predicate: 'integrates-with',
        targetTrackerTypes: ['product'],
        multiValue: true,
      },
    ],
    ...overrides,
  };
}

describe('predicate declarations', () => {
  it('accepts contract 4.1 verbatim and round-trips through the local YAML copy', () => {
    expect(validatePredicateDefinition(INTEGRATES_WITH).valid).toBe(true);

    const parsed = parsePredicateRegistryYAML(serializePredicateRegistryYAML([INTEGRATES_WITH]));
    expect(parsed.valid).toBe(true);
    expect(parsed.predicates).toEqual([INTEGRATES_WITH]);
  });

  it('collects every issue in one pass and reports unknown keys as warnings', () => {
    const result = validatePredicateDefinition({
      id: 'Integrates With',
      label: 'integrates with',
      subjectKinds: [],
      valueShape: 'thing',
      direction: 'directed',
      inversLabel: 'typo',
    });

    expect(result.valid).toBe(false);
    expect(codes(result.issues)).toEqual([
      'PREDICATE_INVALID_FIELD', // id grammar
      'PREDICATE_INVALID_FIELD', // empty subjectKinds
      'PREDICATE_INVALID_FIELD', // unknown valueShape
    ]);
    expect(result.warnings?.map(w => w.path)).toEqual(['inversLabel']);
  });

  it('keeps a predicate that carries a key from a newer release', () => {
    const result = validatePredicateRegistry([{ ...INTEGRATES_WITH, range: ['product'] }]);
    expect(result.valid).toBe(true);
    expect(result.predicates?.[0]).toMatchObject({ id: 'integrates-with', range: ['product'] });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'PREDICATE_UNKNOWN_FIELD', path: '[0].range' }),
    ]);
  });

  it('treats a leftover qualifiers block as an unknown key and drops it on write', () => {
    // Relations carry no qualifiers. A registry written before that must still
    // load, even when its qualifier declarations would once have been rejected.
    const legacy = { ...INTEGRATES_WITH, qualifiers: { mode: { type: 'select' } } };
    const result = validatePredicateRegistry([legacy]);
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'PREDICATE_UNKNOWN_FIELD', path: '[0].qualifiers' }),
    ]);

    const rewritten = serializePredicateRegistryYAML(result.predicates ?? []);
    expect(rewritten).not.toContain('qualifiers');
    expect(parsePredicateRegistryYAML(rewritten).predicates).toEqual([INTEGRATES_WITH]);
  });

  it('reports a duplicate id on the later entry rather than letting one win silently', () => {
    const result = validatePredicateRegistry([INTEGRATES_WITH, { ...INTEGRATES_WITH, label: 'other' }]);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'PREDICATE_DUPLICATE_ID', path: '[1].id' }),
    ]);
  });

  it('reads an empty file as an empty registry, not a failure', () => {
    expect(parsePredicateRegistryYAML('')).toEqual({ valid: true, predicates: [], issues: [] });
  });
});

describe('subject kinds and value shape', () => {
  it('accepts a derived type against a base listed in subjectKinds', () => {
    const baseOf = (type: string) => (type === 'product' ? 'entity' : undefined);
    expect(isSubjectKindAllowed(['entity'], 'product', baseOf)).toBe(true);
    expect(isSubjectKindAllowed(['entity'], 'product')).toBe(false);
    expect(isSubjectKindAllowed(['*'], 'anything')).toBe(true);
    expect(isSubjectKindAllowed(['capability'], 'product', baseOf)).toBe(false);
  });

  it('terminates on a cyclic extends chain instead of hanging a write path', () => {
    const cyclic = (type: string) => (type === 'a' ? 'b' : 'a');
    expect(isSubjectKindAllowed(['nope'], 'a', cyclic)).toBe(false);
  });

  it('maps each value shape to the field types that can carry it', () => {
    expect(predicateValueShapeAcceptsFieldType('entity', 'relationship')).toBe(true);
    expect(predicateValueShapeAcceptsFieldType('entity', 'reference')).toBe(true);
    expect(predicateValueShapeAcceptsFieldType('entity', 'string')).toBe(false);
    // An assessment must be able to say "partial" and "unknown".
    expect(predicateValueShapeAcceptsFieldType('boolean-assessment', 'boolean')).toBe(false);
    expect(predicateValueShapeAcceptsFieldType('boolean-assessment', 'select')).toBe(true);
    expect(predicateValueShapeAcceptsFieldType('quantity', 'number')).toBe(true);
  });

  it('rejects a field declaration whose type cannot carry the predicate', () => {
    const model = productType({
      fields: [{ name: 'summary', type: 'text', predicate: 'integrates-with' }],
    });
    const issues = validateTrackerTypePredicateDeclarations(model, () => INTEGRATES_WITH);
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'PREDICATE_VALUE_SHAPE_MISMATCH',
        path: 'fields.summary.predicate',
      }),
    ]);
  });

  it('reports an undeclared predicate on the field that names it', () => {
    const issues = validateTrackerTypePredicateDeclarations(productType(), () => undefined);
    expect(issues).toEqual([
      expect.objectContaining({ code: 'PREDICATE_UNKNOWN', path: 'fields.integrations.predicate' }),
    ]);
  });
});

describe('write-time validation through the registry', () => {
  function registryWithPredicate(): TrackerDataModelRegistry {
    const registry = new TrackerDataModelRegistry();
    registry.register(productType());
    registry.setPredicates([INTEGRATES_WITH]);
    return registry;
  }

  it('accepts a statement as the named relation alone, ignoring a stale qualifier bag', () => {
    const registry = registryWithPredicate();
    expect(registry.validate('product', { integrations: [{ itemId: 'itm_notion' }] }).valid).toBe(true);
    expect(registry.validate('product', {
      integrations: [{ itemId: 'itm_notion', qualifiers: { operations: 7 } }],
    }).valid).toBe(true);
  });

  it('reports an unknown predicate once for the field, not once per entry', () => {
    const registry = new TrackerDataModelRegistry();
    registry.register(productType());
    const result = registry.validate('product', {
      integrations: [{ itemId: 'a' }, { itemId: 'b' }],
    });
    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'PREDICATE_UNKNOWN', field: 'integrations' }),
    ]);
  });

  it('rejects statements once the registry narrows subjectKinds under a valid field', () => {
    const registry = registryWithPredicate();
    const statement = { integrations: [{ itemId: 'itm_notion' }] };
    expect(registry.validate('product', statement).valid).toBe(true);

    registry.setPredicates([{ ...INTEGRATES_WITH, subjectKinds: ['capability'] }]);
    expect(registry.validate('product', statement).errors).toEqual([
      expect.objectContaining({ code: 'PREDICATE_SUBJECT_KIND_NOT_ALLOWED' }),
    ]);
  });

  it('empties the registry on workspace switch so one project cannot validate another', () => {
    const registry = registryWithPredicate();
    expect(registry.getPredicate('integrates-with')).toBeDefined();
    registry.clearWorkspaceSchemas();
    expect(registry.getPredicate('integrates-with')).toBeUndefined();
  });
});

describe('registry change classification', () => {
  const classify = (next: PredicateDefinition[]) =>
    classifyPredicateRegistryChanges([INTEGRATES_WITH], next);

  it('reports no change for an identical registry', () => {
    expect(classify([INTEGRATES_WITH]).classification).toBe('none');
  });

  it('treats a label change as nothing at all', () => {
    expect(classify([{ ...INTEGRATES_WITH, label: 'talks to' }]).classification).toBe('none');
  });

  it('classifies a removal and a subjectKinds narrowing as destructive', () => {
    expect(classify([]).changes).toEqual([
      expect.objectContaining({ kind: 'predicate-removed', predicateId: 'integrates-with' }),
    ]);

    expect(classify([{ ...INTEGRATES_WITH, subjectKinds: [] }]).changes).toEqual([
      expect.objectContaining({ kind: 'subject-kinds-narrowed' }),
    ]);
  });

  it('classifies a subjectKinds widening as additive', () => {
    expect(classify([{ ...INTEGRATES_WITH, subjectKinds: ['product', 'capability'] }]).classification)
      .toBe('additive');
  });

  it('classifies objectKinds narrowing as destructive and widening as additive, absent meaning any', () => {
    const scoped = (objectKinds?: string[]) => ({ ...INTEGRATES_WITH, objectKinds });
    const between = (before?: string[], after?: string[]) =>
      classifyPredicateRegistryChanges([scoped(before)], [scoped(after)]);

    const narrowed = between(['technology', 'person'], ['technology']);
    expect(narrowed.classification).toBe('destructive');
    expect(narrowed.changes).toEqual([
      expect.objectContaining({ kind: 'object-kinds-narrowed', previousValue: ['technology', 'person'], nextValue: ['technology'] }),
    ]);
    expect(isDestructivePredicateRegistryChange(narrowed.changes[0]!)).toBe(true);

    // Adding a restriction where there was none narrows; removing one widens.
    expect(between(undefined, ['technology']).changes).toEqual([
      expect.objectContaining({ kind: 'object-kinds-narrowed', previousValue: ['*'] }),
    ]);
    expect(between(['technology'], undefined).classification).toBe('additive');
    expect(between(['technology'], ['technology', 'person']).changes).toEqual([
      expect.objectContaining({ kind: 'object-kinds-widened' }),
    ]);
    // Absent and ['*'] are the same contract.
    expect(between(undefined, ['*']).classification).toBe('none');
  });

  it('ignores a retired qualifiers block on either side', () => {
    const legacy = { ...INTEGRATES_WITH, qualifiers: { via: { type: 'string', required: true } } } as PredicateDefinition;
    expect(classifyPredicateRegistryChanges([legacy], [INTEGRATES_WITH]).classification).toBe('none');
    expect(classifyPredicateRegistryChanges([INTEGRATES_WITH], [legacy]).classification).toBe('none');
  });

  it('classifies a direction flip as destructive: every stored edge re-reads', () => {
    expect(classify([{ ...INTEGRATES_WITH, direction: 'symmetric' }]).classification)
      .toBe('destructive');
  });
});

describe('scope-node is restricted to scopes that assign a revision UUID', () => {
  const base = {
    selectorType: 'scope-node' as const,
    version: 1 as const,
    nodeId: 'n5-extends-contract',
    revisionId: '9f2c1d4a-7b31-4e59-a0c8-5d6e2f1b3a77',
  };

  it('accepts the scopes that carry contract 4.2 revision identity', () => {
    for (const scopeId of ['me:', 'team:proj_123', 'org:org_9']) {
      expect(validateCitationLocator({ ...base, scopeId }).valid).toBe(true);
    }
  });

  it('rejects a public scope, whose revisions are opaque publication strings', () => {
    const result = validateCitationLocator({ ...base, scopeId: 'public:testedknowhow' });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'LOCATOR_SCOPE_NODE_UNVERSIONED_SCOPE', path: 'scopeId' }),
    ]);
  });

  it('reports a malformed scope id distinctly from a well-formed unversioned one', () => {
    const result = validateCitationLocator({ ...base, scopeId: 'nonsense' });
    expect(codes(result.issues)).toEqual(['LOCATOR_INVALID_FIELD']);
  });
});

/**
 * `predicate-ref`: the verb carried as DATA rather than declared on the field.
 *
 * The `claim` kind needs this because its verb varies per item, so it cannot
 * come from the field declaration the way a typed entity's `integrations`
 * field does. Before it existed, `claim.predicate` was an unchecked string.
 */
describe('predicate-ref field validation', () => {
  const CLAIM_MODEL: TrackerDataModel = {
    type: 'claim',
    displayName: 'Claim',
    displayNamePlural: 'Claims',
    fields: [
      { name: 'title', type: 'string', required: true },
      { name: 'predicate', type: 'predicate-ref' },
    ],
  } as TrackerDataModel;

  const INTEGRATES: PredicateDefinition = {
    id: 'integrates-with',
    label: 'integrates with',
    subjectKinds: ['entity'],
    valueShape: 'entity',
    direction: 'directed',
  };

  function registryWith(predicates: PredicateDefinition[]): TrackerDataModelRegistry {
    const registry = new TrackerDataModelRegistry();
    registry.register(CLAIM_MODEL);
    registry.setPredicates(predicates);
    return registry;
  }

  it('accepts a verb the registry declares', () => {
    const result = registryWith([INTEGRATES]).validate('claim', {
      title: 'A integrates with B',
      predicate: 'integrates-with',
    });
    expect(result.errors).toEqual([]);
  });

  it('rejects a typo with the same code every other surface reports', () => {
    const result = registryWith([INTEGRATES]).validate('claim', {
      title: 'A integrates with B',
      predicate: 'integrates-wth',
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'PREDICATE_UNKNOWN', field: 'predicate' }),
    ]);
  });

  it('accepts anything while the project has no registry at all', () => {
    // A project that has not installed a predicate pack has an empty registry.
    // Rejecting every verb there would make the claim kind unusable before the
    // pack lands, rather than merely unvalidated.
    const result = registryWith([]).validate('claim', {
      title: 'A integrates with B',
      predicate: 'anything-at-all',
    });
    expect(result.errors).toEqual([]);
  });

  it('rejects a non-string verb', () => {
    const result = registryWith([INTEGRATES]).validate('claim', { title: 'x', predicate: 42 });
    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'PREDICATE_REF_NOT_A_STRING' }),
    ]);
  });
});
