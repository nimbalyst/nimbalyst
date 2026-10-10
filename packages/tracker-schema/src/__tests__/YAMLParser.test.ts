// @vitest-environment node
/**
 * Tests for parseTrackerYAML — focused on relationship-field key fidelity
 * (NIM-870). The on-disk schema stores the relationship-extended keys; the
 * parser must carry them into the in-memory FieldDefinition so multi-value and
 * target/vocab enforcement actually take effect.
 */

import { describe, it, expect } from 'vitest';
import { parseTrackerYAML, parseTrackerTypeYAML, serializeTrackerYAML } from '../YAMLParser';
import { isDerivedTrackerTypeDeclaration } from '../trackerTypeInheritance';

const BASE = `
type: plan
displayName: Plan
displayNamePlural: Plans
icon: assignment
color: '#7c3aed'
modes:
  inline: true
idPrefix: PLAN
`;

describe('parseTrackerYAML — relationship fields (NIM-870)', () => {
  it('carries relationship-extended keys through into the FieldDefinition', () => {
    const model = parseTrackerYAML(`${BASE}
fields:
  - name: dependsOn
    type: relationship
    relationshipTypeKey: depends-on
    targetTrackerTypes: ['plan', 'feature', 'bug']
    multiValue: true
    inverseFieldId: blockedBy
    inverseRelationshipTypeKey: blocks
    symmetric: false
    preventsCompletion: true
    childRelationship: false
    allowSelfLink: false
    readOnly: false
`);

    const field = model.fields.find((f) => f.name === 'dependsOn');
    expect(field).toBeDefined();
    expect(field!.type).toBe('relationship');
    expect(field!.relationshipTypeKey).toBe('depends-on');
    expect(field!.targetTrackerTypes).toEqual(['plan', 'feature', 'bug']);
    expect(field!.multiValue).toBe(true);
    expect(field!.inverseFieldId).toBe('blockedBy');
    expect(field!.inverseRelationshipTypeKey).toBe('blocks');
    expect(field!.preventsCompletion).toBe(true);
  });

  it("supports targetTrackerTypes: '*' (any type)", () => {
    const model = parseTrackerYAML(`${BASE}
fields:
  - name: relatesTo
    type: relationship
    relationshipTypeKey: relates-to
    targetTrackerTypes: '*'
    multiValue: true
`);
    const field = model.fields.find((f) => f.name === 'relatesTo');
    expect(field!.targetTrackerTypes).toBe('*');
  });
});

describe('parseTrackerYAML — wiki types written per local-wiki FORMAT.md', () => {
  const FORMAT_EXAMPLE = `
type: partner
displayName: Partner
displayNamePlural: Partners
storage: table
fields:
  - name: title
    type: string
`;

  it('defaults the app-only keys a wiki type may leave out', () => {
    const model = parseTrackerYAML(FORMAT_EXAMPLE);
    expect(model.storage).toBe('table');
    expect(model.idPrefix).toBe('par');
    expect(model.modes).toEqual({ inline: true, fullDocument: false });
    expect(model.icon).toBeTruthy();
    expect(model.color).toBeTruthy();
  });

  it('still requires them on a type that is not in the wiki', () => {
    expect(() => parseTrackerYAML(FORMAT_EXAMPLE.replace('storage: table\n', ''))).toThrow(
      'Missing required field: icon'
    );
  });
});

