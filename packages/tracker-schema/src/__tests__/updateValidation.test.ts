// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { TrackerDataModelRegistry, type TrackerDataModel } from '../TrackerDataModel';
import { scopeValidationToChanges } from '../updateValidation';

/**
 * An item written before a field became required lacks it. Validating the whole
 * item on every update made it impossible to archive or edit anything else on
 * it; an update answers only for the fields it writes or clears.
 */
const decision: TrackerDataModel = {
  type: 'decision',
  displayName: 'Decision',
  displayNamePlural: 'Decisions',
  icon: 'gavel',
  color: '#000000',
  modes: { inline: false, fullDocument: true },
  idPrefix: 'dec',
  idFormat: 'ulid',
  fields: [
    { name: 'title', type: 'string', required: true },
    { name: 'decisionId', type: 'string', required: true },
    { name: 'count', type: 'number', max: 10 },
  ],
};

describe('scopeValidationToChanges', () => {
  const registry = new TrackerDataModelRegistry();
  registry.register(decision);
  const legacy = { title: 'Older decision', count: 99 };
  const update = (data: Record<string, unknown>, changed: string[]) =>
    scopeValidationToChanges(registry.validate('decision', data), changed);

  it('lets an update that leaves the missing field alone through', () => {
    expect(update({ ...legacy, archived: true }, ['archived'])).toMatchObject({ valid: true, errors: [] });
    expect(update({ ...legacy, title: 'Renamed' }, ['title']).valid).toBe(true);
  });

  it('still enforces a required field the update sets empty or clears', () => {
    expect(update({ ...legacy, decisionId: '' }, ['decisionId']).errors.map((e) => e.field)).toEqual(['decisionId']);
    expect(update(legacy, ['decisionId']).errors.map((e) => e.field)).toEqual(['decisionId']);
  });

  it('checks the value of a field the update writes', () => {
    expect(update({ ...legacy, decisionId: 'd1', count: 11 }, ['count']).errors.map((e) => e.field)).toEqual(['count']);
  });

  it('keeps errors on the elements and members of a field the update writes', () => {
    const result = scopeValidationToChanges({
      valid: false,
      warnings: [],
      errors: [
        { field: 'citations[0]', message: 'missing source' },
        { field: 'citations.locator', message: 'bad locator' },
        { field: 'citationsOther', message: 'untouched' },
      ],
    }, ['citations']);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.field)).toEqual(['citations[0]', 'citations.locator']);
  });
});
