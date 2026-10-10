/**
 * Regression tests for ElectronDocumentService.parseTrackerItems.
 *
 * The original regex `/(.+?)\s+#([\w-]+)\[(.+?)\]/` had two unbounded lazy
 * groups and exhibited catastrophic backtracking on long lines that
 * contained scattered `#`, `[`, `]` characters without a real tracker token
 * — e.g. inline base64-encoded images. A single ~300k-char line could lock
 * the main process for 100+ seconds during the file-watcher-driven cache
 * refresh after AI session edits (observed in production, 149s event-loop
 * lag).
 *
 * These tests pin the parser's performance and behaviour so the bomb
 * doesn't return.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const {
  mockQuery,
  mockSyncTrackerItem,
  mockUnsyncTrackerItem,
  mockIsTrackerSyncActive,
  mockGetWorkspaceState,
  mockGlobalRegistryGet,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockSyncTrackerItem: vi.fn(),
  mockUnsyncTrackerItem: vi.fn(),
  mockIsTrackerSyncActive: vi.fn(),
  mockGetWorkspaceState: vi.fn((..._args: any[]) => ({})),
  mockGlobalRegistryGet: vi.fn((..._args: any[]) => undefined as any),
}));

vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: {
    query: mockQuery,
  },
}));

vi.mock('../TrackerSyncManager', () => ({
  syncTrackerItem: mockSyncTrackerItem,
  unsyncTrackerItem: mockUnsyncTrackerItem,
  isTrackerSyncActive: mockIsTrackerSyncActive,
}));

vi.mock('../../utils/store', () => ({
  getWorkspaceState: mockGetWorkspaceState,
  isAnalyticsEnabled: () => true,
}));

vi.mock('../../../../../tracker-schema/src/TrackerDataModel', () => ({
  globalRegistry: {
    get: mockGlobalRegistryGet,
    getForWorkspace: (_workspacePath: string, type: string) => mockGlobalRegistryGet(type),
    hasWorkspaceLayer: () => true,
  },
}));

import { ElectronDocumentService } from '../ElectronDocumentService';

let tempDir: string;
let service: ElectronDocumentService;

beforeEach(async () => {
  vi.clearAllMocks();
  mockGetWorkspaceState.mockReturnValue({});
  mockGlobalRegistryGet.mockReturnValue(undefined);
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parse-tracker-test-'));
  service = new ElectronDocumentService(tempDir);
});

afterEach(async () => {
  service?.destroy();
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function parseFile(content: string): Promise<any[]> {
  return (service as any).parseTrackerItems(content, 'doc.md');
}

/** Write `doc.md` and run the full cache-update path over it. */
async function refreshTrackerItems(content: string): Promise<void> {
  await fs.writeFile(path.join(tempDir, 'doc.md'), content, 'utf-8');
  await (service as any).updateTrackerItemsCache('doc.md');
}

describe('parseTrackerItems — correctness', () => {
  it('extracts a basic tracker item with title, type and props', async () => {
    const items = await parseFile('Fix the login flow #bug[id:bug-001 status:to-do]\n');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'bug-001',
      type: 'bug',
      title: 'Fix the login flow',
      status: 'to-do',
    });
  });

  it('strips list-item markers from the title', async () => {
    const items = await parseFile('- Refactor the parser #task[id:task-1 status:in-progress]\n');
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Refactor the parser');
  });

  it('strips unchecked checkbox markers from the title', async () => {
    const items = await parseFile('[ ] Ship the fix #task[id:task-2]\n');
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Ship the fix');
  });

  it('requires a non-empty title (rejects bare tag at start of line)', async () => {
    const items = await parseFile('#bug[id:bug-no-title]\n');
    expect(items).toHaveLength(0);
  });

  it('ignores tracker tokens inside fenced code blocks', async () => {
    const content = [
      '```',
      'Example: title #bug[id:in-fence]',
      '```',
      'Real one #bug[id:real]',
      '',
    ].join('\n');
    const items = await parseFile(content);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('real');
  });

  it('ignores tracker tokens inside inline backticks', async () => {
    const items = await parseFile('Example: `title #bug[id:in-backticks]` real text\n');
    expect(items).toHaveLength(0);
  });

  it('captures description from indented lines below', async () => {
    const content = [
      'Fix the parser #bug[id:bug-with-desc]',
      '  This is a multi-line',
      '  description for the bug.',
      '',
    ].join('\n');
    const items = await parseFile(content);
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe('This is a multi-line\ndescription for the bug.');
  });

  it('parses quoted prop values', async () => {
    const items = await parseFile('Fix #bug[id:b1 owner:"Karl Wirth" status:to-do]\n');
    expect(items).toHaveLength(1);
    expect(items[0].owner).toBe('Karl Wirth');
  });

  it('parses hyphenated type names', async () => {
    const items = await parseFile('Write post #devblog-post[id:p-1 status:draft]\n');
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('devblog-post');
  });
});

