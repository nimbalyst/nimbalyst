import { describe, it, expect } from 'vitest';
import { TrackerDataModelRegistry, type TrackerDataModel } from '../TrackerDataModel';

/**
 * Unknown-status safety net: when an item holds a select value that is no longer
 * in its type's schema (an override removed/renamed it, or a teammate is on an
 * older/newer schema), the write path must PRESERVE the value, not reject it.
 *
 * Regression guard for the merged-status trap: updating any unrelated field on an
 * item whose current status is now unknown re-validates the stale status and,
 * before this change, hard-rejected the entire update.
 */
function statusModel(): TrackerDataModel {
  return {
    type: 'feature',
    displayName: 'Feature',
    displayNamePlural: 'Features',
    icon: 'rocket_launch',
    color: '#10b981',
    modes: { inline: true, fullDocument: false },
    idPrefix: 'feat',
    idFormat: 'ulid',
    fields: [
      { name: 'title', type: 'string', required: true },
      {
        name: 'status',
        type: 'select',
        options: [
          { value: 'to-do', label: 'To Do' },
          { value: 'done', label: 'Done' },
        ],
      },
      { name: 'count', type: 'number', min: 0, max: 10 },
    ],
    roles: { title: 'title', workflowStatus: 'status' },
  };
}

describe('validate() unknown select value', () => {
  const registry = new TrackerDataModelRegistry();
  registry.register(statusModel());

  it('does NOT reject an unknown select value — it warns and preserves', () => {
    const result = registry.validate('feature', { title: 'X', status: 'wont-do' });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings?.some((w) => w.field === 'status')).toBe(true);
  });

  it('still accepts a known select value with no warning', () => {
    const result = registry.validate('feature', { title: 'X', status: 'done' });
    expect(result.valid).toBe(true);
    expect(result.warnings ?? []).toHaveLength(0);
  });

  it('still hard-errors on genuine type violations (required + number range)', () => {
    const result = registry.validate('feature', { status: 'to-do', count: 999 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'title')).toBe(true); // required
    expect(result.errors.some((e) => e.field === 'count')).toBe(true); // > max
  });
});
