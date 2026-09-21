// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Sharing PROMOTES the tracker row (a new, persisted id) before it writes the
// `share` / `trackerId` keys into the file's frontmatter. Now that the
// frontmatter writers refuse a header they cannot rewrite safely -- a flow
// mapping at the root, an anchored key -- a refusal after that point would
// leave the row promoted under an id the file never records (GitHub #1552).
// These tests pin the preflight: a refusal happens before any promotion,
// demotion, file write or room write.

const {
  query,
  readFile,
  writeFile,
  findLinkedDocumentForLocalPath,
  applyHeadlessBodyMarkdown,
  readHeadlessBodyMarkdown,
  syncTrackerItem,
} = vi.hoisted(() => ({
  query: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  findLinkedDocumentForLocalPath: vi.fn(),
  applyHeadlessBodyMarkdown: vi.fn(),
  readHeadlessBodyMarkdown: vi.fn(),
  syncTrackerItem: vi.fn(),
}));

vi.mock('fs/promises', () => ({ readFile, writeFile }));
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: { query } }));
vi.mock('../../CollabLocalOriginService', () => ({ findLinkedDocumentForLocalPath }));
vi.mock('../../MainBodyDocService', () => ({ applyHeadlessBodyMarkdown, readHeadlessBodyMarkdown }));
vi.mock('../../TrackerPolicyService', () => ({
  resolveTrackerSharingPolicy: vi.fn(() => ({ mode: 'team' })),
  shouldSyncTrackerItem: vi.fn(() => true),
}));
vi.mock('../../TrackerSyncManager', () => ({
  isTrackerSyncActive: vi.fn(() => false),
  syncTrackerItem,
  unsyncTrackerItem: vi.fn(),
}));

import {
  migrateSharedFrontmatterItemsToStableIds,
  setFileBackedTrackerItemPublished,
} from '../fileBodyPublication';

/** Reads fine through js-yaml, but no writer can splice a flow mapping safely. */
const FLOW_HEADER = '---\n{ trackerStatus: { type: plan }, status: draft }\n---\n\nPlan body.\n';
const PLAIN_HEADER = [
  '---',
  'status: draft',
  'share:',
  '  status: team',
  '  body: team',
  'trackerId: tr_promoted',
  'trackerStatus:',
  '  type: plan',
  '---',
  '',
  'Plan body.',
  '',
].join('\n');

function deps(overrides: Record<string, unknown> = {}) {
  return {
    workspacePath: '/workspace',
    rowToTrackerItem: (row: any) => ({ id: row.id }) as any,
    updateTrackerItemContent: vi.fn(),
    parseTrackerContentColumn: (value: any) => value,
    promoteFileBackedTrackerRow: vi.fn(async () => ({ newId: 'tr_new', oldId: 'fm:plan:p.md' })),
    demoteFileBackedTrackerRow: vi.fn(async () => ({ newId: 'fm:plan:p.md', oldId: 'tr_old' })),
    reconcileFrontmatterShare: vi.fn(async () => true),
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  findLinkedDocumentForLocalPath.mockResolvedValue(null);
  query.mockResolvedValue({ rows: [{ id: 'tr_promoted', data: {} }] });
});

