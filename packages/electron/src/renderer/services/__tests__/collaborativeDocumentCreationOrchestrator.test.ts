import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

const { trackTeamAnalyticsEvent } = vi.hoisted(() => ({
  trackTeamAnalyticsEvent: vi.fn(),
}));

vi.mock('@nimbalyst/runtime/store', () => ({
  store: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../utils/collabDocumentOpener', () => ({
  removeCollabConfigsForDocument: vi.fn(),
  resolveCollabConfigForUri: vi.fn(),
}));
vi.mock('../../utils/documentSeedOrchestrator', () => ({ seedSharedDocument: vi.fn() }));
vi.mock('../../components/CollabMode/collabTree', () => ({
  getCollabNodeName: (value: string) => value.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '',
  getSharedDocumentDisplayPath: (document: { title: string }) => document.title,
  joinCollabPath: (parent: string, name: string) => [parent, name].filter(Boolean).join('/'),
  normalizeCollabPath: (value: string) => value.replace(/\\/g, '/').split('/').filter(Boolean).join('/'),
}));
vi.mock('../../store/atoms/collabDocuments', () => ({
  getSharedDocumentsForScope: vi.fn(() => []),
  getSharedFoldersForScope: vi.fn(() => []),
  pendingCollabDocumentAtom: Symbol('pendingCollabDocumentAtom'),
  registerDocumentInIndex: vi.fn(),
  trashSharedDocument: vi.fn(),
  sharedDocumentsAtom: Symbol('sharedDocumentsAtom'),
  sharedFoldersAtom: Symbol('sharedFoldersAtom'),
}));
vi.mock('../../store/atoms/openProjects', () => ({ activeWorkspacePathAtom: Symbol('activeWorkspacePathAtom') }));
vi.mock('../../store/atoms/windowMode', () => ({ setWindowModeAtom: Symbol('setWindowModeAtom') }));
vi.mock('../CollaborativeDocumentTypeCatalog', () => ({
  getCollaborativeDocumentTypeCatalog: vi.fn(),
  normalizeSuffix: (value: string) => {
    const trimmed = value.trim().toLowerCase();
    return trimmed ? (trimmed.startsWith('.') ? trimmed : `.${trimmed}`) : null;
  },
}));
vi.mock('../../utils/logger', () => ({
  logger: { ui: { warn: vi.fn() } },
}));
vi.mock('../../utils/teamAnalytics', () => ({ trackTeamAnalyticsEvent }));

import type {
  CollaborativeDocumentTypeCatalog,
  CollaborativeDocumentTypeDescriptor,
} from '../CollaborativeDocumentTypeCatalog';
import type { SharedDocument, SharedFolder } from '../../store/atoms/collabDocuments';
import {
  CollaborativeDocumentCreationOrchestrator,
  type CollaborativeDocumentCreationDependencies,
} from '../collaborativeDocumentCreationOrchestrator';

const TEST_SCOPE = {
  scopeKey: '/workspace',
  orgId: 'org-1',
  indexConfig: { serverUrl: 'ws://sync', teamMemberId: asTeamMemberId('user-1') },
};

const markdownDescriptor: CollaborativeDocumentTypeDescriptor = {
  documentType: 'markdown',
  displayName: 'Markdown',
  fileExtensions: ['.markdown', '.md'],
  defaultExtension: '.md',
  icon: 'description',
  editor: { kind: 'lexical' as const },
  content: { strategy: 'lexical' as const, codecId: 'markdown' },
  creation: { defaultContent: '', source: 'builtin' as const },
  capabilities: {
    localCreate: true,
    shareToTeam: true,
    sharedCreate: true,
    history: true,
    export: true,
  },
};

const mockupDescriptor: CollaborativeDocumentTypeDescriptor = {
  ...markdownDescriptor,
  documentType: 'mockup.html',
  displayName: 'Mockup',
  fileExtensions: ['.mockup.html'],
  defaultExtension: '.mockup.html',
  editor: { kind: 'extension' as const, extensionId: 'com.nimbalyst.mockup' },
  content: { strategy: 'text' as const, codecId: 'mockup.html' },
};

