// @vitest-environment node

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bindingRow: null as Record<string, unknown> | null,
  sharedContent: new Uint8Array() as Uint8Array<ArrayBufferLike>,
  databaseQuery: vi.fn(),
  convertExportToFile: vi.fn(),
  createSnapshot: vi.fn(),
  markEditorSave: vi.fn(),
}));

vi.mock('@nimbalyst/runtime/sync', () => ({
  DocumentSyncProvider: class {
    private readonly config: { onFirstSyncComplete?: () => void };
    constructor(config: { onFirstSyncComplete?: () => void }) {
      this.config = config;
    }
    async connect() {
      this.config.onFirstSyncComplete?.();
    }
    getYDoc() { return {}; }
    getLastWriterUserId() { return 'member-1'; }
    getLastUpdatedAt() { return 1234; }
    destroy() {}
  },
}));

vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: mocks.databaseQuery },
}));

vi.mock('../CollabConversionClient', () => ({
  describeCollabCodec: vi.fn().mockResolvedValue({}),
  convertExportToFile: mocks.convertExportToFile,
  convertFromFileIntoDoc: vi.fn(),
}));

vi.mock('../TeamService', () => ({
  findTeamForWorkspace: vi.fn().mockResolvedValue({
    orgId: 'org-1',
    teamProjectId: 'project-1',
    gitRemoteHash: null,
  }),
  getOrgScopedIdentity: vi.fn().mockResolvedValue({ jwt: 'jwt', teamMemberId: 'member-1' }),
  getOrgScopedJwt: vi.fn().mockResolvedValue('jwt'),
}));

vi.mock('../../utils/collabSyncUrl', () => ({
  getCollabSyncHttpUrl: vi.fn(() => 'https://sync.invalid'),
  getCollabSyncWsUrl: vi.fn(() => 'wss://sync.invalid'),
}));

vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

vi.mock('../CollabAssetUploader', () => ({ uploadCollabAsset: vi.fn() }));
vi.mock('../CollabAssetStore', () => ({ getCollabAssetStore: vi.fn(() => ({})) }));
vi.mock('../StytchAuthService', () => ({ getPersonalUserId: vi.fn(() => 'account-1') }));
vi.mock('../../protocols/collabAssetProtocol', () => ({ readCollabAsset: vi.fn() }));
vi.mock('../../HistoryManager', () => ({
  historyManager: { createSnapshot: mocks.createSnapshot },
}));
vi.mock('../../file/SessionFileWatcher', () => ({
  SessionFileWatcher: { markEditorSave: mocks.markEditorSave },
}));

import { pullFromSharedOrigin, recordLocalOriginShare } from '../CollabLocalOriginService';
import { setLocalOriginTeamResolverForTests } from '../collabLocalOriginTeam';
import { hashCollabFileContent } from '../CollabLocalOriginSync';

function createBindingRow(
  relativePath: string,
  localBaseline: string | null,
  sharedBaseline: string | null,
  documentType = 'binary-test',
) {
  return {
    org_id: 'org-1',
    document_id: 'doc-1',
    project_id: 'project-1',
    git_remote_hash: null,
    workspace_path_hash: 'workspace-hash',
    relative_path: relativePath,
    document_type: documentType,
    source_basename: path.basename(relativePath),
    last_local_content_hash: localBaseline,
    last_collab_content_hash: sharedBaseline,
    last_synced_at: null,
    last_seen_mtime_ms: null,
    last_seen_size_bytes: null,
    resolution_status: 'resolved',
    resolution_error: null,
    created_at: new Date('2026-08-07T12:00:00.000Z'),
    updated_at: new Date('2026-08-07T12:00:00.000Z'),
  };
}