describe('parseTrackerItems — regression: catastrophic backtracking', () => {
  it('returns within 1s on a 300k-char inline base64 image line', async () => {
    // Reproduces the production hang. The previous regex took 100+ seconds
    // on this input; the patched regex runs in microseconds.
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAA' + 'A'.repeat(300_000);
    const pathological = `![](data:image/png;base64,${base64})`;
    const content = `Normal #bug[id:before] line\n${pathological}\nNormal #bug[id:after] line\n`;

    const t0 = process.hrtime.bigint();
    const items = await parseFile(content);
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

    expect(elapsedMs).toBeLessThan(1000);
    // Surrounding trackers are still parsed correctly.
    expect(items.map(i => i.id).sort()).toEqual(['after', 'before']);
  });

  it('returns within 1s on a file with many pathological lines', async () => {
    // Simulates a markdown file with 5 base64 image lines (matching the
    // collaboration.md profile that the user reported).
    const base64Line = '![](data:image/png;base64,' + 'A'.repeat(250_000) + ')';
    const lines = [
      'Heading line',
      base64Line,
      'Another paragraph',
      base64Line,
      'More text #task[id:t-1 status:to-do]',
      base64Line,
      base64Line,
      base64Line,
      'Final #bug[id:b-1 status:to-do]',
    ];
    const content = lines.join('\n');

    const t0 = process.hrtime.bigint();
    const items = await parseFile(content);
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

    expect(elapsedMs).toBeLessThan(1000);
    expect(items.map(i => i.id).sort()).toEqual(['b-1', 't-1']);
  });
});

/**
 * The parse is cheap; the two `tracker_items` round trips behind it are not.
 * They ran on every metadata refresh regardless of whether the file contained
 * a single marker — 14,709 calls in a five-minute window on a FIFO single-lane
 * DB worker, where round-trip count is the cost that matters.
 */
describe('updateTrackerItemsCache — query frequency', () => {
  beforeEach(() => {
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('skips both queries when an unchanged file has no tracker items', async () => {
    await refreshTrackerItems('Just prose, no markers.\n');
    expect(mockQuery).toHaveBeenCalledTimes(1);

    mockQuery.mockClear();
    await refreshTrackerItems('Just prose, no markers.\n');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('re-queries once the file changes', async () => {
    await refreshTrackerItems('Just prose, no markers.\n');
    mockQuery.mockClear();

    await refreshTrackerItems('Different prose, still no markers.\n');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('never projects inline markers from a throwaway file under temptests/', async () => {
    await fs.mkdir(path.join(tempDir, 'temptests', 'r3'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'temptests', 'r3', 'fixture.md'), 'Fixture #bug[id:b-1 status:to-do]\n', 'utf-8');
    await (service as any).updateTrackerItemsCache('temptests/r3/fixture.md');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('never caches a file that owns rows, so orphans are still reconciled', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'bug-1', type: 'bug', line_number: 1, title: 't', data: '{}', updated: null }],
    });
    await refreshTrackerItems('Marker was removed from this file.\n');
    mockQuery.mockClear();

    await refreshTrackerItems('Marker was removed from this file.\n');
    expect(mockQuery).toHaveBeenCalled();
  });
});