function makeHarness(options: {
  descriptor?: CollaborativeDocumentTypeDescriptor;
  documents?: SharedDocument[];
  folders?: SharedFolder[];
  seedResults?: boolean[];
  extensionLoaded?: boolean;
  /** Whether the server confirmed the index row landed. */
  registrationAcked?: boolean;
} = {}) {
  const descriptor = options.descriptor ?? markdownDescriptor;
  const documents = options.documents ?? [];
  const folders = options.folders ?? [];
  const events: string[] = [];
  const seedResults = [...(options.seedResults ?? [true])];
  const seedRetryFlags: boolean[] = [];
  let extensionLoaded = options.extensionLoaded ?? true;
  let generated = 0;
  const published: SharedDocument[] = [];

  const resolveMetadata = vi.fn(() => extensionLoaded
    ? { state: 'ready' as const, descriptor }
    : { state: 'unsupported' as const, descriptor, reason: 'The owning extension was unloaded.' });
  const catalog = {
    editorIdForDescriptor: (item: CollaborativeDocumentTypeDescriptor) => {
      if (item.editor.kind === 'lexical') return 'builtin.lexical';
      if (item.editor.kind === 'monaco') return 'builtin.monaco';
      return item.editor.extensionId!;
    },
    resolveMetadata,
  } as unknown as CollaborativeDocumentTypeCatalog;

  const deps: CollaborativeDocumentCreationDependencies = {
    getCatalog: () => catalog,
    getDocuments: () => documents,
    getFolders: () => folders,
    resolveConfig: async () => {
      events.push('resolve-config');
      return { documentId: 'resolved' } as any;
    },
    seed: async (params) => {
      events.push('seed');
      seedRetryFlags.push(params.retryWhileUnregistered === true);
      return seedResults.shift() === false
        ? { ok: false, error: 'ack timed out' }
        : { ok: true };
    },
    register: async (_scope, documentId, title, documentType, parentFolderId, metadata) => {
      events.push('register');
      documents.push({
        documentId,
        teamProjectId: _scope.indexConfig.teamProjectId ?? null,
        title,
        documentType,
        ...metadata,
        parentFolderId,
        createdBy: '',
        createdAt: 100,
        updatedAt: 100,
      });
      return options.registrationAcked ?? true;
    },
    rollbackRegistration: (_scope, documentId) => {
      events.push('rollback');
      const index = documents.findIndex(document => document.documentId === documentId);
      if (index >= 0) documents.splice(index, 1);
    },
    saveLocalOrigin: async () => {
      events.push('save-origin');
      return { success: true };
    },
    publishPending: (_scope, document) => {
      published.push(document);
      events.push('publish');
    },
    cleanup: async () => { events.push('cleanup'); },
    generateId: () => `doc-${++generated}`,
    now: () => 100,
    hashContent: async content => `hash:${typeof content === 'string' ? content : content.byteLength}`,
  };
  return {
    orchestrator: new CollaborativeDocumentCreationOrchestrator(deps),
    deps,
    documents,
    events,
    published,
    seedRetryFlags,
    resolveMetadata,
    setExtensionLoaded(value: boolean) { extensionLoaded = value; },
  };
}

