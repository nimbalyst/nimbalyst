/**
 * Tests for full-document tracker freshness after an EXTERNAL edit -- the file
 * on disk is rewritten by another editor or an agent, with no in-app save and
 * no workspace rescan.
 *
 * Two read-path lies are covered:
 *  1. `listTrackerItems` serves the pre-edit frontmatter out of `metadataCache`,
 *     which nothing invalidates between the one-shot startup scan and a restart.
 *  2. When a fresh DB projection row exists (any `tracker_get`/`tracker_update`
 *     re-reads the file into one), the merge still overrides the core fields
 *     with the stale cache value while letting the row's `customFields` through
 *     -- an old status next to post-edit custom fields.
 *
 * Mocks: database, TrackerSyncManager, store, tracker registry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const {
  mockQuery,
  mockGetWorkspaceState,
  mockGlobalRegistryGet,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetWorkspaceState: vi.fn((..._args: any[]) => ({})),
  mockGlobalRegistryGet: vi.fn((..._args: any[]) => undefined as any),
}));

vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: mockQuery },
}));

vi.mock('../TrackerSyncManager', () => ({
  syncTrackerItem: vi.fn(),
  unsyncTrackerItem: vi.fn(),
  isTrackerSyncActive: vi.fn(() => false),
}));

vi.mock('../../utils/store', () => ({
  getWorkspaceState: mockGetWorkspaceState,
  isAnalyticsEnabled: () => true,
}));

vi.mock('@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel', () => ({
  globalRegistry: { get: mockGlobalRegistryGet },
}));

import { ElectronDocumentService } from '../ElectronDocumentService';

const ITEM_PATH = 'docs/facts/thing.md';

/** A custom `fullDocument` tracker type, as `.nimbalyst/trackers/fact.yaml` registers. */
const FACT_MODEL = { modes: { fullDocument: true, inline: false } };

function factDocument(status: string, source: string): string {
  return `---
title: A Fact
trackerStatus:
  type: fact
  status: ${status}
  source: ${source}
---

# A Fact
`;
}

let tempDir: string;
let service: ElectronDocumentService;

beforeEach(async () => {
  vi.clearAllMocks();
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  mockGetWorkspaceState.mockReturnValue({});
  // Only `fact` is a registered full-document type.
  mockGlobalRegistryGet.mockImplementation((type: string) =>
    type === 'fact' ? FACT_MODEL : undefined,
  );
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-service-external-edit-'));
  await fs.mkdir(path.join(tempDir, 'docs', 'facts'), { recursive: true });
});

afterEach(async () => {
  service?.destroy();
  await fs.rm(tempDir, { recursive: true, force: true });
});

/** Rewrite the file on disk, bumping mtime so the change is detectable. */
async function externallyEdit(status: string, source: string): Promise<void> {
  const full = path.join(tempDir, ITEM_PATH);
  await fs.writeFile(full, factDocument(status, source));
  const future = new Date(Date.now() + 2000);
  await fs.utimes(full, future, future);
}

describe('full-document tracker freshness after an external edit', () => {
  beforeEach(async () => {
    await fs.writeFile(path.join(tempDir, ITEM_PATH), factDocument('draft', 'pre-edit'));
    service = new ElectronDocumentService(tempDir);
    // The one-shot startup scan that seeds metadataCache.
    await service.refreshWorkspaceData();
  });

  it('seeds the item from frontmatter on the initial scan', async () => {
    const items = await service.listTrackerItems();

    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('fact');
    expect(items[0].status).toBe('draft');
    expect(items[0].customFields?.source).toBe('pre-edit');
  });

  it('reports the on-disk status after an external edit, with no rescan', async () => {
    await externallyEdit('verified', 'post-edit');

    const items = await service.listTrackerItems();

    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('verified');
    expect(items[0].customFields?.source).toBe('post-edit');
  });

  it('does not serve a stale status next to fresh custom fields', async () => {
    await externallyEdit('verified', 'post-edit');

    // A `tracker_get`/`tracker_update` touch re-reads the file into a DB
    // projection row, so the row is fresh while metadataCache is not.
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: `fact-${ITEM_PATH.replace(/[/.]/g, '-')}`,
          type: 'fact',
          data: JSON.stringify({
            title: 'A Fact',
            status: 'verified',
            customFields: { source: 'post-edit' },
          }),
          workspace: tempDir,
          document_path: ITEM_PATH,
          line_number: 0,
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          last_indexed: new Date().toISOString(),
          sync_status: 'local',
          archived: false,
          archived_at: null,
          source: 'frontmatter',
          source_ref: ITEM_PATH,
        },
      ],
    });

    const items = await service.listTrackerItems();
    const item = items.find((i) => i.type === 'fact');

    expect(item).toBeTruthy();
    // The reported symptom: `source` came back post-edit while `status` did not.
    expect(item!.customFields?.source).toBe('post-edit');
    expect(item!.status).toBe('verified');
  });

  it('adopts a tracker file created after the initial scan', async () => {
    const newPath = path.join(tempDir, 'docs', 'facts', 'second.md');
    await fs.writeFile(newPath, factDocument('draft', 'brand-new'));

    await service.refreshFileMetadata(newPath);

    const items = await service.listTrackerItems();
    expect(items.map((i) => i.module).sort()).toEqual([
      'docs/facts/second.md',
      'docs/facts/thing.md',
    ]);
  });
});
