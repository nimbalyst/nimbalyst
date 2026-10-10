// @vitest-environment node
/**
 * Type inheritance (`extends`). The regressions worth catching here are the
 * silent ones: a base field that stops reaching a derived type, a derived
 * declaration that widens a select it was only allowed to narrow, and a base
 * change that fails to propagate through the registry without editing the
 * derived declaration.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveTrackerTypeInheritance,
  deriveTrackerTypeDeclaration,
  isDerivedTrackerTypeDeclaration,
  TRACKER_INHERITANCE_MAX_DEPTH,
  type DerivedTrackerTypeDeclaration,
  type TrackerTypeDeclaration,
} from '../trackerTypeInheritance';
import { TrackerDataModelRegistry, type TrackerDataModel } from '../TrackerDataModel';

function entityBase(overrides: Partial<TrackerDataModel> = {}): TrackerDataModel {
  return {
    type: 'entity',
    displayName: 'Entity',
    displayNamePlural: 'Entities',
    icon: 'category',
    color: '#888888',
    modes: { inline: true, fullDocument: true },
    idPrefix: 'ENT',
    idFormat: 'ulid',
    fields: [
      { name: 'title', type: 'string', required: true },
      {
        name: 'reviewState',
        type: 'select',
        options: [
          { value: 'unreviewed', label: 'Unreviewed', color: '#999' },
          { value: 'reviewed', label: 'Reviewed' },
          { value: 'disputed', label: 'Disputed' },
        ],
      },
      { name: 'aliases', type: 'array', itemType: 'string' },
    ],
    roles: { title: 'title' },
    ...overrides,
  };
}

const product: DerivedTrackerTypeDeclaration = {
  type: 'product',
  extends: 'entity',
  displayName: 'Product',
  displayNamePlural: 'Products',
  fields: [
    { name: 'license', type: 'select', options: [{ value: 'open', label: 'Open source' }] },
  ],
};

function lookupFrom(...declarations: TrackerTypeDeclaration[]) {
  const byType = new Map(declarations.map(d => [d.type, d]));
  return (type: string) => byType.get(type);
}

describe('resolveTrackerTypeInheritance', () => {
  it('inherits base fields and roles, appends derived fields, and keeps the base order', () => {
    const { model, errors } = resolveTrackerTypeInheritance(product, lookupFrom(entityBase()));

    expect(errors).toEqual([]);
    expect(model?.fields.map(f => f.name)).toEqual(['title', 'reviewState', 'aliases', 'license']);
    expect(model?.roles).toEqual({ title: 'title' });
    // Derived scalars win; ones it omits come from the base.
    expect(model?.displayName).toBe('Product');
    expect(model?.icon).toBe('category');
    expect(model?.idPrefix).toBe('ENT');
    expect(model?.type).toBe('product');
    expect(model?.extends).toBe('entity');
  });

  it('lets a derived type narrow a base select while keeping the base option metadata', () => {
    const narrowed: DerivedTrackerTypeDeclaration = {
      type: 'product',
      extends: 'entity',
      fields: [
        { name: 'reviewState', type: 'select', options: [{ value: 'unreviewed', label: 'Unreviewed' }] },
      ],
    };

    const { model, errors } = resolveTrackerTypeInheritance(narrowed, lookupFrom(entityBase()));

    expect(errors).toEqual([]);
    const reviewState = model?.fields.find(f => f.name === 'reviewState');
    expect(reviewState?.options?.map(o => o.value)).toEqual(['unreviewed']);
    expect(reviewState?.options?.[0].color).toBe('#999');
  });

  it('rejects widening a base select rather than resolving a wider type', () => {
    const widened: DerivedTrackerTypeDeclaration = {
      type: 'product',
      extends: 'entity',
      fields: [
        {
          name: 'reviewState',
          type: 'select',
          options: [{ value: 'unreviewed', label: 'Unreviewed' }, { value: 'retired', label: 'Retired' }],
        },
      ],
    };

    const { model, errors } = resolveTrackerTypeInheritance(widened, lookupFrom(entityBase()));

    expect(model).toBeNull();
    expect(errors[0].code).toBe('INHERITANCE_OPTION_WIDENED');
    expect(errors[0].field).toBe('reviewState');
  });

  it('rejects retyping an inherited field', () => {
    const retyped: DerivedTrackerTypeDeclaration = {
      type: 'product',
      extends: 'entity',
      fields: [{ name: 'aliases', type: 'string' }],
    };

    const { model, errors } = resolveTrackerTypeInheritance(retyped, lookupFrom(entityBase()));

    expect(model).toBeNull();
    expect(errors[0].code).toBe('INHERITANCE_FIELD_RETYPED');
  });

  it('reports an unknown base instead of resolving to the derived fields alone', () => {
    const { model, errors } = resolveTrackerTypeInheritance(product, lookupFrom());

    expect(model).toBeNull();
    expect(errors[0].code).toBe('INHERITANCE_UNKNOWN_BASE');
  });

  it('detects a cycle', () => {
    const a: DerivedTrackerTypeDeclaration = { type: 'a', extends: 'b' };
    const b: DerivedTrackerTypeDeclaration = { type: 'b', extends: 'a' };

    const { model, errors } = resolveTrackerTypeInheritance(a, lookupFrom(a, b));

    expect(model).toBeNull();
    expect(errors[0].code).toBe('INHERITANCE_CYCLE');
  });

  it('folds a multi-level chain root-first', () => {
    const connector: DerivedTrackerTypeDeclaration = {
      type: 'connector',
      extends: 'product',
      fields: [{ name: 'protocol', type: 'string' }],
    };

    const { model, errors } = resolveTrackerTypeInheritance(
      connector,
      lookupFrom(entityBase(), product),
    );

    expect(errors).toEqual([]);
    expect(model?.fields.map(f => f.name)).toEqual(['title', 'reviewState', 'aliases', 'license', 'protocol']);
  });

  it('caps chain depth', () => {
    const chain: TrackerTypeDeclaration[] = [entityBase()];
    for (let i = 0; i < TRACKER_INHERITANCE_MAX_DEPTH + 2; i += 1) {
      chain.push({ type: `level${i}`, extends: i === 0 ? 'entity' : `level${i - 1}` });
    }
    const deepest = chain[chain.length - 1];

    const { model, errors } = resolveTrackerTypeInheritance(deepest, lookupFrom(...chain));

    expect(model).toBeNull();
    expect(errors[0].code).toBe('INHERITANCE_DEPTH_EXCEEDED');
  });

  it('passes a non-derived declaration through untouched', () => {
    const base = entityBase();
    expect(isDerivedTrackerTypeDeclaration(base)).toBe(false);
    expect(resolveTrackerTypeInheritance(base, lookupFrom()).model).toBe(base);
  });
});

describe('TrackerDataModelRegistry inheritance', () => {
  it('resolves a derived type registered before its base, and re-resolves when the base changes', () => {
    const registry = new TrackerDataModelRegistry();

    // Out-of-order registration is the normal case for a pack whose types are
    // written in whatever order the room published them.
    registry.register(product as TrackerDataModel);
    expect(registry.get('product')).toBeUndefined();
    expect(registry.getUnresolvedDerivedTypes()).toEqual(['product']);

    registry.register(entityBase(), true);
    // `tags` is the base's auto-injected field, so it arrives ahead of the
    // derived type's own fields.
    expect(registry.get('product')?.fields.map(f => f.name))
      .toEqual(['title', 'reviewState', 'aliases', 'tags', 'license']);
    expect(registry.getUnresolvedDerivedTypes()).toEqual([]);

    // The acceptance gate: a base field change reaches the derived type with no
    // edit to the derived declaration.
    const extended = entityBase();
    extended.fields = [...extended.fields, { name: 'scopeId', type: 'string', readOnly: true }];
    registry.register(extended, true);

    expect(registry.get('product')?.fields.map(f => f.name)).toContain('scopeId');
    expect(registry.getDeclaredModel('product')?.fields?.map(f => f.name)).toEqual(['license']);
  });

  it('refuses to register a derived type whose declaration violates narrowing', () => {
    const registry = new TrackerDataModelRegistry();
    registry.register(entityBase(), true);

    const bad: DerivedTrackerTypeDeclaration = {
      type: 'product',
      extends: 'entity',
      fields: [{ name: 'aliases', type: 'number' }],
    };
    expect(() => registry.register(bad as TrackerDataModel)).toThrow(/retype/i);
    expect(registry.get('product')).toBeUndefined();
  });
});

describe('deriveTrackerTypeDeclaration', () => {
  it('recovers only what a resolved subtype adds, so a later base narrowing does not drop it', () => {
    const declared: DerivedTrackerTypeDeclaration = {
      type: 'product', extends: 'entity', icon: 'inventory_2',
      fields: [{ name: 'sku', type: 'string' }],
    };
    const resolved = resolveTrackerTypeInheritance(declared, () => entityBase()).model!;
    // A YAML round trip spells out parser defaults the base left implicit.
    resolved.fields = resolved.fields.map((f) => (f.name === 'reviewState' ? { ...f, required: false } : f));

    expect(deriveTrackerTypeDeclaration(resolved, entityBase())).toEqual(declared);

    const registry = new TrackerDataModelRegistry();
    registry.register(entityBase());
    registry.register(deriveTrackerTypeDeclaration(resolved, entityBase()));
    const narrowed = entityBase();
    narrowed.fields[1] = { ...narrowed.fields[1], options: narrowed.fields[1].options!.slice(0, 2) };
    registry.register(narrowed);
    expect(registry.get('product')?.fields.map((f) => f.name)).toContain('sku');
  });
});
