// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import {
  CollabScopeResolutionError,
  type CollabHost,
  type CollabPersonalStateRow,
  type CollabScope,
} from '@nimbalyst/collab-client/core';
import {
  activeCollabScopeAtom,
  applyRemoteDocReceiptAtom,
  createCollabDocsScopeLifecycle,
  createCollabDocsSession,
  docReceiptsAtom,
  docUnreadAtom,
  getCollabDocsSession,
  pruneCollabDocsSession,
  setDocUnreadAtom,
  sharedDocumentsAtom,
  type CollabDocsCommand,
  type CollabDocsDataSource,
  type SharedDocument,
} from '..';

const SCOPE: CollabScope = {
  scopeKey: 'session-test-scope',
  orgId: 'org-session-test',
  indexConfig: { serverUrl: 'ws://sync.test', userId: 'member-self' },
};
const OTHER_SCOPE: CollabScope = {
  scopeKey: 'session-test-other-scope',
  orgId: 'org-session-other',
  indexConfig: { serverUrl: 'ws://sync.test', userId: 'member-other-self' },
};
const LIFECYCLE_SCOPE: CollabScope = {
  scopeKey: 'session-lifecycle-scope',
  orgId: 'org-session-lifecycle',
  indexConfig: { serverUrl: 'ws://sync.test', userId: 'member-lifecycle' },
};
const REPLACEMENT_SCOPE: CollabScope = {
  scopeKey: 'session-lifecycle-replacement',
  orgId: 'org-session-lifecycle-replacement',
  indexConfig: { serverUrl: 'ws://sync.test', userId: 'member-replacement' },
};
const UNAVAILABLE_SCOPE: CollabScope = {
  scopeKey: 'session-unavailable-scope',
  orgId: 'org-session-unavailable',
  indexConfig: { serverUrl: 'ws://sync.test', userId: 'member-unavailable' },
};
const ALL_SCOPE_KEYS = [
  SCOPE.scopeKey,
  OTHER_SCOPE.scopeKey,
  LIFECYCLE_SCOPE.scopeKey,
  REPLACEMENT_SCOPE.scopeKey,
  UNAVAILABLE_SCOPE.scopeKey,
];

function document(documentId: string, title = `${documentId}.md`): SharedDocument {
  return {
    documentId,
    teamProjectId: 'project-session-test',
    title,
    documentType: 'markdown',
    createdBy: 'member-author',
    createdAt: 1,
    updatedAt: 20,
    lastWriterUserId: 'member-author',
    parentFolderId: null,
  };
}

interface HarnessOptions {
  documents?: SharedDocument[];
  personalRows?: CollabPersonalStateRow[];
  receiptRows?: Array<{ entityId: string; lastSeenVersion: number | null; lastViewedAt: number }>;
  setFavorite?: (input: any) => Promise<CollabPersonalStateRow | null>;
  recordOpened?: (input: any) => Promise<CollabPersonalStateRow | null>;
  personalStateAvailable?: boolean;
  readReceiptsAvailable?: boolean;
}

