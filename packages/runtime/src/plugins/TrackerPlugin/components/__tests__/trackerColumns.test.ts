// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyTypeColumnDisplay,
  getCellValue,
  getDefaultColumnConfig,
  getEffectiveUpdatedDate,
  getTypeIcon,
  getTypeLabel,
  resolveColumnFieldName,
  resolveColumnsForType,
  resolveTypeColumnDisplay,
} from '../trackerColumns';
import { resolveTrackerOrderingValue } from '../../models/trackerOrdering';
import { globalRegistry } from '../../models';
import type { TrackerDataModel } from '../../models/TrackerDataModel';
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

  /**
   * The Key column showed nothing for an unshared item even after the local
   * numbering sweep had given every row a number, because it read `issueKey`
   * alone. The detail pane got the fallback and the columns did not.
   */
  describe('the key column', () => {
    function keyRecord(keys: { issueKey?: string; localKey?: string }): TrackerRecord {
      return {
        id: 'bug-key',
        primaryType: 'bug',
        typeTags: ['bug'],
        source: 'native',
        archived: false,
        syncStatus: 'local',
        fields: {},
        system: { workspace: '/repo', createdAt: '2026-08-01', updatedAt: '2026-08-01' },
        ...keys,
      };
    }

    it('prefers the team key, which is the only one that means the same thing to everyone', () => {
      expect(getCellValue(keyRecord({ issueKey: 'NIM-2999', localKey: 'NIC.42' }), 'key')).toBe('NIM-2999');
    });

    it('falls back to this machine local number', () => {
      expect(getCellValue(keyRecord({ localKey: 'NIC.42' }), 'key')).toBe('NIC.42');
    });

    /**
     * `LC-###` is a leftover from the rolled-back provisional scheme. Those
     * values were reissued as items were acked, so one of them displayed
     * where a stable number exists points at nothing in particular.
     */
    it('ignores a leftover provisional key in favour of the local number', () => {
      expect(getCellValue(keyRecord({ issueKey: 'LC-1', localKey: 'NIC.42' }), 'key')).toBe('NIC.42');
    });

    it('shows nothing when the item has neither', () => {
      expect(getCellValue(keyRecord({}), 'key')).toBe('');
    });

    it('sorts on whichever key it displays', () => {
      expect(resolveTrackerOrderingValue(keyRecord({ localKey: 'NIC.42' }), 'key')).toBe('NIC.42');
      expect(resolveTrackerOrderingValue(keyRecord({ issueKey: 'LC-1', localKey: 'NIC.42' }), 'key')).toBe('NIC.42');
    });
  });
});

/**
 * The cross-tracker "All" view resolves its columns with the empty type, because no
 * single schema describes a mixed list. Its columns therefore have to be role-backed:
 * two types can both have a due date and store it under different field names, and
 * nothing on screen reveals which field a column actually read (nimbalyst#1129).
 */
describe('cross-tracker column resolution', () => {
  const conventional: TrackerDataModel = {
    type: 'crossDeliverable',
    displayName: 'Deliverable',
    displayNamePlural: 'Deliverables',
    icon: 'assignment',
    color: 'var(--nim-primary)',
    modes: { inline: true, fullDocument: true },
    idPrefix: 'CDL',
    idFormat: 'ulid',
    sharing: 'personal',
    draftByDefault: false,
    fields: [
      { name: 'title', type: 'string', required: true },
      { name: 'owner', type: 'user' },
      { name: 'dueDate', type: 'date' },
    ],
    roles: { title: 'title', assignee: 'owner', dueDate: 'dueDate' },
  };

  const remapped: TrackerDataModel = {
    ...conventional,
    type: 'crossInvoice',
    displayName: 'Invoice',
    displayNamePlural: 'Invoices',
    idPrefix: 'CIN',
    fields: [
      { name: 'title', type: 'string', required: true },
      { name: 'accountManager', type: 'user' },
      { name: 'targetDate', type: 'date' },
    ],
    roles: { title: 'title', assignee: 'accountManager', dueDate: 'targetDate' },
  };

  beforeEach(() => {
    globalRegistry.register(conventional);
    globalRegistry.register(remapped);
  });

  it('reads each type own field through one shared Owner and Due Date column', () => {
    const columns = resolveColumnsForType('');
    const owner = columns.find(column => column.id === 'owner');
    const dueDate = columns.find(column => column.id === 'dueDate');

    expect(owner).toMatchObject({ label: 'Owner', role: 'assignee', render: 'avatar' });
    expect(dueDate).toMatchObject({ label: 'Due Date', role: 'dueDate', render: 'date' });

    expect(resolveColumnFieldName('crossDeliverable', owner!)).toBe('owner');
    expect(resolveColumnFieldName('crossInvoice', owner!)).toBe('accountManager');
    expect(resolveColumnFieldName('crossDeliverable', dueDate!)).toBe('dueDate');
    expect(resolveColumnFieldName('crossInvoice', dueDate!)).toBe('targetDate');
  });

  it('shows Owner and Due Date by default so overdue and unassigned work is visible', () => {
    expect(getDefaultColumnConfig('').visibleColumns)
      .toEqual(['type', 'key', 'title', 'status', 'priority', 'owner', 'dueDate', 'updated']);
  });

  it('leaves a single-tracker view resolving to its own field names', () => {
    const dueDate = resolveColumnsForType('crossInvoice').find(column => column.id === 'targetDate');

    expect(dueDate?.role).toBe('dueDate');
    expect(resolveColumnFieldName('crossInvoice', dueDate!)).toBe('targetDate');
  });
});

