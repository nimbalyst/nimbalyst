// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { ensureTagsSupport, type FieldDefinition, type TrackerDataModel } from '../TrackerDataModel';
import { parseTrackerYAML } from '../YAMLParser';
import {
  calculateTrackerSchemaBlastRadius,
  classifyTrackerSchemaChanges,
  describeTrackerSchemaBlastRadius,
  describeTrackerSchemaDestructiveChange,
  destructiveTrackerSchemaChanges,
  resolveTrackerSchemaChangeGate,
  type DestructiveTrackerSchemaChange,
  type TrackerSchemaBlastRadiusEntry,
} from '../trackerSchemaChangeClassifier';

function model(
  fields: FieldDefinition[],
  roles: TrackerDataModel['roles'] = {},
): TrackerDataModel {
  return {
    type: 'bug',
    displayName: 'Bug',
    displayNamePlural: 'Bugs',
    icon: 'bug_report',
    color: '#f00',
    modes: { inline: true, fullDocument: true },
    idPrefix: 'BUG',
    idFormat: 'ulid',
    fields,
    roles,
  };
}

const titleField: FieldDefinition = { name: 'title', type: 'string' };
const statusField: FieldDefinition = {
  name: 'status',
  type: 'select',
  options: [{ value: 'open', label: 'Open' }],
};