function createHarness(scope: CollabScope, options: HarnessOptions = {}) {
  const commands: CollabDocsCommand[] = [];
  let personalStateListener: ((row: CollabPersonalStateRow) => void) | null = null;
  let receiptListener: ((row: {
    entityId: string;
    lastSeenVersion: number | null;
    lastViewedAt: number;
  }) => void) | null = null;
  const dataSource: CollabDocsDataSource = {
    snapshot: vi.fn(async () => ({ items: options.documents ?? [], containers: [] })),
    subscribe: vi.fn(() => () => undefined),
    command: vi.fn(async (command: CollabDocsCommand) => {
      commands.push(command);
      return { ok: true as const, folders: command.type === 'refresh-folders' ? [] : undefined };
    }),
    status: () => 'connected',
    dispose: vi.fn(),
  };
  const personalScope = `personal:${scope.scopeKey}`;
  const reportError = vi.fn();
  const personalStateSnapshot = vi.fn(async () => ({
    scope: personalScope,
    rows: options.personalRows ?? [],
  }));
  const readReceiptSnapshot = vi.fn(async () => options.receiptRows ?? []);
  const host = {
    resolveScope: async () => scope,
    onScopeChanged: () => () => undefined,
    documents: {
      dataSource,
      loadViewPreferences: async () => ({ treeFilter: 'all' as const, showUnreadBubbles: true }),
      saveViewPreferences: async () => undefined,
      documentTypes: () => [],
      createDocument: async () => undefined,
      readReceipts: options.readReceiptsAvailable === false
        ? { status: 'unavailable' as const }
        : { status: 'available' as const, capability: {
        snapshot: readReceiptSnapshot,
        subscribe: (_scope: CollabScope, listener: typeof receiptListener) => {
          receiptListener = listener;
          return () => { receiptListener = null; };
        },
        markViewed: async () => undefined,
        } },
    },
    personalState: options.personalStateAvailable === false
      ? { status: 'unavailable' as const }
      : { status: 'available' as const, capability: {
      snapshot: personalStateSnapshot,
      subscribe: (_scope: CollabScope, listener: (row: CollabPersonalStateRow) => void) => {
        personalStateListener = listener;
        return () => { personalStateListener = null; };
      },
      setFavorite: options.setFavorite ?? (async (input: any) => ({
        scope: personalScope,
        itemId: input.itemId,
        isFavorite: input.isFavorite,
        favoriteUpdatedAt: input.favoriteUpdatedAt,
        lastOpenedAt: null,
        updatedAt: input.favoriteUpdatedAt,
      })),
      recordOpened: options.recordOpened ?? (async (input: any) => ({
        scope: personalScope,
        itemId: input.itemId,
        isFavorite: false,
        favoriteUpdatedAt: 0,
        lastOpenedAt: input.lastOpenedAt,
        updatedAt: input.lastOpenedAt,
      })),
      } },
    reportError,
  } as unknown as CollabHost;
  const session = createCollabDocsSession(scope, dataSource, host as never);
  return {
    commands,
    dataSource,
    host,
    personalScope,
    personalStateSnapshot,
    readReceiptSnapshot,
    reportError,
    session,
    emitPersonalState: (row: CollabPersonalStateRow) => personalStateListener?.(row),
    emitReceipt: (row: {
      entityId: string;
      lastSeenVersion: number | null;
      lastViewedAt: number;
    }) => receiptListener?.(row),
  };
}

afterEach(() => {
  for (const scopeKey of ALL_SCOPE_KEYS) pruneCollabDocsSession(scopeKey);
  store.set(activeCollabScopeAtom, null);
  vi.restoreAllMocks();
});

