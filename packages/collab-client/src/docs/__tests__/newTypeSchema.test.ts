// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseTrackerTypeYAML, serializeTrackerYAML, type TrackerDataModel } from '@nimbalyst/tracker-schema';
import { buildNewTypeSchema, newTypeIdFromName, validateNewTypeDraft, type NewTypeDraft } from '../newTypeSchema';
import { buildCollabTypeResolver } from '../collabTypeResolver';

const draft = (overrides: Partial<NewTypeDraft> = {}): NewTypeDraft => ({
  pluralName: 'Customers',
  singularName: 'Customer',
  icon: 'storefront',
  extendsTypeId: null,
  fields: [
    { label: 'Plan tier', kind: 'select', options: 'Free, Pro, Enterprise' },
    { label: 'Seats', kind: 'number' },
    { label: 'Renewal date', kind: 'date' },
    { label: 'Account owner', kind: 'person' },
    { label: 'Website', kind: 'text' },
    { label: 'Competitors', kind: 'relation', targetTypeId: 'competitor' },
  ],
  ...overrides,
});

describe('buildNewTypeSchema', () => {
  it('produces a full custom-type schema that parses back unchanged and carries the section as sharing', () => {
    const model = buildNewTypeSchema(draft(), 'team') as TrackerDataModel;
    expect(model).toMatchObject({
      type: 'customer',
      displayName: 'Customer',
      displayNamePlural: 'Customers',
      icon: 'storefront',
      idFormat: 'ulid',
      sharing: 'team',
      roles: { title: 'title' },
    });
    expect(model.fields.map((field) => [field.name, field.type])).toEqual([
      ['title', 'string'],
      ['planTier', 'select'],
      ['seats', 'number'],
      ['renewalDate', 'date'],
      ['accountOwner', 'user'],
      ['website', 'string'],
      ['competitors', 'relationship'],
    ]);
    expect(model.fields[1].options).toEqual([
      { value: 'free', label: 'Free' },
      { value: 'pro', label: 'Pro' },
      { value: 'enterprise', label: 'Enterprise' },
    ]);
    expect(model.fields[6]).toMatchObject({ targetTrackerTypes: ['competitor'], multiValue: true });
    // The same YAML round trip the define-type path writes and reloads.
    const reparsed = parseTrackerTypeYAML(serializeTrackerYAML(model));
    expect(reparsed).toMatchObject({ type: 'customer', sharing: 'team' });
    expect(reparsed.fields?.map((field) => field.name)).toEqual(model.fields.map((field) => field.name));
  });

  it('declares only type, extends, names, icon and the added fields for a subtype', () => {
    const model = buildNewTypeSchema(
      draft({ pluralName: 'Libraries', singularName: 'Library', extendsTypeId: 'technology', fields: [{ label: 'License', kind: 'text' }] }),
      'personal',
    );
    expect(model).toEqual({
      type: 'library',
      extends: 'technology',
      displayName: 'Library',
      displayNamePlural: 'Libraries',
      icon: 'storefront',
      fields: [{ name: 'license', type: 'string' }],
    });
  });

  it('keeps a Personal type out of the team section', () => {
    const personal = buildNewTypeSchema(draft(), 'personal') as TrackerDataModel;
    expect(personal.sharing).toBe('personal');
    const registry = { get: (type: string) => (type === 'customer' ? personal : undefined), getListed: () => [personal] };
    expect(buildCollabTypeResolver(registry, [], 'team').listedTypes?.()).toEqual([]);
    expect(buildCollabTypeResolver(registry, [], 'personal').listedTypes?.().map((type) => type.typeId)).toEqual(['customer']);
  });
});

describe('validateNewTypeDraft', () => {
  const context = { existingTypeIds: new Set(['customer', 'competitor']) };

  it('refuses a type id that already exists instead of replacing it', () => {
    expect(validateNewTypeDraft(draft(), context)).toContain('A type named "customer" already exists.');
    expect(validateNewTypeDraft(draft({ singularName: 'Client', pluralName: 'Clients' }), context)).toEqual([]);
  });

  it('reports missing names, unusable ids, duplicate or reserved fields, empty selects and untargeted relations', () => {
    const errors = validateNewTypeDraft({
      pluralName: '',
      singularName: '123',
      icon: 'label',
      extendsTypeId: null,
      fields: [
        { label: 'Title', kind: 'text' },
        { label: 'Seats', kind: 'number' },
        { label: 'seats', kind: 'number' },
        { label: 'Tier', kind: 'select', options: ' , ' },
        { label: 'Owner team', kind: 'relation' },
      ],
    }, context);
    expect(errors).toEqual([
      'Enter a plural name.',
      'The singular name must start with a letter.',
      '"Title" is a built-in field name.',
      'Two fields are both named "seats".',
      '"Tier" needs at least one option.',
      '"Owner team" needs a type to relate to.',
    ]);
  });

  it('derives ids from names', () => {
    expect(newTypeIdFromName('Feature Request')).toBe('feature-request');
    expect(newTypeIdFromName('  ')).toBe('');
  });
});
