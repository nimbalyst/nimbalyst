/**
 * Scan-cap recovery (NIM-879).
 *
 * The Plans/tracker view is fed by metadataCache, populated by a document scan
 * with a time budget. Under load the startup scan can hit the cap before reaching
 * gitignored nimbalyst-local/plans, silently dropping plans. The fix: record when
 * a scan stops early and run ONE background completion pass with an extended
 * budget. These tests cover (a) the scan/projection reaches nested plan files,
 * and (b) an early stop schedules an extended-budget completion pass.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const { mockQuery, mockGlobalRegistryGet } = vi.hoisted(() => ({
  mockQuery: vi.fn(async () => ({ rows: [] })),
  mockGlobalRegistryGet: vi.fn((_t: string) => ({ modes: { fullDocument: true } }) as any),
}));

vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: { query: mockQuery } }));
vi.mock('../TrackerSyncManager', () => ({
  syncTrackerItem: vi.fn(), unsyncTrackerItem: vi.fn(), isTrackerSyncActive: vi.fn(() => false),
}));
vi.mock('../MainBodyDocService', () => ({ applyHeadlessBodyMarkdown: vi.fn() }));
vi.mock('../TrackerIdentityService', () => ({ getCurrentIdentity: () => ({ email: 'g@x.com', displayName: 'G' }) }));
vi.mock('../../utils/store', () => ({ getWorkspaceState: () => ({}), isAnalyticsEnabled: () => true }));
vi.mock('@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel', () => ({
  globalRegistry: { get: mockGlobalRegistryGet },
}));

import { ElectronDocumentService } from '../ElectronDocumentService';

let tempDir: string;
let service: ElectronDocumentService;

beforeEach(async () => {
  vi.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [] });
  mockGlobalRegistryGet.mockReturnValue({ modes: { fullDocument: true } } as any);
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-recovery-'));
});

afterEach(async () => {
  service?.destroy();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('scan recovery (NIM-879)', () => {
  it('projects a nested plan file into the tracker metadata list', async () => {
    const planDir = path.join(tempDir, 'nimbalyst-local', 'plans', 'teams');
    await fs.mkdir(planDir, { recursive: true });
    await fs.writeFile(
      path.join(planDir, 'deep-plan.md'),
      '---\nplanStatus:\n  title: Deep Plan\n  status: in-development\n---\n# body\n',
      'utf8',
    );

    service = new ElectronDocumentService(tempDir);
    await (service as any).refreshDocuments(120000);

    const items = await (service as any).listFullDocumentTrackerItemsFromMetadata();
    const plan = items.find((i: any) => i.sourceRef?.endsWith('deep-plan.md'));
    expect(plan).toBeTruthy();
    expect(plan.title).toBe('Deep Plan');
    expect((service as any).lastScanStoppedEarly).toBe(false);
  });

  it('uses numeric frontmatter dates as stable tracker fallback timestamps', async () => {
    const updatedAt = Date.parse('2023-11-14T22:13:20.000Z');
    service = new ElectronDocumentService(tempDir);
    (service as any).initializationPromise = Promise.resolve();
    (service as any).metadataCache.set('doc-1', {
      id: 'doc-1',
      path: 'nimbalyst-local/plans/numeric-date-plan.md',
      workspace: tempDir,
      frontmatter: {
        planStatus: {
          title: 'Numeric Date Plan',
          updated: updatedAt,
        },
      },
      lastIndexed: new Date(),
    });

    const items = await (service as any).listFullDocumentTrackerItemsFromMetadata();
    const plan = items.find((i: any) => i.sourceRef?.endsWith('numeric-date-plan.md'));
    expect(plan).toBeTruthy();
    expect(plan.lastIndexed.getTime()).toBe(updatedAt);
  });

  it('schedules an extended-budget completion pass when a scan stops early', async () => {
    vi.useFakeTimers();
    service = new ElectronDocumentService(tempDir);

    // Simulate a default-budget scan that truncated, then a complete extended pass.
    const budgets: number[] = [];
    const scanSpy = vi.spyOn(service as any, 'scanDocuments').mockImplementation(async (...args: any[]) => {
      const budget = args[0] as number;
      budgets.push(budget);
      // First (default) pass stops early; the extended pass completes.
      (service as any).lastScanStoppedEarly = budget < ElectronDocumentService['EXTENDED_SCAN_TIME_MS'];
      return [];
    });

    await (service as any).refreshDocuments(); // default budget -> stops early -> schedules
    expect((service as any).lastScanStoppedEarly).toBe(true);
    expect((service as any).extendedScanScheduled).toBe(true);

    // Fire the scheduled completion pass.
    await vi.advanceTimersByTimeAsync(2000);
    await vi.runOnlyPendingTimersAsync();

    // The completion pass ran with the EXTENDED budget and cleared the flag.
    expect(budgets).toContain(ElectronDocumentService['EXTENDED_SCAN_TIME_MS']);
    expect((service as any).lastScanStoppedEarly).toBe(false);
    expect((service as any).extendedScanScheduled).toBe(false);

    scanSpy.mockRestore();
    vi.useRealTimers();
  });
});