describe('CollabDocsSession', () => {
  it('does not read, subscribe to, or mutate unavailable personal lanes', async () => {
    const harness = createHarness(UNAVAILABLE_SCOPE, {
      personalStateAvailable: false,
      readReceiptsAvailable: false,
      documents: [document('doc-without-personal-state')],
    });

    expect(harness.session.uiCapabilities).toEqual({
      personalState: false,
      readReceipts: false,
    });
    await expect(harness.session.start()).resolves.toBeUndefined();
    harness.session.toggleFavorite('doc-without-personal-state');
    harness.session.recordOpened('doc-without-personal-state');
    await harness.session.markDocumentViewed('doc-without-personal-state', 20);
    await harness.session.markAllDocumentsViewed();

    expect(harness.personalStateSnapshot).not.toHaveBeenCalled();
    expect(harness.readReceiptSnapshot).not.toHaveBeenCalled();
    expect(store.get(harness.session.atoms.favorites)).toEqual([]);
    expect(store.get(harness.session.atoms.openedAt)).toEqual({});
    expect(store.get(harness.session.atoms.changedDocumentIds)).toEqual(new Set());
  });

  it('routes a receipt that arrives before its collaboration scope activates', async () => {
    store.set(applyRemoteDocReceiptAtom, {
      documentId: 'doc-before-activation',
      orgId: SCOPE.orgId,
      receipt: { lastSeenVersion: null, lastViewedAt: 42 },
    });

    const harness = createHarness(SCOPE);
    expect(harness.session.uiCapabilities).toEqual({
      personalState: true,
      readReceipts: true,
    });
    harness.session.activate();
    await harness.session.start();

    expect(store.get(docReceiptsAtom).get('doc-before-activation')).toEqual({
      lastSeenVersion: null,
      lastViewedAt: 42,
    });
  });

  it('binds atoms to each session while desktop exports retain active-scope identity', async () => {
    const first = createHarness(SCOPE, { documents: [document('doc-first')] });
    const second = createHarness(OTHER_SCOPE, { documents: [document('doc-second')] });
    expect(createCollabDocsSession(SCOPE, first.dataSource, first.host as never)).toBe(first.session);
    expect(getCollabDocsSession(SCOPE.scopeKey)).toBe(first.session);
    expect(first.session.atoms.sharedDocuments).not.toBe(sharedDocumentsAtom);
    expect(second.session.atoms.sharedDocuments).not.toBe(sharedDocumentsAtom);

    await Promise.all([first.session.start(), second.session.start()]);
    first.session.activate();

    expect(store.get(first.session.atoms.sharedDocuments).map((row) => row.documentId))
      .toEqual(['doc-first']);
    expect(store.get(second.session.atoms.sharedDocuments).map((row) => row.documentId))
      .toEqual(['doc-second']);
    expect(store.get(sharedDocumentsAtom).map((row) => row.documentId)).toEqual(['doc-first']);

    second.session.activate();
    expect(store.get(sharedDocumentsAtom).map((row) => row.documentId)).toEqual(['doc-second']);
    expect(store.get(first.session.atoms.sharedDocuments).map((row) => row.documentId))
      .toEqual(['doc-first']);
  });

  it('rolls back failed optimistic state and applies only scoped, advancing rows', async () => {
    const personalScope = `personal:${SCOPE.scopeKey}`;
    const harness = createHarness(SCOPE, {
      documents: [document('doc-state')],
      personalRows: [{
        scope: personalScope,
        itemId: 'doc-state',
        isFavorite: true,
        favoriteUpdatedAt: 10,
        lastOpenedAt: 8,
        updatedAt: 10,
      }],
      receiptRows: [{
        entityId: 'doc-state',
        lastSeenVersion: 5,
        lastViewedAt: 100,
      }],
      setFavorite: async () => { throw new Error('favorite write failed'); },
      recordOpened: async () => { throw new Error('opened write failed'); },
    });
    await harness.session.start();

    harness.session.toggleFavorite('doc-state');
    harness.session.recordOpened('doc-state');
    expect(store.get(harness.session.atoms.favorites)).toEqual([]);
    expect(store.get(harness.session.atoms.openedAt)['doc-state']).toBeGreaterThan(8);
    await vi.waitFor(() => {
      expect(store.get(harness.session.atoms.favorites)).toEqual(['doc-state']);
      expect(store.get(harness.session.atoms.openedAt)).toEqual({ 'doc-state': 8 });
    });
    expect(harness.reportError).toHaveBeenCalledTimes(2);

    harness.emitPersonalState({
      scope: 'personal:wrong-scope',
      itemId: 'doc-state',
      isFavorite: false,
      favoriteUpdatedAt: 100,
      lastOpenedAt: 500,
      updatedAt: 500,
    });
    harness.emitPersonalState({
      scope: personalScope,
      itemId: 'doc-state',
      isFavorite: false,
      favoriteUpdatedAt: 5,
      lastOpenedAt: 4,
      updatedAt: 5,
    });
    expect(store.get(harness.session.atoms.favorites)).toEqual(['doc-state']);
    expect(store.get(harness.session.atoms.openedAt)).toEqual({ 'doc-state': 8 });

    harness.emitPersonalState({
      scope: personalScope,
      itemId: 'doc-state',
      isFavorite: true,
      favoriteUpdatedAt: 20,
      lastOpenedAt: 12,
      updatedAt: 20,
    });
    harness.emitReceipt({
      entityId: 'doc-state',
      lastSeenVersion: 3,
      lastViewedAt: 50,
    });
    harness.emitReceipt({
      entityId: 'doc-state',
      lastSeenVersion: null,
      lastViewedAt: 200,
    });
    expect(store.get(harness.session.atoms.openedAt)).toEqual({ 'doc-state': 12 });
    expect(store.get(harness.session.atoms.receipts).get('doc-state')).toEqual({
      lastSeenVersion: 5,
      lastViewedAt: 200,
    });
  });

  it('migrates nested virtual folders through explicit server commands', async () => {
    const harness = createHarness(SCOPE, {
      documents: [
        document('doc-alpha', 'Projects/Alpha/One.md'),
        document('doc-projects', 'Projects/Two.md'),
      ],
    });

    await harness.session.start();
    await vi.waitFor(() => {
      expect(harness.commands.filter((command) => command.type === 'register-folder')).toHaveLength(2);
      expect(harness.commands.filter((command) => command.type === 'move-document')).toHaveLength(2);
    });

    const folderCommands = harness.commands.filter(
      (command): command is Extract<CollabDocsCommand, { type: 'register-folder' }> =>
        command.type === 'register-folder',
    );
    const projects = folderCommands.find((command) => command.name === 'Projects');
    const alpha = folderCommands.find((command) => command.name === 'Alpha');
    expect(projects).toMatchObject({ parentFolderId: null, sortOrder: 0 });
    expect(alpha).toMatchObject({ parentFolderId: projects?.folderId, sortOrder: 1 });
    expect(harness.commands.filter((command) => command.type === 'move-document')).toEqual([
      { type: 'move-document', documentId: 'doc-alpha', parentFolderId: alpha?.folderId },
      { type: 'move-document', documentId: 'doc-projects', parentFolderId: projects?.folderId },
    ]);
  });

  it('owns retry, replacement, and teardown through the host scope contract', async () => {
    const scopeListener: { current?: (scope: CollabScope | null) => void } = {};
    const first = createHarness(LIFECYCLE_SCOPE);
    let resolvedScope = LIFECYCLE_SCOPE;
    const resolveScope = vi.fn()
      .mockRejectedValueOnce(new CollabScopeResolutionError('not ready', { retryable: true }))
      .mockImplementation(async () => resolvedScope);
    const host = {
      ...first.host,
      resolveScope,
      onScopeChanged: (listener: (scope: CollabScope | null) => void) => {
        scopeListener.current = listener;
        return () => { scopeListener.current = undefined; };
      },
    } as unknown as CollabHost;
    const changes: Array<string | null> = [];
    const lifecycle = createCollabDocsScopeLifecycle(host as never, {
      retryDelaysMs: [0],
      onSessionChanged: (session) => changes.push(session?.scope.scopeKey ?? null),
    });

    lifecycle.start();
    await vi.waitFor(() => expect(changes).toContain(LIFECYCLE_SCOPE.scopeKey));
    expect(resolveScope).toHaveBeenCalledTimes(2);

    resolvedScope = REPLACEMENT_SCOPE;
    scopeListener.current?.(null);
    await vi.waitFor(() => expect(changes.at(-1)).toBe(REPLACEMENT_SCOPE.scopeKey));
    expect(changes).toContain(null);
    expect(store.get(activeCollabScopeAtom)?.scopeKey).toBe(REPLACEMENT_SCOPE.scopeKey);

    lifecycle.dispose();
    expect(store.get(activeCollabScopeAtom)).toBeNull();
    expect(changes.at(-1)).toBeNull();
    expect(first.dataSource.dispose).toHaveBeenCalled();
  });

  it('prunes unread family state for a closed scope', () => {
    store.set(setDocUnreadAtom, {
      scopeKey: SCOPE.scopeKey,
      documentId: 'doc-pruned',
      orgId: SCOPE.orgId,
      unread: true,
    });
    store.set(activeCollabScopeAtom, SCOPE);
    expect(store.get(docUnreadAtom('doc-pruned'))).toBe(true);

    pruneCollabDocsSession(SCOPE.scopeKey);
    store.set(activeCollabScopeAtom, SCOPE);

    expect(store.get(docUnreadAtom('doc-pruned'))).toBe(false);
  });
});
