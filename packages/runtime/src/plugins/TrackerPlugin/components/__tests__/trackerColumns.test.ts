import { describe, expect, it } from 'vitest';

import { getEffectiveUpdatedDate, resolveColumnsForType } from '../trackerColumns';
import type { TrackerRecord } from '../../../../core/TrackerRecord';

describe('trackerColumns', () => {
  it('gives the structural type column enough width for the grid header and icon', () => {
    const typeColumn = resolveColumnsForType('').find(column => column.id === 'type');

    expect(typeColumn).toBeDefined();
    expect(typeColumn?.width).toBe(64);
    expect(typeColumn?.minWidth).toBe(64);
  });

  it('uses file mtime for frontmatter rows with day-precision updated timestamps', () => {
    const record: TrackerRecord = {
      id: 'plan-branching',
      primaryType: 'plan',
      typeTags: ['plan'],
      source: 'frontmatter',
      archived: false,
      syncStatus: 'local',
      fields: {},
      system: {
        workspace: '/repo',
        documentPath: 'nimbalyst-local/plans/branching.md',
        lineNumber: 0,
        createdAt: '2026-07-08',
        updatedAt: '2026-07-08T00:00:00.000Z',
        lastIndexed: '2026-07-08T16:36:30.000Z',
      },
    };

    expect(getEffectiveUpdatedDate(record)?.toISOString()).toBe('2026-07-08T16:36:30.000Z');
  });
});