/**
 * The Type column used to read a hardcoded map of the seven built-in types, so a
 * workspace running custom types got an empty glyph on most of its rows
 * (nimbalyst#1422). Identity now comes from the type's own schema, and the
 * column can print the name instead when a glyph cannot carry ~30 types.
 */
describe('type column identity and display', () => {
  const declaresIcon: TrackerDataModel = {
    type: 'incidentReview',
    displayName: 'Incident Review',
    displayNamePlural: 'Incident Reviews',
    icon: 'siren',
    color: '#dc2626',
    modes: { inline: true, fullDocument: false },
    idPrefix: 'INC',
    idFormat: 'ulid',
    fields: [{ name: 'title', type: 'string', required: true }],
    roles: { title: 'title' },
  };

  const declaresNoIcon: TrackerDataModel = {
    ...declaresIcon,
    type: 'vendor-contract',
    displayName: '',
    displayNamePlural: '',
    icon: '',
    idPrefix: 'VEN',
  };

  beforeEach(() => {
    globalRegistry.register(declaresIcon);
    globalRegistry.register(declaresNoIcon);
  });

  it('resolves a custom type icon from its own schema', () => {
    expect(getTypeIcon('incidentReview')).toBe('siren');
  });

  it('never renders an empty glyph for a type that declares no icon', () => {
    expect(getTypeIcon('vendor-contract')).toBeTruthy();
    expect(getTypeIcon('neverRegisteredAnywhere')).toBeTruthy();
  });

  it('names a type from its schema, falling back to a readable form of its id', () => {
    expect(getTypeLabel('incidentReview')).toBe('Incident Review');
    expect(getTypeLabel('vendor-contract')).toBe('Vendor contract');
    expect(getTypeLabel('postMortem')).toBe('Post Mortem');
  });

  it('defaults to the icon, including for configs saved before the option existed', () => {
    expect(getDefaultColumnConfig('incidentReview').typeColumnDisplay).toBe('icon');
    expect(resolveTypeColumnDisplay({ typeColumnDisplay: undefined })).toBe('icon');
    expect(resolveTypeColumnDisplay({ typeColumnDisplay: 'label' })).toBe('label');
  });

  it('widens the type column and marks it for names only in label mode', () => {
    const columns = resolveColumnsForType('incidentReview');
    const iconMode = applyTypeColumnDisplay(columns, 'icon').find(c => c.id === 'type')!;
    const labelMode = applyTypeColumnDisplay(columns, 'label').find(c => c.id === 'type')!;

    expect(iconMode.typeDisplay).toBeUndefined();
    expect(labelMode.typeDisplay).toBe('label');
    expect(labelMode.width).toBeGreaterThan(iconMode.width as number);
  });

  it('leaves every other column alone in label mode', () => {
    const columns = resolveColumnsForType('incidentReview');
    const switched = applyTypeColumnDisplay(columns, 'label');

    expect(switched.filter(c => c.id !== 'type')).toEqual(columns.filter(c => c.id !== 'type'));
  });
});