describe('classifyTrackerSchemaChanges', () => {
  it.each([
    {
      name: 'new field',
      previous: model([titleField]),
      next: model([titleField, { name: 'severity', type: 'number' }]),
      kind: 'field-added',
    },
    {
      name: 'new status',
      previous: model([titleField, statusField], { workflowStatus: 'status' }),
      next: model(
        [
          titleField,
          {
            ...statusField,
            options: [...statusField.options!, { value: 'blocked', label: 'Blocked' }],
          },
        ],
        { workflowStatus: 'status' },
      ),
      kind: 'status-added',
    },
    {
      name: 'new select option',
      previous: model([
        { name: 'priority', type: 'select', options: [{ value: 'low', label: 'Low' }] },
      ]),
      next: model([
        {
          name: 'priority',
          type: 'select',
          options: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' },
          ],
        },
      ]),
      kind: 'select-option-added',
    },
    {
      name: 'widened numeric constraint',
      previous: model([{ name: 'score', type: 'number', max: 10 }]),
      next: model([{ name: 'score', type: 'number', max: 20 }]),
      kind: 'constraint-widened',
    },
  ])('classifies $name as additive', ({ previous, next, kind }) => {
    const result = classifyTrackerSchemaChanges(previous, next);

    expect(result.classification).toBe('additive');
    expect(destructiveTrackerSchemaChanges(result.changes)).toEqual([]);
    expect(result.changes).toEqual([expect.objectContaining({ kind })]);
  });

  it.each([
    {
      name: 'removed field',
      previous: model([titleField, { name: 'severity', type: 'number' }]),
      next: model([titleField]),
      kind: 'field-removed',
    },
    {
      name: 'removed status',
      previous: model(
        [
          titleField,
          {
            ...statusField,
            options: [...statusField.options!, { value: 'blocked', label: 'Blocked' }],
          },
        ],
        { workflowStatus: 'status' },
      ),
      next: model([titleField, statusField], { workflowStatus: 'status' }),
      kind: 'status-removed',
    },
    {
      name: 'narrowed type',
      previous: model([{ name: 'labels', type: 'multiselect' }]),
      next: model([{ name: 'labels', type: 'select' }]),
      kind: 'field-type-changed',
    },
    {
      name: 'narrowed numeric constraint',
      previous: model([{ name: 'score', type: 'number', min: 0 }]),
      next: model([{ name: 'score', type: 'number', min: 5 }]),
      kind: 'constraint-narrowed',
    },
  ])('classifies $name as destructive', ({ previous, next, kind }) => {
    const result = classifyTrackerSchemaChanges(previous, next);

    expect(result.classification).toBe('destructive');
    expect(destructiveTrackerSchemaChanges(result.changes)).toContainEqual(
      expect.objectContaining({ kind }),
    );
  });

  // Normalized the way the write gate compares (YAML round trip plus the tags
  // injection `register` applies), since that is where the spurious removals hide.
  it.each([
    { name: 'roles', extra: 'roles:\n  title: title\n  workflowStatus: status\n  tags: tags\n' },
    { name: 'roles without tags', extra: 'roles:\n  title: title\n  workflowStatus: status\n' },
    { name: 'tableView', extra: 'tableView:\n  defaultColumns: [title, status]\n' },
  ])('does not treat adding $name to a type as destructive', ({ extra }) => {
    const base = [
      'type: bug', 'displayName: Bug', 'displayNamePlural: Bugs', 'icon: bug_report', "color: '#f00'",
      'modes:\n  inline: true', 'idPrefix: BUG', 'fields:',
      '  - name: title\n    type: string',
      '  - name: status\n    type: select\n    options: [open, closed]',
    ].join('\n') + '\n';
    const previous = ensureTagsSupport(parseTrackerYAML(base));
    const next = ensureTagsSupport(parseTrackerYAML(base + extra));

    const result = classifyTrackerSchemaChanges(previous, next);

    expect(destructiveTrackerSchemaChanges(result.changes)).toEqual([]);
  });

  it('still treats moving the workflow status role to another field as destructive', () => {
    const stage: FieldDefinition = { ...statusField, name: 'stage' };
    const result = classifyTrackerSchemaChanges(
      model([titleField, statusField, stage], { workflowStatus: 'status' }),
      model([titleField, statusField, stage], { workflowStatus: 'stage' }),
    );
    expect(result.classification).toBe('destructive');
  });

  it('surfaces a remove-plus-add as a rename candidate without treating it as a rename', () => {
    const previous = model([
      titleField,
      { name: 'severity', type: 'select', options: [{ value: 'high', label: 'High' }] },
    ]);
    const next = model([
      titleField,
      { name: 'priority', type: 'select', options: [{ value: 'high', label: 'High' }] },
    ]);

    const result = classifyTrackerSchemaChanges(previous, next);

    expect(result.classification).toBe('destructive');
    expect(result.renameCandidates).toEqual([
      { previousFieldName: 'severity', nextFieldName: 'priority', match: 'exact-definition' },
    ]);
    expect(result.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'field-removed', fieldName: 'severity' }),
        expect.objectContaining({ kind: 'field-added', fieldName: 'priority' }),
      ]),
    );
  });

  // Fields are paired by name, so reordering them is not a change at all.
  it('ignores field reordering', () => {
    const previous = model([titleField, statusField]);
    const next = model([statusField, titleField]);

    const result = classifyTrackerSchemaChanges(previous, next);

    expect(result).toEqual({ classification: 'none', changes: [], renameCandidates: [] });
  });

  // One row per constraint in the widening table: only a provable widening is
  // additive, and everything else has to land on the destructive side.
  it.each([
    { constraint: 'minLength', previous: { minLength: 5 }, next: { minLength: 2 }, widened: true },
    { constraint: 'minLength', previous: { minLength: 2 }, next: { minLength: 5 }, widened: false },
    { constraint: 'minLength', previous: {}, next: { minLength: 5 }, widened: false },
    { constraint: 'maxLength', previous: { maxLength: 5 }, next: { maxLength: 9 }, widened: true },
    { constraint: 'maxLength', previous: { maxLength: 9 }, next: {}, widened: true },
    { constraint: 'min', previous: { min: 5 }, next: {}, widened: true },
    { constraint: 'max', previous: { max: 9 }, next: { max: 5 }, widened: false },
    { constraint: 'required', previous: { required: true }, next: {}, widened: true },
    { constraint: 'required', previous: {}, next: { required: true }, widened: false },
    { constraint: 'readOnly', previous: {}, next: { readOnly: true }, widened: false },
    { constraint: 'multiValue', previous: {}, next: { multiValue: true }, widened: true },
    { constraint: 'multiValue', previous: { multiValue: true }, next: {}, widened: false },
    { constraint: 'allowSelfLink', previous: {}, next: { allowSelfLink: true }, widened: true },
    {
      constraint: 'targetTrackerTypes',
      previous: { targetTrackerTypes: ['bug'] },
      next: { targetTrackerTypes: ['bug', 'task'] },
      widened: true,
    },
    {
      constraint: 'targetTrackerTypes',
      previous: { targetTrackerTypes: ['bug', 'task'] },
      next: { targetTrackerTypes: ['bug'] },
      widened: false,
    },
    {
      constraint: 'targetTrackerTypes',
      previous: { targetTrackerTypes: ['bug'] },
      next: { targetTrackerTypes: '*' as const },
      widened: true,
    },
    {
      constraint: 'targetTrackerTypes',
      previous: {},
      next: { targetTrackerTypes: ['bug'] },
      widened: false,
    },
  ])(
    'classifies $constraint $previous -> $next as widened=$widened',
    ({ constraint, previous, next, widened }) => {
      const field = (extra: Partial<FieldDefinition>): FieldDefinition => ({
        name: 'field',
        type: 'string',
        ...extra,
      });

      const result = classifyTrackerSchemaChanges(
        model([field(previous)]),
        model([field(next)]),
      );

      expect(result.classification).toBe(widened ? 'additive' : 'destructive');
      expect(result.changes).toEqual([
        expect.objectContaining({
          kind: widened ? 'constraint-widened' : 'constraint-narrowed',
          constraint,
        }),
      ]);
    },
  );

  // A same-valued constraint pair must not register, or every unrelated schema
  // save would look like a change.
  it('reports no change when constraints are untouched', () => {
    const field: FieldDefinition = {
      name: 'field',
      type: 'string',
      required: true,
      minLength: 1,
      maxLength: 9,
      targetTrackerTypes: ['bug'],
    };

    expect(classifyTrackerSchemaChanges(model([field]), model([{ ...field }])).classification).toBe(
      'none',
    );
  });
});