describe('CollaborativeDocumentCreationOrchestrator', () => {
  beforeEach(() => trackTeamAnalyticsEvent.mockClear());

  it('can create a cascade child without publishing it as the pending open document', async () => {
    const harness = makeHarness({ descriptor: mockupDescriptor });

    await harness.orchestrator.create({
      scope: TEST_SCOPE,
      descriptor: mockupDescriptor,
      requestedName: 'embedded.mockup.html',
      parentFolderId: null,
      sourceContent: '<html></html>',
      operationId: 'cascade-child',
      documentId: 'cascade-child-doc',
      openAfterCreate: false,
    });

    expect(harness.published).toEqual([]);
    expect(harness.events).toEqual(['resolve-config', 'register', 'seed', 'cleanup']);
  });

  it('registers one V2 index row before seeding, so the room accepts the write', async () => {
    // NIM-2472: the document room binds its id through the org index and 404s
    // an unregistered id, so seeding first could never connect. The order in
    // `events` IS the regression -- assert it, not just the outcome.
    const harness = makeHarness();
    const register = vi.spyOn(harness.deps, 'register');

    const document = await harness.orchestrator.create({
      scope: TEST_SCOPE,
      descriptor: markdownDescriptor,
      requestedName: 'Architecture',
      parentFolderId: null,
      sourceContent: '# Architecture',
    });

    expect(harness.events).toEqual(['resolve-config', 'register', 'seed', 'cleanup', 'publish']);
    expect(document).toMatchObject({
      title: 'Architecture.md',
      documentType: 'markdown',
      metadataVersion: 2,
      fileExtension: '.md',
      editorId: 'builtin.lexical',
    });
    expect(register).toHaveBeenCalledWith(
      TEST_SCOPE,
      'doc-1',
      'Architecture.md',
      'markdown',
      null,
      { metadataVersion: 2, fileExtension: '.md', editorId: 'builtin.lexical' },
    );
    expect(trackTeamAnalyticsEvent).toHaveBeenCalledWith('collab_document_created', expect.objectContaining({
      source: 'new_document',
      actorType: 'user',
      documentType: 'markdown',
      editorCategory: 'lexical',
    }));
  });

  it('tells the seed to tolerate an in-flight row when registration was not acked', async () => {
    // An unacked registration means a server predating the ack, or a mutation
    // queued offline. The row may still be landing, so the room's 404 is
    // transient -- the seed has to retry rather than fail the whole share.
    const unacked = makeHarness({ registrationAcked: false });
    await unacked.orchestrator.create({
      scope: TEST_SCOPE,
      descriptor: markdownDescriptor,
      requestedName: 'Unconfirmed',
      parentFolderId: null,
      sourceContent: '# Unconfirmed',
    });
    expect(unacked.seedRetryFlags).toEqual([true]);

    // A confirmed registration makes a 404 a real error, so no retry budget.
    const acked = makeHarness({ registrationAcked: true });
    await acked.orchestrator.create({
      scope: TEST_SCOPE,
      descriptor: markdownDescriptor,
      requestedName: 'Confirmed',
      parentFolderId: null,
      sourceContent: '# Confirmed',
    });
    expect(acked.seedRetryFlags).toEqual([false]);
  });

  it('registers an intentional empty markdown document without a content update', async () => {
    const harness = makeHarness();
    await harness.orchestrator.create({
      scope: TEST_SCOPE,
      descriptor: markdownDescriptor,
      requestedName: 'Empty',
      parentFolderId: null,
      sourceContent: '',
    });
    expect(harness.events).toEqual(['resolve-config', 'register', 'cleanup', 'publish']);
  });

  it('trashes the announced row when the seed that follows it fails', async () => {
    // Registration now precedes the seed, so a seed failure leaves a real row
    // behind. It has to be rolled back, and still reported as unannounced so
    // the caller does not try to undo it a second time.
    const harness = makeHarness({ seedResults: [false] });
    await expect(harness.orchestrator.create({
      scope: TEST_SCOPE,
      descriptor: markdownDescriptor,
      requestedName: 'Unannounced',
      parentFolderId: null,
      sourceContent: 'must persist',
    })).rejects.toMatchObject({
      code: 'seed-failed',
      announced: false,
    });
    expect(harness.events).toEqual(['resolve-config', 'register', 'seed', 'rollback', 'cleanup']);
    expect(harness.documents).toEqual([]);
    expect(trackTeamAnalyticsEvent).toHaveBeenCalledWith('collab_operation_failed', expect.objectContaining({
      operation: 'create_document',
      source: 'new_document',
      errorCategory: expect.any(String),
    }));
  });

  it('retries idempotently with the same operation and document id', async () => {
    const harness = makeHarness({ seedResults: [false, true] });
    const input = {
      scope: TEST_SCOPE,
      descriptor: markdownDescriptor,
      requestedName: 'Retry',
      parentFolderId: null,
      sourceContent: 'content',
      operationId: 'share-op-1',
    };

    await expect(harness.orchestrator.create(input)).rejects.toMatchObject({ code: 'seed-failed' });
    const retried = await harness.orchestrator.create(input);
    const repeated = await harness.orchestrator.create(input);

    expect(retried.documentId).toBe('doc-1');
    expect(repeated).toBe(retried);
    // Two registrations, not one: the failed attempt's row was trashed by the
    // rollback, so the retry has to re-announce it. Both the upsert and its
    // ack are idempotent server-side, and re-registering revives the trashed
    // row -- otherwise the retry could never reach its own room.
    expect(harness.events.filter(event => event === 'register')).toHaveLength(2);
    expect(harness.events.filter(event => event === 'publish')).toHaveLength(1);
    expect(harness.resolveMetadata).toHaveBeenCalledOnce();
  });

  it('preserves an exact compound suffix and normalizes its case', async () => {
    const harness = makeHarness({ descriptor: mockupDescriptor });
    const document = await harness.orchestrator.create({
      scope: TEST_SCOPE,
      descriptor: mockupDescriptor,
      requestedName: 'Checkout.MOCKUP.HTML',
      parentFolderId: null,
      sourceContent: '<main />',
    });
    expect(document).toMatchObject({
      title: 'Checkout.mockup.html',
      fileExtension: '.mockup.html',
      editorId: 'com.nimbalyst.mockup',
    });
  });

  it.each([
    ['markdown', 'Markdown', '.md', 'builtin.lexical', 'lexical'],
    ['excalidraw', 'Excalidraw Diagram', '.excalidraw', 'com.nimbalyst.excalidraw', 'structured-yjs'],
    ['prisma', 'Data Model', '.prisma', 'com.nimbalyst.datamodellm', 'structured-yjs'],
    ['csv', 'CSV Spreadsheet', '.csv', 'com.nimbalyst.csv-spreadsheet', 'structured-yjs'],
    ['mockup.html', 'Mockup', '.mockup.html', 'com.nimbalyst.mockuplm', 'text'],
    ['mockupproject', 'Mockup Project', '.mockupproject', 'com.nimbalyst.mockuplm', 'structured-yjs'],
    ['calc.md', 'Calc Sheet', '.calc.md', 'com.nimbalyst.calc-sheets', 'text'],
  ] as const)(
    'creates and publishes a correctly routed %s shared document',
    async (documentType, displayName, suffix, editorId, strategy) => {
      const descriptor: CollaborativeDocumentTypeDescriptor = documentType === 'markdown'
        ? markdownDescriptor
        : {
            ...mockupDescriptor,
            documentType,
            displayName,
            fileExtensions: [suffix],
            defaultExtension: suffix,
            editor: { kind: 'extension', extensionId: editorId },
            content: { strategy, codecId: documentType },
          };
      const harness = makeHarness({ descriptor });

      const document = await harness.orchestrator.create({
        scope: TEST_SCOPE,
        descriptor,
        requestedName: 'Untitled',
        parentFolderId: null,
        sourceContent: descriptor.creation?.defaultContent ?? '',
      });

      expect(document).toMatchObject({
        title: `Untitled${suffix}`,
        documentType,
        metadataVersion: 2,
        fileExtension: suffix,
        editorId,
      });
      expect(harness.published).toEqual([document]);
    },
  );

  it('rejects a sibling folder collision after applying the exact suffix', async () => {
    const harness = makeHarness({
      folders: [{
        folderId: 'folder-existing',
        parentFolderId: null,
        name: 'Existing.md',
        sortOrder: 0,
        createdBy: '',
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    await expect(harness.orchestrator.create({
      scope: TEST_SCOPE,
      descriptor: markdownDescriptor,
      requestedName: 'Existing',
      parentFolderId: null,
      sourceContent: '',
    })).rejects.toMatchObject({ code: 'name-collision' });
    expect(harness.events).toEqual([]);
  });

  it('saves the local-origin binding after registration and before publish', async () => {
    const harness = makeHarness();
    const save = vi.spyOn(harness.deps, 'saveLocalOrigin' as any);
    await harness.orchestrator.create({
      scope: TEST_SCOPE,
      descriptor: markdownDescriptor,
      requestedName: 'Promoted.md',
      parentFolderId: null,
      sourceContent: 'rewritten',
      localOrigin: { sourceFilePath: '/workspace/Promoted.md', sourceContent: 'original' },
    });
    expect(harness.events).toEqual([
      'resolve-config', 'register', 'seed', 'save-origin', 'cleanup', 'publish',
    ]);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      sourceFilePath: '/workspace/Promoted.md',
      lastLocalContentHash: 'hash:original',
      lastCollabContentHash: 'hash:rewritten',
    }));
  });

  it('fails an extension-unload race before resolving a room or publishing an index row', async () => {
    const harness = makeHarness({ descriptor: mockupDescriptor });
    harness.setExtensionLoaded(false);
    await expect(harness.orchestrator.create({
      scope: TEST_SCOPE,
      descriptor: mockupDescriptor,
      requestedName: 'Unavailable.mockup.html',
      parentFolderId: null,
      sourceContent: '<main />',
    })).rejects.toMatchObject({ code: 'invalid-descriptor', announced: false });
    expect(harness.events).toEqual([]);
    expect(harness.documents).toEqual([]);
  });
});
