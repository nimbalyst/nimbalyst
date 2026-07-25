import { describe, expect, it } from 'vitest';

import { getCellValue, getEffectiveUpdatedDate, resolveColumnsForType } from '../trackerColumns';
import type { TrackerRecord } from '../../../../core/TrackerRecord';

describe('trackerColumns', () => {
  it('gives the structural type column enough width for the grid header and icon', () => {
    const typeColumn = resolveColumnsForType('').find(column => column.id === 'type');

    expect(typeColumn).toBeDefined();
    expect(typeColumn?.width).toBe(64);
    expect(typeColumn?.minWidth).toBe(64);
  });

  it('exposes creator identity as a read-only structural user column', () => {
    const createdByColumn = resolveColumnsForType('').find(column => column.id === 'createdBy');
    const authorIdentity = {
      email: 'alice@example.com',
      displayName: 'Alice Example',
      gitName: null,
      gitEmail: null,
    };
    const record: TrackerRecord = {
      id: 'bug-creator',
      primaryType: 'bug',
      typeTags: ['bug'],
      source: 'native',
      archived: false,
      syncStatus: 'synced',
      fields: {},
      system: {
        workspace: '/repo',
        createdAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-24T00:00:00.000Z',
        authorIdentity,
      },
    };

    expect(createdByColumn).toMatchObject({
      label: 'Created by',
      render: 'avatar',
      editable: false,
    });
    expect(getCellValue(record, 'createdBy')).toEqual(authorIdentity);
  });

  it('exposes viewed and updater identity as read-only structural columns', () => {
    const columns = resolveColumnsForType('');
    const viewedColumn = columns.find(column => column.id === 'viewed');
    const updatedByColumn = columns.find(column => column.id === 'updatedBy');
    const lastModifiedBy = {
      email: 'bob@example.com',
      displayName: 'Bob Example',
      gitName: null,
      gitEmail: null,
    };
    const record: TrackerRecord = {
      id: 'bug-viewed',
      primaryType: 'bug',
      typeTags: ['bug'],
      source: 'native',
      archived: false,
      syncStatus: 'synced',
      fields: { viewed: new Date('2026-07-24T10:00:00.000Z') },
      system: {
        workspace: '/repo',
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-24T00:00:00.000Z',
        lastModifiedBy,
      },
    };

    expect(viewedColumn).toMatchObject({ label: 'Viewed', render: 'date', editable: false });
    expect(updatedByColumn).toMatchObject({ label: 'Updated by', render: 'avatar', editable: false });
    expect(getCellValue(record, 'viewed')).toEqual(record.fields.viewed);
    expect(getCellValue(record, 'updatedBy')).toEqual(lastModifiedBy);
    expect(getCellValue(record, 'created')).toBe('2026-07-23T00:00:00.000Z');
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