describe('calculateTrackerSchemaBlastRadius', () => {
  it('delegates affected-item counts without knowing the item store shape', async () => {
    const previous = model(
      [
        titleField,
        { name: 'severity', type: 'number' },
        {
          name: 'status',
          type: 'select',
          options: [
            { value: 'open', label: 'Open' },
            { value: 'blocked', label: 'Blocked' },
          ],
        },
      ],
      { workflowStatus: 'status' },
    );
    const next = model([titleField, statusField], { workflowStatus: 'status' });
    const items = [
      { customFields: { severity: 1, status: 'blocked' } },
      { customFields: { severity: 2, status: 'open' } },
      { customFields: { status: 'open' } },
    ];
    const classification = classifyTrackerSchemaChanges(previous, next);

    const radius = await calculateTrackerSchemaBlastRadius(
      classification,
      (change: DestructiveTrackerSchemaChange) => {
        if (change.kind === 'field-removed') {
          return items.filter((item) => change.fieldName in item.customFields).length;
        }
        if (change.kind === 'status-removed') {
          return items.filter(
            (item) =>
              item.customFields[change.fieldName as keyof typeof item.customFields] ===
              change.option.value,
          ).length;
        }
        return 0;
      },
    );

    expect(radius).toEqual([
      expect.objectContaining({
        change: expect.objectContaining({ kind: 'field-removed', fieldName: 'severity' }),
        affectedItemCount: 2,
      }),
      expect.objectContaining({
        change: expect.objectContaining({ kind: 'status-removed', fieldName: 'status' }),
        affectedItemCount: 1,
      }),
    ]);
  });

  // Principle 6: a removal with no affected items is still a confirm, so the
  // blast-radius pass must emit an entry for it rather than filtering it out.
  it('keeps a zero-count destructive change in the blast radius', async () => {
    const previous = model([{ ...statusField, options: [...statusField.options!, { value: 'wip', label: 'WIP' }] }], {
      workflowStatus: 'status',
    });
    const next = model([statusField], { workflowStatus: 'status' });

    const radius = await calculateTrackerSchemaBlastRadius(
      classifyTrackerSchemaChanges(previous, next),
      () => 0,
    );

    expect(radius).toEqual([
      expect.objectContaining({
        change: expect.objectContaining({ kind: 'status-removed' }),
        affectedItemCount: 0,
      }),
    ]);
  });
});

/**
 * D3: anyone can add, admins can remove or rename. These pin the two halves that
 * are easy to break in opposite directions — putting friction on the additive
 * case, or letting a member's confirmation stand in for an admin's.
 */