describe('pullFromSharedOrigin', () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'nimbalyst-pull-service-'));
    mocks.databaseQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO collab_local_origins')) {
        if (mocks.bindingRow) {
          mocks.bindingRow.last_local_content_hash = params[8];
          mocks.bindingRow.last_collab_content_hash = params[9];
          mocks.bindingRow.last_synced_at = params[10];
          mocks.bindingRow.last_seen_mtime_ms = params[11];
          mocks.bindingRow.last_seen_size_bytes = params[12];
          mocks.bindingRow.resolution_status = params[13];
          mocks.bindingRow.updated_at = new Date();
        }
        return { rows: [] };
      }
      return { rows: mocks.bindingRow ? [mocks.bindingRow] : [] };
    });
    mocks.convertExportToFile.mockImplementation(async () => mocks.sharedContent);
  });

  afterEach(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
    mocks.bindingRow = null;
    mocks.sharedContent = new Uint8Array();
    vi.clearAllMocks();
  });

  it('writes exact shared bytes and persists the final local/shared baselines', async () => {
    const relativePath = 'drawing.bin';
    const sourcePath = path.join(workspacePath, relativePath);
    const original = new Uint8Array([1, 2, 3]);
    const previousShared = new Uint8Array([4, 5, 6]);
    mocks.sharedContent = new Uint8Array([0xff, 0x00, 0x7f]);
    await fs.writeFile(sourcePath, original);
    mocks.bindingRow = createBindingRow(
      relativePath,
      hashCollabFileContent(original),
      hashCollabFileContent(previousShared),
    );

    const result = await pullFromSharedOrigin({ workspacePath, documentId: 'doc-1' });

    expect(result.status).toBe('pulled');
    expect(Array.from(await fs.readFile(sourcePath))).toEqual(Array.from(mocks.sharedContent));
    expect(mocks.bindingRow.last_local_content_hash).toBe(hashCollabFileContent(mocks.sharedContent));
    expect(mocks.bindingRow.last_collab_content_hash).toBe(hashCollabFileContent(mocks.sharedContent));
    expect(mocks.markEditorSave).toHaveBeenCalledWith(sourcePath);
  });

  it('snapshots the previous text content before replacing the source file', async () => {
    const relativePath = 'notes.txt';
    const sourcePath = path.join(workspacePath, relativePath);
    const original = 'local original';
    const previousShared = 'shared original';
    mocks.sharedContent = new TextEncoder().encode('shared replacement');
    mocks.convertExportToFile.mockResolvedValue('shared replacement');
    await fs.writeFile(sourcePath, original);
    mocks.bindingRow = createBindingRow(
      relativePath,
      hashCollabFileContent(original),
      hashCollabFileContent(previousShared),
      'text-test',
    );

    const result = await pullFromSharedOrigin({ workspacePath, documentId: 'doc-1' });

    expect(result.status).toBe('pulled');
    expect(mocks.createSnapshot).toHaveBeenCalledWith(
      sourcePath,
      original,
      'manual',
      'Before pulling shared document',
    );
    expect(mocks.createSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.markEditorSave.mock.invocationCallOrder[0],
    );
    expect(await fs.readFile(sourcePath, 'utf8')).toBe('shared replacement');
  });

  it('does not overwrite a newly changed local file under a stale confirmation token', async () => {
    const relativePath = 'drawing.bin';
    const sourcePath = path.join(workspacePath, relativePath);
    const baselineLocal = new Uint8Array([1]);
    const shared = new Uint8Array([2]);
    const firstLocalChange = new Uint8Array([3]);
    const secondLocalChange = new Uint8Array([4]);
    mocks.sharedContent = shared;
    await fs.writeFile(sourcePath, firstLocalChange);
    mocks.bindingRow = createBindingRow(
      relativePath,
      hashCollabFileContent(baselineLocal),
      hashCollabFileContent(shared),
    );

    const first = await pullFromSharedOrigin({ workspacePath, documentId: 'doc-1' });
    expect(first.status).toBe('conflict');
    expect(first.conflictToken).toBeTruthy();

    await fs.writeFile(sourcePath, secondLocalChange);
    const forced = await pullFromSharedOrigin({
      workspacePath,
      documentId: 'doc-1',
      forceOverwriteLocal: true,
      conflictToken: first.conflictToken,
    });

    expect(forced.status).toBe('conflict');
    expect(forced.conflictToken).not.toBe(first.conflictToken);
    expect(Array.from(await fs.readFile(sourcePath))).toEqual(Array.from(secondLocalChange));
    expect(mocks.markEditorSave).not.toHaveBeenCalled();
  });
});

describe('local-origin team resolution', () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'nimbalyst-origin-team-'));
    mocks.bindingRow = null;
    mocks.databaseQuery.mockReset();
    mocks.databaseQuery.mockImplementation(async () => ({ rows: [] }));
  });

  afterEach(async () => {
    setLocalOriginTeamResolverForTests(null);
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  async function shareAndReadInsertedOrgId(): Promise<unknown> {
    const sourceFilePath = path.join(workspacePath, 'notes.csv');
    await fs.writeFile(sourceFilePath, 'a,b\n');
    await recordLocalOriginShare({
      workspacePath,
      documentId: 'doc-1',
      documentType: 'csv',
      sourceFilePath,
      lastLocalContentHash: null,
      lastCollabContentHash: null,
    });
    const insert = mocks.databaseQuery.mock.calls.find(
      ([sql]) => String(sql).includes('INSERT INTO collab_local_origins'),
    );
    return (insert?.[1] as unknown[] | undefined)?.[0];
  }

  it('binds the share to the team discovered for the workspace', async () => {
    expect(await shareAndReadInsertedOrgId()).toBe('org-1');
  });

  it('lets the Playwright collab bridge supply the org discovery cannot', async () => {
    // `findTeamForWorkspace` fails closed on `isAuthenticated()`, and the collab
    // E2E harness has no Stytch session, so every harness Share to Team threw
    // "No team found for this workspace" and left a sticky error toast that
    // outlived the certification step that produced it.
    setLocalOriginTeamResolverForTests(async () => ({
      orgId: 'e2e-org',
      teamProjectId: null,
      gitRemoteHash: null,
    }));
    expect(await shareAndReadInsertedOrgId()).toBe('e2e-org');
  });
});
