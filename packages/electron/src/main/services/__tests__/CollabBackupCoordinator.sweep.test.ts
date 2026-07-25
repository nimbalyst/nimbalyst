/**
 * The correctness win of moving conversion off the main process.
 *
 * The pre-migration sweep is a data-safety gate: `requireSuccessfulCollabBackups`
 * throws "Encryption migration blocked" unless EVERY locally-known shared
 * document produced a fresh plaintext backup. Main can only ever hold the
 * codecs it statically imports, so a shared document of any other type -- any
 * structured marketplace editor -- used to come back "No adapter for X" and
 * block the whole org's custody migration.
 *
 * Delegating to a codec host removes that cliff. This asserts the sweep now
 * succeeds for a document type main could never resolve.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const backupNow = vi.hoisted(() => vi.fn());
const roomDocs = vi.hoisted(() => new Map<string, any>());
const originRows = vi.hoisted(() => [] as any[]);

vi.mock('ws', () => ({ default: class {} }));

vi.mock('@nimbalyst/runtime/sync', () => ({
  DocumentSyncProvider: class {
    private config: any;
    constructor(config: any) {
      this.config = config;
      queueMicrotask(() => config.onFirstSyncComplete?.());
    }
    async connect() {}
    getYDoc() { return roomDocs.get(this.config.documentId); }
    hasUndecodedContent() { return false; }
    destroy() {}
  },
}));

vi.mock('../../database/initialize', () => ({
  getDatabase: () => ({
    query: async (sql: string) => {
      if (sql.includes('collab_local_origins')) return { rows: originRows };
      return { rows: [] };
    },
  }),
}));

vi.mock('../TeamService', () => ({
  findTeamForWorkspace: async () => ({ orgId: 'org-1', teamProjectId: 'project-1' }),
  getOrgScopedJwt: async () => 'jwt',
}));

vi.mock('../OrgKeyService', () => ({
  getOrgKey: () => new Uint8Array(),
  getOrgKeyFingerprint: () => 'fp',
  fetchAndUnwrapOrgKey: async () => new Uint8Array(),
  fetchTeamKeyStatus: async () => ({ custodyMode: 'server-managed' }),
  getArchivedOrgKeys: () => [],
}));

vi.mock('../TrackerPolicyService', () => ({
  getEffectiveTrackerSyncPolicy: () => ({}),
  shouldSyncTrackerItem: () => false,
}));

vi.mock('../CollabBackupService', () => ({
  getCollabBackupService: () => ({ backupNow }),
}));

vi.mock('../../utils/collabSyncUrl', () => ({
  getCollabSyncWsUrl: () => 'wss://example.invalid',
  getCollabSyncHttpUrl: () => 'https://example.invalid',
}));

vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

// Stand in for the renderer codec host: it knows the structured type main
// cannot load. Anything it does not know fails, exactly as a real host would.
vi.mock('../CollabConversionClient', () => ({
  convertRecoveryPlaintext: async (documentType: string, yDoc: any) => {
    if (documentType !== 'com.example.structured') {
      throw new Error(`No collab codec is registered for document type '${documentType}'`);
    }
    return yDoc.getText('body').toString();
  },
  describeCollabCodec: async (documentType: string) => {
    if (documentType !== 'com.example.structured') {
      throw new Error(`No collab codec is registered for document type '${documentType}'`);
    }
    return {
      documentType,
      fileExtensions: ['.example'],
      mimeType: 'application/x-example',
      layoutVersion: 1,
    };
  },
  convertFromFileIntoDoc: vi.fn(),
}));

import { backupCollabProject } from '../CollabBackupCoordinator';
import { requireSuccessfulCollabBackups } from '../CollabBackupMigrationGate';

function addOrigin(documentId: string, documentType: string, body: string): void {
  originRows.push({
    document_id: documentId,
    document_type: documentType,
    relative_path: `diagrams/${documentId}`,
    source_basename: documentId,
  });
  const doc = new Y.Doc();
  doc.getText('body').insert(0, body);
  roomDocs.set(documentId, doc);
}

describe('pre-migration sweep over a document type main cannot resolve', () => {
  beforeEach(() => {
    // A structured marketplace editor: never statically importable by main,
    // and no `text` descriptor to forward either.
    addOrigin('doc-structured', 'com.example.structured', 'structured document contents');
    backupNow.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    originRows.length = 0;
    roomDocs.clear();
    backupNow.mockReset();
  });

  it('backs the document up instead of blocking the custody migration', async () => {
    const summary = await backupCollabProject('/repos/app');

    expect(summary.failures).toEqual([]);
    expect(summary.success).toBe(true);
    expect(summary.backedUp).toBe(1);
    // The gate is the reason this matters: it throws on any failure.
    expect(requireSuccessfulCollabBackups([summary])).toEqual(['project-1']);
  });

  it('stores the plaintext under the extension the codec host reports', async () => {
    await backupCollabProject('/repos/app');

    expect(backupNow).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'doc-structured',
      extension: '.example',
      plaintext: 'structured document contents',
    }));
  });

  it('still blocks the migration when no codec host can resolve a type', async () => {
    addOrigin('doc-unknown', 'com.example.unknowable', 'unreachable');

    const summary = await backupCollabProject('/repos/app');

    expect(summary.success).toBe(false);
    expect(summary.failures).toEqual([{
      documentId: 'doc-unknown',
      error: "No collab codec is registered for document type 'com.example.unknowable'",
    }]);
    expect(() => requireSuccessfulCollabBackups([summary]))
      .toThrow('Encryption migration blocked');
  });
});