describe('resolveTrackerSchemaChangeGate', () => {
  const additive = classifyTrackerSchemaChanges(
    model([titleField]),
    model([titleField, { name: 'severity', type: 'number' }]),
  );
  const destructive = classifyTrackerSchemaChanges(
    model([titleField, { name: 'severity', type: 'number' }]),
    model([titleField]),
  );

  it.each(['personal', 'team'] as const)(
    'applies an additive change to a %s tracker with no confirmation and no admin',
    (sharing) => {
      expect(
        resolveTrackerSchemaChangeGate({
          classification: additive,
          sharing,
          actorRole: 'member',
          confirmed: false,
        }),
      ).toEqual({ allowed: true, reason: 'additive' });
    },
  );

  it('reports an unchanged schema as no-change rather than additive', () => {
    expect(
      resolveTrackerSchemaChangeGate({
        classification: classifyTrackerSchemaChanges(model([titleField]), model([titleField])),
        sharing: 'team',
        actorRole: 'member',
        confirmed: false,
      }),
    ).toEqual({ allowed: true, reason: 'no-change' });
  });

  it('refuses a member a destructive change to a team tracker even when confirmed', () => {
    const verdict = resolveTrackerSchemaChangeGate({
      classification: destructive,
      sharing: 'team',
      actorRole: 'member',
      confirmed: true,
    });
    // requires-admin must outrank needs-confirmation: telling a member to
    // confirm sends them round a loop they cannot exit.
    expect(verdict).toMatchObject({ allowed: false, reason: 'requires-admin' });
  });

  it('lets a member make a destructive change to their own tracker once confirmed', () => {
    expect(
      resolveTrackerSchemaChangeGate({
        classification: destructive,
        sharing: 'personal',
        actorRole: 'member',
        confirmed: false,
      }),
    ).toMatchObject({ allowed: false, reason: 'needs-confirmation' });
    expect(
      resolveTrackerSchemaChangeGate({
        classification: destructive,
        sharing: 'personal',
        actorRole: 'member',
        confirmed: true,
      }),
    ).toEqual({ allowed: true, reason: 'confirmed' });
  });

  it('still asks an admin to confirm a destructive team change', () => {
    expect(
      resolveTrackerSchemaChangeGate({
        classification: destructive,
        sharing: 'team',
        actorRole: 'admin',
        confirmed: false,
      }),
    ).toMatchObject({ allowed: false, reason: 'needs-confirmation' });
    expect(
      resolveTrackerSchemaChangeGate({
        classification: destructive,
        sharing: 'team',
        actorRole: 'admin',
        confirmed: true,
      }),
    ).toEqual({ allowed: true, reason: 'confirmed' });
  });
});

describe('destructive change copy', () => {
  function entry(
    change: DestructiveTrackerSchemaChange,
    affectedItemCount: number,
  ): TrackerSchemaBlastRadiusEntry {
    return { change, affectedItemCount };
  }

  it('states the blast radius one clause per change', () => {
    expect(
      describeTrackerSchemaBlastRadius([
        entry(
          { kind: 'field-removed', fieldName: 'severity', field: { name: 'severity', type: 'number' } },
          7,
        ),
        entry(
          {
            kind: 'status-removed',
            fieldName: 'status',
            option: { value: 'blocked', label: 'Blocked' },
          },
          3,
        ),
      ]),
    ).toBe('7 items have `severity`; 3 are in `blocked`.');
  });

  it('says none rather than zero, because silence reads as unchecked', () => {
    expect(
      describeTrackerSchemaBlastRadius([
        entry(
          { kind: 'field-removed', fieldName: 'severity', field: { name: 'severity', type: 'number' } },
          0,
        ),
      ]),
    ).toBe('No items have `severity`.');
  });

  it('offers rename before retire, exact-definition matches first', () => {
    const copy = describeTrackerSchemaDestructiveChange({
      displayNamePlural: 'Bugs',
      sharing: 'team',
      teamName: 'Nimbalyst',
      blastRadius: [
        entry(
          { kind: 'field-removed', fieldName: 'severity', field: { name: 'severity', type: 'number' } },
          7,
        ),
      ],
      renameCandidates: [
        { previousFieldName: 'severity', nextFieldName: 'rank', match: 'compatible-type' },
        { previousFieldName: 'severity', nextFieldName: 'priority', match: 'exact-definition' },
      ],
    });

    expect(copy.options.map((option) => option.id)).toEqual([
      'rename:severity->priority',
      'rename:severity->rank',
      'retire',
    ]);
    expect(copy.options[0].label).toBe('Rename `severity` → `priority` (keeps values)');
    expect(copy.title).toBe('Change Bugs for Nimbalyst?');
    expect(copy.blastRadius).toBe('7 items have `severity`.');
  });
});