describe('parseTrackerYAML — tracker sharing migration', () => {
  it.each([
    ['local', 'personal', false],
    ['shared', 'team', false],
    ['hybrid', 'team', true],
  ] as const)('keeps loading legacy sync.mode %s', (mode, sharing, draftByDefault) => {
    const model = parseTrackerYAML(`${BASE}\nsync:\n  mode: ${mode}\n  scope: project\nfields:\n  - name: title\n    type: string\n`);

    expect(model.sharing).toBe(sharing);
    expect(model.draftByDefault).toBe(draftByDefault);
    expect(model).not.toHaveProperty('sync');
  });

  it('writes only the new sharing shape and drops dead sync.scope config', () => {
    const legacy = parseTrackerYAML(`${BASE}\nsync:\n  mode: hybrid\n  scope: workspace\nfields:\n  - name: title\n    type: string\n`);
    const serialized = serializeTrackerYAML(legacy);

    expect(serialized).toContain('sharing: team');
    expect(serialized).toContain('draftByDefault: true');
    expect(serialized).not.toContain('sync:');
    expect(serialized).not.toContain('scope:');
  });

  // For a team tracker the YAML is what carries the archived state to
  // teammates. Losing it on the round trip would quietly reopen a retired
  // tracker for editing on every other machine.
  it('round-trips the archived flag, and stays silent when a tracker is active', () => {
    const archived = parseTrackerYAML(`${BASE}\nsharing: team\narchived: true\nfields:\n  - name: title\n    type: string\n`);
    expect(archived.archived).toBe(true);
    expect(parseTrackerYAML(serializeTrackerYAML(archived)).archived).toBe(true);

    const active = parseTrackerYAML(`${BASE}\nsharing: team\nfields:\n  - name: title\n    type: string\n`);
    expect(active.archived).toBeUndefined();
    expect(serializeTrackerYAML(active)).not.toContain('archived:');
  });

  // Local numbers (`NIM.75`) are opt-in per type. Losing the flag on a round
  // trip would silently stop numbering a type the user asked to number.
  it('round-trips localNumbers, and stays silent when a type does not opt in', () => {
    const numbered = parseTrackerYAML(`${BASE}\nlocalNumbers: true\nfields:\n  - name: title\n    type: string\n`);
    expect(numbered.localNumbers).toBe(true);
    expect(parseTrackerYAML(serializeTrackerYAML(numbered)).localNumbers).toBe(true);

    const plain = parseTrackerYAML(`${BASE}\nfields:\n  - name: title\n    type: string\n`);
    expect(plain.localNumbers).toBeUndefined();
    expect(serializeTrackerYAML(plain)).not.toContain('localNumbers:');
  });

  // `storage` is what makes a type a Local wiki type (local-wiki FORMAT.md).
  // An app-side rewrite of the YAML that dropped it would move the type's items
  // out of the wiki without anyone asking.
  it('round-trips a wiki type\'s storage and ignores values the format does not define', () => {
    const table = parseTrackerYAML(`${BASE}\nstorage: table\nfields:\n  - name: title\n    type: string\n`);
    expect(table.storage).toBe('table');
    expect(parseTrackerYAML(serializeTrackerYAML(table)).storage).toBe('table');
    expect(parseTrackerYAML(`${BASE}\nstorage: pages\nfields:\n  - name: title\n    type: string\n`).storage).toBe('pages');
    expect(parseTrackerYAML(`${BASE}\nstorage: sheet\nfields:\n  - name: title\n    type: string\n`).storage).toBeUndefined();
    expect(serializeTrackerYAML(parseTrackerYAML(`${BASE}\nfields:\n  - name: title\n    type: string\n`))).not.toContain('storage:');
  });
});

describe('parseTrackerTypeYAML — derived types', () => {
  const DERIVED = `
type: product
extends: entity
fields:
  - name: license
    type: select
    options:
      - value: open
        label: Open source
`;

  it('keeps a derived declaration partial instead of inventing a full model', () => {
    const parsed = parseTrackerTypeYAML(DERIVED);

    expect(isDerivedTrackerTypeDeclaration(parsed)).toBe(true);
    expect(parsed.type).toBe('product');
    expect(parsed.fields?.map(f => f.name)).toEqual(['license']);
    // Everything undeclared stays absent so resolution takes the base's value
    // rather than a default that would silently override it.
    expect(parsed.displayName).toBeUndefined();
    expect(parsed.idPrefix).toBeUndefined();
    expect(parsed.sharing).toBeUndefined();
    expect(parsed.modes).toBeUndefined();
  });

  it('carries declared overrides, including sharing, on a derived type', () => {
    const parsed = parseTrackerTypeYAML(`${DERIVED}sharing: team\ndisplayName: Product\n`);

    expect(parsed.sharing).toBe('team');
    expect(parsed.draftByDefault).toBe(false);
    expect(parsed.displayName).toBe('Product');
  });

  it('routes a non-derived document to the full-model parser', () => {
    const parsed = parseTrackerTypeYAML(`${BASE}fields:\n  - name: title\n    type: string\n`);
    expect(isDerivedTrackerTypeDeclaration(parsed)).toBe(false);
    expect(parsed.displayName).toBe('Plan');
  });

  it('rejects a self-extending type', () => {
    expect(() => parseTrackerTypeYAML('type: entity\nextends: entity\n')).toThrow(/cannot extend itself/);
  });

  it('refuses a derived document through the full-model parser', () => {
    expect(() => parseTrackerYAML(DERIVED)).toThrow(/parseTrackerTypeYAML/);
  });

  it('round-trips a resolved derived model, keeping its lineage', () => {
    const serialized = serializeTrackerYAML({
      type: 'product',
      extends: 'entity',
      displayName: 'Product',
      displayNamePlural: 'Products',
      icon: 'inventory',
      color: '#444444',
      modes: { inline: true, fullDocument: true },
      idPrefix: 'PROD',
      idFormat: 'ulid',
      fields: [{ name: 'title', type: 'string' }],
    });

    expect(serialized).toContain('extends: entity');
    const reparsed = parseTrackerTypeYAML(serialized);
    expect(isDerivedTrackerTypeDeclaration(reparsed)).toBe(true);
    expect(reparsed.extends).toBe('entity');
  });
});
