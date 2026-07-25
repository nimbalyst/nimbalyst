import { describe, expect, it } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { compareTrackerUpdatedAtDesc } from '../prTrackerSort';

function record(id: string, updatedAt: unknown): TrackerRecord {
  return {
    id,
    primaryType: 'bug',
    typeTags: ['bug'],
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: {
      workspace: '/workspace',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: updatedAt as string,
    },
    fields: { title: id },
  };
}

describe('compareTrackerUpdatedAtDesc', () => {
  it('sorts mixed database timestamp shapes without throwing', () => {
    const records = [
      record('string', '2026-07-22T00:00:00.000Z'),
      record('date', new Date('2026-07-24T00:00:00.000Z')),
      record('number', Date.parse('2026-07-23T00:00:00.000Z')),
      record('invalid', { unexpected: true }),
    ];

    expect(records.sort(compareTrackerUpdatedAtDesc).map((item) => item.id)).toEqual([
      'date',
      'number',
      'string',
      'invalid',
    ]);
  });
});
