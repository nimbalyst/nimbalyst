import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import { createPersonalCollabScope } from '@nimbalyst/collab-client/core';

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
  getPersonalCollabHost: vi.fn(),
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
  const personalBodies = new Map<string, string>();
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
    register: async (_scope, documentId, title, documentType, parentFolderId, metadata, placement) => {
      events.push('register');
      documents.push({
        documentId,
        teamProjectId: _scope.indexConfig.teamProjectId ?? null,
        title,
        documentType,
        ...metadata,
        parentFolderId,
        ...(placement?.parentKind === 'item' ? { parentKind: 'item' as const } : {}),
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
    openPersonal: (_scope, document) => {
      published.push(document);
      events.push('open-personal');
    },
    discardPersonal: () => { events.push('discard-personal'); },
    writePersonalBody: async (_scope, documentId, content) => {
      events.push('write-body');
      personalBodies.set(documentId, content);
    },
    trashPersonal: async () => { events.push('trash-personal'); },
    generateId: () => `doc-${++generated}`,
    now: () => 100,
    hashContent: async content => `hash:${typeof content === 'string' ? content : content.byteLength}`,
  };
  return {
    orchestrator: new CollaborativeDocumentCreationOrchestrator(deps),
    deps,
    personalBodies,
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

  it('creates a personal page by registering it locally, without credentials or a room seed', async () => {
    const harness = makeHarness();
    const scope = createPersonalCollabScope('/workspace');

    const document = await harness.orchestrator.create({
      scope,
      descriptor: markdownDescriptor,
      requestedName: 'Reading list',
      parentFolderId: null,
      sourceContent: '# Reading list',
    });

    // The body is written before the page opens; an agent's initialContent
    // must not come back as an empty page.
    expect(harness.events).toEqual(['register', 'write-body', 'open-personal']);
    expect(harness.personalBodies.get(document.documentId)).toBe('# Reading list');
    expect(document).toMatchObject({
      title: 'Reading list',
      teamProjectId: null,
      metadataVersion: 2,
      editorId: 'builtin.lexical',
    });
    expect(harness.published.map((row) => row.documentId)).toEqual([document.documentId]);
    expect(trackTeamAnalyticsEvent).not.toHaveBeenCalledWith('collab_document_created', expect.anything());
  });

  it('fails a personal page main refused to save, with the reason, and opens nothing', async () => {
    const scope = createPersonalCollabScope('/workspace');
    const refused = makeHarness();
    refused.deps.register = async () => {
      refused.events.push('register');
      throw new Error('Database not initialized');
    };
    await expect(refused.orchestrator.create({
      scope, descriptor: markdownDescriptor, requestedName: 'Ideas', parentFolderId: null,
    })).rejects.toMatchObject({ code: 'register-failed', message: 'Database not initialized' });
    expect(refused.events).toEqual(['register', 'discard-personal']);
    expect(refused.published).toEqual([]);

    const unsaved = makeHarness({ registrationAcked: false });
    await expect(unsaved.orchestrator.create({
      scope, descriptor: markdownDescriptor, requestedName: 'Ideas', parentFolderId: null,
    })).rejects.toMatchObject({ code: 'register-failed' });
    expect(unsaved.events).toEqual(['register', 'discard-personal']);
    expect(unsaved.published).toEqual([]);
  });

  it('sends a personal page whose body did not save to Trash and fails, rather than leaving it empty', async () => {
    const harness = makeHarness();
    harness.deps.writePersonalBody = async () => {
      harness.events.push('write-body');
      throw new Error('disk full');
    };
    await expect(harness.orchestrator.create({
      scope: createPersonalCollabScope('/workspace'), descriptor: markdownDescriptor,
      requestedName: 'Notes', parentFolderId: null, sourceContent: 'Some notes',
    })).rejects.toMatchObject({ message: expect.stringContaining('disk full') });
    expect(harness.events).toEqual(['register', 'write-body', 'trash-personal']);
    expect(harness.published).toEqual([]);

    // No content, nothing to write.
    const empty = makeHarness();
    await empty.orchestrator.create({
      scope: createPersonalCollabScope('/workspace'), descriptor: markdownDescriptor, requestedName: 'Blank', parentFolderId: null,
    });
    expect(empty.events).toEqual(['register', 'open-personal']);

    // A new editor page starts from its type's default file, not an empty file its editor cannot read.
    const blankMockup = { ...mockupDescriptor, creation: { defaultContent: '<html></html>', source: 'newFileMenu' as const } };
    const mockup = makeHarness({ descriptor: blankMockup });
    const created = await mockup.orchestrator.create({
      scope: createPersonalCollabScope('/workspace'), descriptor: blankMockup, requestedName: 'Login', parentFolderId: null,
    });
    expect(mockup.personalBodies.get(created.documentId)).toBe('<html></html>');
  });

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
      title: 'Architecture',
      documentType: 'markdown',
      metadataVersion: 2,
      fileExtension: '.md',
      editorId: 'builtin.lexical',
    });
    expect(register).toHaveBeenCalledWith(
      TEST_SCOPE,
      'doc-1',
      'Architecture',
      'markdown',
      null,
      { metadataVersion: 2, fileExtension: '.md', editorId: 'builtin.lexical' },
      { parentKind: 'page' },
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

  it("creates a type's prose page once, under the type's parent, as `type-page:<typeId>` without opening it", async () => {
    const harness = makeHarness({
      folders: [{ folderId: 'arch', parentFolderId: null, name: 'Architecture', sortOrder: 0, createdBy: '', createdAt: 1, updatedAt: 1 }],
    });
    const input = { scope: TEST_SCOPE, typeId: 'module', typeName: 'Modules', parentFolderId: 'arch' };

    const [first, concurrent] = await Promise.all([harness.orchestrator.ensureTypePage(input), harness.orchestrator.ensureTypePage(input)]);
    const again = await harness.orchestrator.ensureTypePage(input);

    expect(first).toMatchObject({ documentId: 'type-page:module', title: 'Modules', parentFolderId: 'arch', documentType: 'markdown' });
    expect(concurrent.documentId).toBe('type-page:module');
    expect(again.documentId).toBe('type-page:module');
    expect(harness.events).toEqual(['resolve-config', 'register', 'cleanup']);

    // A page of the same name beside it does not block the type page, and a
    // placement parent that is gone puts it at the root instead.
    const crowded = makeHarness({
      documents: [{ documentId: 'p', teamProjectId: null, title: 'Modules.md', documentType: 'markdown', createdBy: '', createdAt: 1, updatedAt: 1 }],
    });
    expect(await crowded.orchestrator.ensureTypePage({ ...input, parentFolderId: null })).toMatchObject({ documentId: 'type-page:module', title: 'Modules (type)' });
    const orphaned = makeHarness();
    expect(await orphaned.orchestrator.ensureTypePage(input)).toMatchObject({ documentId: 'type-page:module', parentFolderId: null });

    const personal = makeHarness();
    await personal.orchestrator.ensureTypePage({ ...input, scope: createPersonalCollabScope('/workspace'), parentFolderId: null });
    expect(personal.events).toEqual(['register']);
  });

  it('creates the prose of the same type id in two workspaces from one renderer', async () => {
    const harness = makeHarness();
    // Each workspace has its own index; neither sees the other's row.
    harness.deps.getDocuments = () => [];
    const input = { typeId: 'module', typeName: 'Modules', parentFolderId: null };
    await harness.orchestrator.ensureTypePage({ ...input, scope: createPersonalCollabScope('/workspace-a') });
    await expect(harness.orchestrator.ensureTypePage({ ...input, scope: createPersonalCollabScope('/workspace-b') }))
      .resolves.toMatchObject({ documentId: 'type-page:module' });
    expect(harness.events).toEqual(['register', 'register']);
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
        // A markdown page stores its bare name; other types keep their suffix.
        title: documentType === 'markdown' ? 'Untitled' : `Untitled${suffix}`,
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

  it('stores a bare page name that collides with an older ".md" or full-path sibling title', async () => {
    const existing = (documentId: string, title: string, parentFolderId: string | null = null) => ({
      documentId, teamProjectId: null, title, documentType: 'markdown', createdBy: '', createdAt: 1, updatedAt: 1, parentFolderId,
    });
    const harness = makeHarness({ documents: [existing('old', 'Specs.md')] });
    await expect(harness.orchestrator.create({
      scope: TEST_SCOPE, descriptor: markdownDescriptor, requestedName: 'Specs', parentFolderId: null, sourceContent: '',
    })).rejects.toMatchObject({ code: 'name-collision' });
    const document = await harness.orchestrator.create({
      scope: TEST_SCOPE, descriptor: markdownDescriptor, requestedName: 'Folder/Child.md', parentFolderId: null, sourceContent: '',
    });
    expect(document.title).toBe('Child');
  });

  it('creates a page under a typed page, colliding only with that typed page\'s children', async () => {
    const existing = (documentId: string, title: string, parentFolderId: string | null, parentKind?: 'item') => ({
      documentId, teamProjectId: null, title, documentType: 'markdown', createdBy: '', createdAt: 1, updatedAt: 1, parentFolderId,
      ...(parentKind ? { parentKind } : {}),
    });
    const harness = makeHarness({ documents: [existing('root-notes', 'Notes', null), existing('item-notes', 'Plan', 'mod_1', 'item')] });
    const register = vi.spyOn(harness.deps, 'register');
    const document = await harness.orchestrator.create({
      scope: TEST_SCOPE, descriptor: markdownDescriptor, requestedName: 'Notes', parentFolderId: 'mod_1', parentKind: 'item', sourceContent: '',
    });
    expect(document).toMatchObject({ title: 'Notes', parentFolderId: 'mod_1', parentKind: 'item' });
    expect(register).toHaveBeenCalledWith(
      TEST_SCOPE, 'doc-1', 'Notes', 'markdown', 'mod_1', expect.anything(), { parentKind: 'item' },
    );
    await expect(harness.orchestrator.create({
      scope: TEST_SCOPE, descriptor: markdownDescriptor, requestedName: 'Plan', parentFolderId: 'mod_1', parentKind: 'item', sourceContent: '',
    })).rejects.toMatchObject({ code: 'name-collision' });
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
