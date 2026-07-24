import { describe, it, expect, beforeAll } from 'vitest';
import type { TrackerRecord } from '../../../../core/TrackerRecord';
import { loadBuiltinTrackers } from '../ModelLoader';
import { getRecordStatus, getRecordTitle } from '../../trackerRecordAccessors';
import { COLLECTION_MEMBER_KEY } from '../trackerCollections';
import {
  findPendingReleases,
  releaseFinalizeFields,
  releaseNoteLines,
  renderReleaseNotes,
} from '../trackerReleases';

beforeAll(() => {
  loadBuiltinTrackers();
});

function record(
  id: string,
  primaryType: string,
  fields: Record<string, unknown> = {},
  overrides: Partial<TrackerRecord> = {},
): TrackerRecord {
  return {
    id,
    primaryType,
    typeTags: [primaryType],
    issueKey: `NIM-${id}`,
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: { workspace: '/w', createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T00:00:00.000Z' },
    fields: { title: `Item ${id}`, ...fields },
    ...overrides,
  } as TrackerRecord;
}

function releaseWith(members: TrackerRecord[], fields: Record<string, unknown> = {}): TrackerRecord {
  return record('r1', 'release', {
    status: 'in-progress',
    items: members.map((member) => ({
      itemId: member.id,
      direction: 'out',
      relationshipTypeKey: COLLECTION_MEMBER_KEY,
    })),
    ...fields,
  });
}

describe('trackerReleases', () => {
  it('fills version, tag, date, and status at build time', () => {
    const fields = releaseFinalizeFields(
      { version: '0.71.0', channel: 'alpha' },
      '2026-07-24T12:00:00.000Z',
    );
    expect(fields).toEqual({
      version: '0.71.0',
      gitTag: 'v0.71.0',
      channel: 'alpha',
      releasedAt: '2026-07-24T12:00:00.000Z',
      status: 'released',
    });
  });

  it('respects an explicit tag and date', () => {
    const fields = releaseFinalizeFields(
      { version: '1.0.0', gitTag: 'release-1.0.0', releasedAt: '2026-01-01T00:00:00.000Z' },
      '2026-07-24T12:00:00.000Z',
    );
    expect(fields).toMatchObject({ gitTag: 'release-1.0.0', releasedAt: '2026-01-01T00:00:00.000Z' });
    // No channel passed, so the field is left alone rather than blanked.
    expect('channel' in fields).toBe(false);
  });

  it('refuses to finalize without a version', () => {
    expect(() => releaseFinalizeFields({ version: '  ' }, '2026-07-24T12:00:00.000Z')).toThrow(/version/);
  });

  it('finds only releases still open, started ones first', () => {
    const planned = record('planned', 'release', { status: 'planned' });
    const started = record('started', 'release', { status: 'in-progress' });
    const shipped = record('shipped', 'release', { status: 'released' });
    const cancelled = record('cancelled', 'release', { status: 'cancelled' });
    const archived = record('archived', 'release', { status: 'planned' }, { archived: true });
    const milestone = record('m', 'milestone', { status: 'active' });

    const pending = findPendingReleases(
      [planned, started, shipped, cancelled, archived, milestone],
      getRecordStatus,
    );
    expect(pending.map((r) => r.id)).toEqual(['started', 'planned']);
  });

  it('builds notes from resolvable, unarchived members', () => {
    const bug = record('b1', 'bug');
    const task = record('t1', 'task');
    const dropped = record('gone', 'bug', {}, { archived: true });
    const release = releaseWith([bug, task, dropped, record('missing', 'bug')]);
    const itemsById = new Map([bug, task, dropped].map((item) => [item.id, item]));

    const lines = releaseNoteLines(release, itemsById, getRecordTitle);
    expect(lines).toEqual([
      { type: 'bug', title: 'Item b1', issueKey: 'NIM-b1' },
      { type: 'task', title: 'Item t1', issueKey: 'NIM-t1' },
    ]);
  });

  it('renders notes grouped by type', () => {
    expect(renderReleaseNotes([
      { type: 'bug', title: 'Fix the thing', issueKey: 'NIM-1' },
      { type: 'task', title: 'Do the work' },
      { type: 'bug', title: 'Fix the other thing' },
    ])).toBe(
      '### Bug\n\n- Fix the thing (NIM-1)\n- Fix the other thing\n\n### Task\n\n- Do the work',
    );
    expect(renderReleaseNotes([])).toBe('');
  });
});