describe('setFileBackedTrackerItemPublished frontmatter preflight (#1552)', () => {
  it('refuses to share before promoting when the header cannot be rewritten', async () => {
    readFile.mockResolvedValue(FLOW_HEADER);
    const dependencies = deps();

    await expect(
      setFileBackedTrackerItemPublished(dependencies, { id: 'fm:plan:p.md', data: {} }, true, {
        isLegacyFullDocumentRow: false,
        relativePath: 'p.md',
      }),
    ).rejects.toThrow(/frontmatter/i);

    expect(dependencies.promoteFileBackedTrackerRow).not.toHaveBeenCalled();
    expect(dependencies.demoteFileBackedTrackerRow).not.toHaveBeenCalled();
    expect(dependencies.reconcileFrontmatterShare).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses when only the real stamp would be rejected, not the rehearsal value', async () => {
    // The writer skips an op whose value already matches the file, and a
    // skipped op is never validated. A fixed rehearsal id that happens to be
    // the value already on disk would therefore rehearse a no-op and let the
    // real stamp fail after promotion.
    readFile.mockResolvedValue(
      '---\ntrackerId: &id tr_preflight\nstatus: draft\ntrackerStatus:\n  type: plan\n---\n\nPlan body.\n',
    );
    const dependencies = deps();

    await expect(
      setFileBackedTrackerItemPublished(dependencies, { id: 'fm:plan:p.md', data: {} }, true, {
        isLegacyFullDocumentRow: false,
        relativePath: 'p.md',
      }),
    ).rejects.toThrow(/anchor|alias/i);

    expect(dependencies.promoteFileBackedTrackerRow).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  // Publication does not stop at the `share` / `trackerId` stamp: once the body
  // reaches the room, the origin file is rewritten into a provenance pointer,
  // which DELETES `share` and strips a nested legacy sharing field. A header the
  // stamp happens to accept can still refuse that cleanup, and by then the row
  // is promoted and the body has moved.
  it.each([
    [
      'an anchored top-level share',
      [
        '---',
        'share: &s { status: team, body: team }',
        'status: draft',
        'trackerStatus:',
        '  type: plan',
        '---',
        '',
        'Plan body.',
        '',
      ].join('\n'),
    ],
    [
      'an anchored legacy block carrying sharing state',
      [
        '---',
        'planStatus: &p',
        '  planId: p1',
        '  shared: true',
        'status: draft',
        '---',
        '',
        'Plan body.',
        '',
      ].join('\n'),
    ],
  ])('refuses to share before promoting when the provenance cleanup would reject %s', async (
    _label,
    header,
  ) => {
    readFile.mockResolvedValue(header);
    const dependencies = deps();

    await expect(
      setFileBackedTrackerItemPublished(dependencies, { id: 'fm:plan:p.md', data: {} }, true, {
        isLegacyFullDocumentRow: false,
        relativePath: 'p.md',
      }),
    ).rejects.toThrow(/anchor|alias/i);

    expect(dependencies.promoteFileBackedTrackerRow).not.toHaveBeenCalled();
    expect(dependencies.reconcileFrontmatterShare).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses to unshare before demoting when the header cannot be rewritten', async () => {
    readFile.mockResolvedValue(FLOW_HEADER);
    const dependencies = deps();

    await expect(
      setFileBackedTrackerItemPublished(
        dependencies,
        { id: 'tr_promoted', source: 'native', source_ref: 'p.md', data: {} },
        false,
        { isLegacyFullDocumentRow: false, relativePath: 'p.md' },
      ),
    ).rejects.toThrow(/frontmatter/i);

    expect(dependencies.demoteFileBackedTrackerRow).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('still shares a writable header through to the provenance pointer', async () => {
    readFile.mockResolvedValue('---\nstatus: draft\ntrackerStatus:\n  type: plan\n---\n\nPlan body.\n');
    const dependencies = deps();

    await setFileBackedTrackerItemPublished(dependencies, { id: 'fm:plan:p.md', data: {} }, true, {
      isLegacyFullDocumentRow: false,
      relativePath: 'p.md',
    });

    expect(dependencies.promoteFileBackedTrackerRow).toHaveBeenCalledTimes(1);
    expect(dependencies.reconcileFrontmatterShare).toHaveBeenCalledTimes(1);
    const stamped = writeFile.mock.calls[0][1] as string;
    expect(stamped).toContain('trackerId: tr_promoted');
    expect(stamped).toContain('share:');
    const provenance = writeFile.mock.calls.at(-1)![1] as string;
    expect(provenance).not.toContain('share:');
    expect(provenance).toContain('Moved to the team tracker');
  });

  it('still unshares a writable header, clearing share and trackerId', async () => {
    readFile.mockResolvedValue(PLAIN_HEADER);
    const dependencies = deps();

    await setFileBackedTrackerItemPublished(
      dependencies,
      { id: 'tr_promoted', source: 'native', source_ref: 'p.md', data: {} },
      false,
      { isLegacyFullDocumentRow: false, relativePath: 'p.md' },
    );

    expect(dependencies.demoteFileBackedTrackerRow).toHaveBeenCalledTimes(1);
    expect(dependencies.reconcileFrontmatterShare).toHaveBeenCalledTimes(1);
    const written = writeFile.mock.calls[0][1] as string;
    expect(written).not.toContain('share:');
    expect(written).not.toContain('trackerId:');
    expect(written).toContain('status: draft');
    expect(written).toContain('Plan body.');
  });
});

describe('migrateSharedFrontmatterItemsToStableIds frontmatter preflight (#1552)', () => {
  it('skips a row whose header cannot be stamped instead of promoting it first', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'fm:plan:p.md', source_ref: 'p.md', content: null }] });
    readFile.mockResolvedValue(FLOW_HEADER);
    readHeadlessBodyMarkdown.mockResolvedValue('body from room');
    const dependencies = deps();

    const result = await migrateSharedFrontmatterItemsToStableIds(dependencies);

    expect(dependencies.promoteFileBackedTrackerRow).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(applyHeadlessBodyMarkdown).not.toHaveBeenCalled();
    expect(result.migrated).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ id: 'fm:plan:p.md' });
    expect(result.skipped[0].reason).toMatch(/frontmatter/i);
  });

  it('skips a row whose provenance cleanup would reject, before promoting or tombstoning', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'fm:plan:p.md', source_ref: 'p.md', content: null }] });
    readFile.mockResolvedValue(
      '---\nshare: &s { status: team, body: team }\nstatus: draft\n---\n\nPlan body.\n',
    );
    readHeadlessBodyMarkdown.mockResolvedValue('body from room');
    const dependencies = deps();

    const result = await migrateSharedFrontmatterItemsToStableIds(dependencies);

    expect(dependencies.promoteFileBackedTrackerRow).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(applyHeadlessBodyMarkdown).not.toHaveBeenCalled();
    expect(result.skipped[0].reason).toMatch(/anchor|alias/i);
  });
});
