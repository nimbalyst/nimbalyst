// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import {
  CollabScopeResolutionError,
  createPersonalCollabScope,
  isPersonalCollabScope,
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
  findOtherProjectDocument,
  getCollabDocsSession,
  getSharedDocumentsForScopeKey,
  pruneCollabDocsSession,
  setDocUnreadAtom,
  sharedDocumentsAtom,
  sharedDocumentsForScopeAtom,
  sharedTypePlacementsAtom,
  trashedSharedDocumentsAtom,
  workspaceHasTeamAtom,
  type CollabDocsCommand,
  type CollabDocsDataChange,
  type CollabDocsDataSource,
  type SharedDocument,
  type SharedFolder,
  type SharedTypePlacement,
} from '..';

const SCOPE: CollabScope = {
  scopeKey: 'session-test-scope',
  orgId: 'org-session-test',
  indexConfig: { serverUrl: 'ws://sync.test', teamMemberId: asTeamMemberId('member-self') },
};
const OTHER_SCOPE: CollabScope = {
  scopeKey: 'session-test-other-scope',
  orgId: 'org-session-other',
  indexConfig: { serverUrl: 'ws://sync.test', teamMemberId: asTeamMemberId('member-other-self') },
};
const LIFECYCLE_SCOPE: CollabScope = {
  scopeKey: 'session-lifecycle-scope',
  orgId: 'org-session-lifecycle',
  indexConfig: { serverUrl: 'ws://sync.test', teamMemberId: asTeamMemberId('member-lifecycle') },
};
const REPLACEMENT_SCOPE: CollabScope = {
  scopeKey: 'session-lifecycle-replacement',
  orgId: 'org-session-lifecycle-replacement',
  indexConfig: { serverUrl: 'ws://sync.test', teamMemberId: asTeamMemberId('member-replacement') },
};
const UNAVAILABLE_SCOPE: CollabScope = {
  scopeKey: 'session-unavailable-scope',
  orgId: 'org-session-unavailable',
  indexConfig: { serverUrl: 'ws://sync.test', teamMemberId: asTeamMemberId('member-unavailable') },
};
const PRIMARY_PROJECT_SCOPE: CollabScope = {
  scopeKey: 'session-primary-project-scope',
  orgId: 'org-session-projects',
  indexConfig: { serverUrl: 'ws://sync.test', teamProjectId: 'project-a', teamMemberId: asTeamMemberId('member-projects') },
};
const SECONDARY_PROJECT_SCOPE: CollabScope = {
  scopeKey: 'session-secondary-project-scope',
  orgId: 'org-session-projects',
  indexConfig: { serverUrl: 'ws://sync.test', teamProjectId: 'project-b', teamMemberId: asTeamMemberId('member-projects') },
};
const UNKNOWN_PROJECT_SCOPE: CollabScope = {
  scopeKey: 'session-unknown-project-scope',
  orgId: 'org-session-projects',
  indexConfig: { serverUrl: 'ws://sync.test', teamProjectId: null, teamMemberId: asTeamMemberId('member-projects') },
};
const PERSONAL_SCOPE = createPersonalCollabScope('/workspace/session-test');
const ALL_SCOPE_KEYS = [
  PRIMARY_PROJECT_SCOPE.scopeKey,
  SECONDARY_PROJECT_SCOPE.scopeKey,
  UNKNOWN_PROJECT_SCOPE.scopeKey,
  PERSONAL_SCOPE.scopeKey,
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
  folders?: SharedFolder[];
  typePlacements?: SharedTypePlacement[];
  primaryProjectId?: string | null;
  personalRows?: CollabPersonalStateRow[];
  receiptRows?: Array<{ entityId: string; lastSeenVersion: number | null; lastViewedAt: number }>;
  setFavorite?: (input: any) => Promise<CollabPersonalStateRow | null>;
  recordOpened?: (input: any) => Promise<CollabPersonalStateRow | null>;
  personalStateAvailable?: boolean;
  readReceiptsAvailable?: boolean;
}

function createHarness(scope: CollabScope, options: HarnessOptions = {}) {
  const commands: CollabDocsCommand[] = [];
  let dataListener: ((change: CollabDocsDataChange) => void) | null = null;
  let personalStateListener: ((row: CollabPersonalStateRow) => void) | null = null;
  let receiptListener: ((row: {
    entityId: string;
    lastSeenVersion: number | null;
    lastViewedAt: number;
  }) => void) | null = null;
  const dataSource: CollabDocsDataSource = {
    snapshot: vi.fn(async () => ({
      items: options.documents ?? [],
      containers: options.folders ?? [],
      typePlacements: options.typePlacements,
      ...(options.primaryProjectId !== undefined ? { primaryProjectId: options.primaryProjectId } : {}),
    })),
    subscribe: vi.fn((listener: (change: CollabDocsDataChange) => void) => {
      dataListener = listener;
      return () => undefined;
    }),
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
    emitData: (change: CollabDocsDataChange) => dataListener?.(change),
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

  it('runs a personal scope beside the team scope without claiming a team or the active scope', async () => {
    const personal = createHarness(PERSONAL_SCOPE, {
      documents: [document('doc-personal')],
      personalStateAvailable: false,
      readReceiptsAvailable: false,
    });
    await personal.session.start();

    expect(store.get(personal.session.atoms.sharedDocuments).map((row) => row.documentId))
      .toEqual(['doc-personal']);
    expect(store.get(personal.session.atoms.hasTeam)).toBe(false);
    expect(store.get(activeCollabScopeAtom)).toBeNull();

    const team = createHarness(SCOPE, { documents: [document('doc-team')] });
    team.session.activate();
    await team.session.start();

    expect(store.get(workspaceHasTeamAtom)).toBe(true);
    expect(store.get(activeCollabScopeAtom)?.scopeKey).toBe(SCOPE.scopeKey);
    expect(store.get(sharedDocumentsAtom).map((row) => row.documentId)).toEqual(['doc-team']);
    expect(isPersonalCollabScope(PERSONAL_SCOPE)).toBe(true);
    expect(isPersonalCollabScope(SCOPE)).toBe(false);
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

  it('places, moves and removes tracker types optimistically and takes the server snapshot as truth', async () => {
    const folder: SharedFolder = {
      folderId: 'kb', parentFolderId: null, name: 'KB', sortOrder: 0, createdBy: 'm', createdAt: 1, updatedAt: 1,
    };
    const placed = (typeId: string, parentFolderId: string | null, sortOrder = 7): SharedTypePlacement => ({
      typeId, projectId: 'p1', parentFolderId, sortOrder, createdBy: 'member-self', createdAt: 1, updatedAt: 1,
    });
    const harness = createHarness(SCOPE, { folders: [folder], typePlacements: [placed('module', 'kb')] });
    await harness.session.start();
    harness.session.activate();
    expect(store.get(sharedTypePlacementsAtom)).toEqual([placed('module', 'kb')]);

    await harness.session.moveTypePlacement('module', null);
    await harness.session.placeType('competitor', 'kb');
    expect(store.get(sharedTypePlacementsAtom)).toEqual([
      expect.objectContaining({ typeId: 'module', parentFolderId: null, sortOrder: 7, createdAt: 1 }),
      expect.objectContaining({ typeId: 'competitor', parentFolderId: 'kb', projectId: null }),
    ]);
    // The outcome waits for the server's echo, so an agent hears about a refusal.
    expect(harness.commands).toContainEqual(
      { type: 'set-type-placement', typeId: 'module', parentFolderId: null, sortOrder: 7, confirm: true },
    );

    // Removing the folder drops the placement inside it, as the server does.
    harness.session.removeFolder('kb');
    await harness.session.removeTypePlacement('module');
    expect(store.get(sharedTypePlacementsAtom)).toEqual([]);
    expect(harness.commands).toContainEqual({ type: 'remove-type-placement', typeId: 'module' });

    harness.emitData({
      type: 'snapshot',
      snapshot: { items: [], containers: [], typePlacements: [placed('person', null)] },
    });
    expect(store.get(harness.session.atoms.typePlacements)).toEqual([placed('person', null)]);
    // A snapshot from a host without placements leaves them alone.
    harness.emitData({ type: 'snapshot', snapshot: { items: [], containers: [] } });
    expect(store.get(harness.session.atoms.typePlacements)).toEqual([placed('person', null)]);
  });

  it('builds the page tree from documents and moves, removes and places pages through it', async () => {
    const child = (documentId: string, title: string, parentFolderId: string | null) => ({ ...document(documentId, title), parentFolderId });
    const harness = createHarness(SCOPE, {
      // A path in a title must not start the folder migration in a page tree.
      documents: [child('arch', 'Architecture', null), child('overview', 'Specs/Overview', 'arch'), child('leaf', 'Leaf', 'overview')],
    });
    (harness.dataSource.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [child('arch', 'Architecture', null), child('overview', 'Specs/Overview', 'arch'), child('leaf', 'Leaf', 'overview')],
      containers: [{ folderId: 'projection', name: 'Ignored', sortOrder: 0, createdBy: 'm', createdAt: 1, updatedAt: 1 }],
      itemPlacements: [{ itemId: 'item-1', projectId: 'p1', parentId: 'leaf', sortOrder: 1, createdBy: 'm', createdAt: 1, updatedAt: 1 }],
      pageTree: true,
    });
    await harness.session.start();
    expect(harness.session.isPageTree()).toBe(true);
    expect(harness.commands.some((command) => command.type === 'register-folder')).toBe(false);
    // Every page stands in as a folder, so paths and pickers resolve parents.
    expect(harness.session.getFolders().map((folder) => [folder.folderId, folder.name, folder.parentFolderId]))
      .toEqual([['arch', 'Architecture', null], ['overview', 'Overview', 'arch'], ['leaf', 'Leaf', 'overview']]);

    expect(harness.session.movePage('arch', 'leaf')).toBe(false);
    await expect(harness.session.movePage('leaf', null)).resolves.toEqual({ ok: true });
    expect(harness.commands).toContainEqual({ type: 'move-document', documentId: 'leaf', parentFolderId: null, confirm: true });

    await harness.session.setItemPlacement('item-2', 'overview');
    expect(harness.commands).toContainEqual(expect.objectContaining({ type: 'set-item-placement', itemId: 'item-2', parentId: 'overview' }));
    await harness.session.removeItemPlacement('item-1');
    expect(harness.commands).toContainEqual({ type: 'remove-item-placement', itemId: 'item-1' });

    harness.session.removePage('arch');
    expect(harness.session.getDocuments().map((doc) => doc.documentId)).toEqual(['leaf']);
    // The placement under a trashed page stays, so a restore puts it back.
    expect(harness.session.getItemPlacements().map((placement) => placement.parentId)).toEqual(['overview']);
    expect(harness.commands).toContainEqual(expect.objectContaining({ type: 'trash-document', documentId: 'arch' }));

    // A later snapshot without the flag does not drop back to folders.
    harness.emitData({ type: 'snapshot', snapshot: { items: [], containers: [] } });
    expect(harness.session.isPageTree()).toBe(true);
  });

  it('moves a page and every page under it to Trash, never removing them', async () => {
    const at = (documentId: string, parentFolderId: string | null, trashedAt: number | null = null) =>
      ({ ...document(documentId, documentId), parentFolderId, trashedAt });
    const harness = createHarness(SCOPE);
    (harness.dataSource.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [at('arch', null), at('overview', 'arch'), at('leaf', 'overview'), at('old', 'arch', 5), at('other', null)],
      containers: [],
      pageTree: true,
    });
    await harness.session.start();

    await expect(harness.session.removePage('arch')).resolves.toEqual({ ok: true });
    const trashes = harness.commands.filter((command) => command.type === 'trash-document');
    // One trash time for the subtree; a page already in Trash keeps its own.
    expect(trashes.map((command) => command.documentId).sort()).toEqual(['arch', 'leaf', 'overview']);
    expect(new Set(trashes.map((command) => command.trashedAt)).size).toBe(1);
    expect(harness.commands.some((command) => command.type === 'remove-folder' || command.type === 'remove-document')).toBe(false);
    expect(harness.session.getDocuments().map((doc) => doc.documentId)).toEqual(['other']);
    expect(store.get(harness.session.atoms.trashedSharedDocuments).map((doc) => doc.documentId).sort())
      .toEqual(['arch', 'leaf', 'old', 'overview']);

    // Restoring the page brings back what went with it, not what was trashed before.
    harness.session.restoreDocument('arch');
    expect(harness.commands.filter((command) => command.type === 'restore-document').map((command) => command.documentId).sort())
      .toEqual(['arch', 'leaf', 'overview']);
    expect(harness.session.getDocuments().map((doc) => doc.documentId).sort()).toEqual(['arch', 'leaf', 'other', 'overview']);

    // A legacy folder delete in a page tree is the same move to Trash.
    harness.session.removeFolder('other');
    expect(harness.commands).toContainEqual(expect.objectContaining({ type: 'trash-document', documentId: 'other' }));
  });

  it('restores a page whose parent is gone to the section root, and says so', async () => {
    const at = (documentId: string, parentFolderId: string | null, trashedAt: number | null = null) =>
      ({ ...document(documentId, documentId), parentFolderId, trashedAt });
    const harness = createHarness(SCOPE);
    (harness.dataSource.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      // `notes` sat under a page that is now gone for good; `draft` under one still in Trash.
      items: [at('notes', 'purged', 7), at('notes-child', 'notes', 7), at('parent', null, 3), at('draft', 'parent', 9), at('live', null)],
      containers: [],
      pageTree: true,
    });
    await harness.session.start();

    await expect(harness.session.restoreDocument('notes')).resolves.toEqual({ ok: true, restored: 2, movedToRoot: true });
    await expect(harness.session.restoreDocument('draft')).resolves.toEqual({ ok: true, restored: 1, movedToRoot: true });
    // The restore lands before the move, so the store never moves a page still in Trash.
    expect(harness.commands.filter((command) => command.type === 'restore-document' || command.type === 'move-document')
      .map((command) => `${command.type}:${command.documentId}`))
      .toEqual(['restore-document:notes', 'restore-document:notes-child', 'move-document:notes', 'restore-document:draft', 'move-document:draft']);
    expect(harness.commands).toContainEqual(expect.objectContaining({ type: 'move-document', documentId: 'notes', parentFolderId: null }));
    const restored = harness.session.getDocuments();
    expect(restored.find((doc) => doc.documentId === 'notes')?.parentFolderId ?? null).toBeNull();
    expect(restored.find((doc) => doc.documentId === 'notes-child')?.parentFolderId).toBe('notes');

    // A parent that is back in the tree keeps its child.
    await expect(harness.session.restoreDocument('parent')).resolves.toEqual({ ok: true, restored: 1, movedToRoot: false });
  });

  it('answers a page tree write with the store outcome, not the optimistic state', async () => {
    const harness = createHarness(SCOPE, { documents: [document('arch', 'Architecture'), document('leaf', 'Leaf')] });
    (harness.dataSource.command as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Personal pages refused the write'));
    const refused = { ok: false, error: 'Personal pages refused the write' };
    await expect(harness.session.movePage('leaf', 'arch')).resolves.toEqual(refused);
    await expect(harness.session.updateDocumentTitle('leaf', 'Renamed')).resolves.toEqual(refused);
    await expect(harness.session.placeType('module', 'arch')).resolves.toEqual(refused);
    await expect(harness.session.removeDocument('leaf')).resolves.toEqual(refused);
    await expect(harness.session.removePage('arch')).resolves.toEqual(refused);
    expect(harness.reportError).toHaveBeenCalledTimes(5);
  });

  it('purges only from Trash: a permanent delete and Empty Trash send purge, nothing else does', async () => {
    const trashed = (documentId: string) => ({ ...document(documentId, documentId), trashedAt: 5 });
    const harness = createHarness(SCOPE, { documents: [document('live', 'Live'), trashed('old-1'), trashed('old-2'), trashed('old-3')] });
    await harness.session.start();
    const removals = () => harness.commands.filter((command) => command.type === 'remove-document');

    await harness.session.removeDocument('old-1', { purge: true });
    expect(harness.session.emptyTrash()).toBe(2);
    expect(removals()).toEqual([
      { type: 'remove-document', documentId: 'old-1', purge: true },
      { type: 'remove-document', documentId: 'old-2', purge: true },
      { type: 'remove-document', documentId: 'old-3', purge: true },
    ]);
    await harness.session.removeDocument('live');
    expect(removals().at(-1)).toEqual({ type: 'remove-document', documentId: 'live' });
  });

  it('puts a refused move back where it was and a refused removal back in the tree', async () => {
    const harness = createHarness(SCOPE, { documents: [document('arch', 'Architecture'), { ...document('leaf', 'Leaf'), parentFolderId: 'arch', sortOrder: 4 }] });
    await harness.session.start();
    (harness.dataSource.command as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('read-only'));
    const leaf = () => harness.session.getDocuments().find((doc) => doc.documentId === 'leaf');

    await harness.session.moveDocument('leaf', null, { sortOrder: 9 });
    expect(leaf()).toMatchObject({ parentFolderId: 'arch', sortOrder: 4 });

    await harness.session.removeDocument('leaf');
    expect(leaf()).toMatchObject({ parentFolderId: 'arch' });
  });

  it('rolls back a refused rename without replacing a newer remote title', async () => {
    const harness = createHarness(SCOPE, { documents: [document('page', 'Before')] });
    await harness.session.start();
    const command = harness.dataSource.command as ReturnType<typeof vi.fn>;
    command.mockRejectedValueOnce(new Error('rename unconfirmed'));
    expect(await harness.session.updateDocumentTitle('page', 'After')).toMatchObject({ ok: false });
    expect(harness.session.getDocuments()[0].title).toBe('Before');

    let reject!: (error: Error) => void;
    command.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const pending = harness.session.updateDocumentTitle('page', 'After');
    harness.emitData({ type: 'items-upserted', items: [document('page', 'Teammate title')] });
    reject(new Error('rename unconfirmed'));
    await pending;
    expect(harness.session.getDocuments()[0].title).toBe('Teammate title');
  });

  it('does not let the echo of an earlier move revert a later one still in flight', async () => {
    const at = (parentFolderId: string | null, sortOrder: number | null) => ({ ...document('leaf', 'Leaf'), parentFolderId, sortOrder, updatedAt: 30 });
    const harness = createHarness(SCOPE, { documents: [document('a', 'A'), document('b', 'B'), document('c', 'C'), document('leaf', 'Leaf')] });
    await harness.session.start();
    const answers: Array<() => void> = [];
    (harness.dataSource.command as ReturnType<typeof vi.fn>).mockImplementation(() =>
      new Promise((resolve) => answers.push(() => resolve({ ok: true }))));
    const leaf = () => harness.session.getDocuments().find((doc) => doc.documentId === 'leaf');

    const first = harness.session.moveDocument('leaf', 'a', { sortOrder: 1 });
    const second = harness.session.moveDocument('leaf', 'b', { sortOrder: 2 });
    // The first move's broadcast lands after the second optimistic write.
    harness.emitData({ type: 'items-upserted', items: [{ ...at('a', 1), title: 'Leaf renamed' }] });
    expect(leaf()).toMatchObject({ parentFolderId: 'b', sortOrder: 2, title: 'Leaf renamed' });
    answers[0]();
    await first;
    harness.emitData({ type: 'items-upserted', items: [at('a', 1)] });
    expect(leaf()).toMatchObject({ parentFolderId: 'b', sortOrder: 2 });
    answers[1]();
    await second;
    harness.emitData({ type: 'items-upserted', items: [at('b', 2)] });
    expect(leaf()).toMatchObject({ parentFolderId: 'b', sortOrder: 2 });

    // With nothing in flight, a teammate's move applies.
    harness.emitData({ type: 'items-upserted', items: [at('c', 7)] });
    expect(leaf()).toMatchObject({ parentFolderId: 'c', sortOrder: 7 });
  });

  it('carries typed-page parents and sibling order through page writes', async () => {
    const ordered = (documentId: string, sortOrder: number | null) => ({ ...document(documentId, documentId), sortOrder });
    const harness = createHarness(SCOPE);
    (harness.dataSource.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [ordered('arch', 1024), ordered('zeta', 2048)],
      containers: [],
      itemPlacements: [{ itemId: 'i1', projectId: 'p1', parentId: 'arch', sortOrder: 1, createdBy: 'm', createdAt: 1, updatedAt: 1 }],
      pageTree: true,
    });
    await harness.session.start();

    // A new page goes at the end of a reordered group; under a typed page it names the item as its parent.
    await harness.session.registerDocument({ documentId: 'new', title: 'New', documentType: 'markdown', parentFolderId: null });
    expect(harness.commands).toContainEqual(expect.objectContaining({ type: 'register-document', documentId: 'new', sortOrder: 3072 }));
    await harness.session.registerDocument({ documentId: 'child', title: 'Child', documentType: 'markdown', parentFolderId: 'i1', parentKind: 'item' });
    const register = harness.commands.find((command) => command.type === 'register-document' && command.documentId === 'child');
    expect(register).toMatchObject({ parentFolderId: 'i1', parentKind: 'item' });
    expect(register).not.toHaveProperty('sortOrder');
    expect(harness.session.getDocuments().find((doc) => doc.documentId === 'child')).toMatchObject({ parentKind: 'item' });

    harness.session.moveDocument('zeta', 'i1', { parentKind: 'item', sortOrder: 5 });
    expect(harness.commands).toContainEqual({ type: 'move-document', documentId: 'zeta', parentFolderId: 'i1', parentKind: 'item', sortOrder: 5, confirm: true });
    // arch -> i1 -> child would close a loop through the typed page.
    expect(harness.session.movePage('arch', 'child')).toBe(false);

    // Trashing arch keeps the typed page's placement for a restore; its child stays with it.
    harness.session.removePage('arch');
    expect(harness.session.getItemPlacements().map((placement) => placement.parentId)).toEqual(['arch']);
    expect(harness.session.getDocuments().map((doc) => doc.documentId)).toEqual(expect.arrayContaining(['child', 'zeta']));
  });

  it('keeps a type page\'s prose with its type when the type moves or a page subtree is removed', async () => {
    const at = (documentId: string, parentFolderId: string | null) => ({ ...document(documentId, documentId), parentFolderId });
    const typeAt = (typeId: string, parentFolderId: string | null): SharedTypePlacement => ({
      typeId, projectId: 'p1', parentFolderId, sortOrder: 0, createdBy: 'm', createdAt: 1, updatedAt: 1,
    });
    const harness = createHarness(SCOPE);
    (harness.dataSource.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        at('p', null), at('q', null), at('p-child', 'p'),
        at('type-page:module', 'p'), at('type-page:person', 'p-child'), at('type-page:stale', 'p'),
      ],
      containers: [],
      typePlacements: [typeAt('module', 'p'), typeAt('person', 'p-child'), typeAt('stale', 'q')],
      pageTree: true,
    });
    await harness.session.start();

    // Moving a type moves its prose document with it.
    await harness.session.moveTypePlacement('module', 'q');
    expect(harness.commands).toContainEqual({ type: 'move-document', documentId: 'type-page:module', parentFolderId: 'q', confirm: true });

    // Removing P: the prose of a type placed outside P (module, now under Q;
    // stale, placed under Q by an older client) is moved out first; the prose of
    // a type placed inside goes with the subtree and is counted.
    expect(harness.session.pageRemovalCount('p')).toBe(2);
    harness.session.removePage('p');
    expect(harness.commands).toContainEqual({ type: 'move-document', documentId: 'type-page:stale', parentFolderId: 'q', confirm: true });
    const remaining = harness.session.getDocuments().map((doc) => [doc.documentId, doc.parentFolderId ?? null]);
    expect(remaining).toEqual(expect.arrayContaining([['q', null], ['type-page:module', 'q'], ['type-page:stale', 'q']]));
    expect(remaining.map(([id]) => id)).not.toContain('type-page:person');
    const moveIndex = harness.commands.findIndex((c) => c.type === 'move-document' && c.documentId === 'type-page:stale');
    const trashIndex = harness.commands.findIndex((c) => c.type === 'trash-document' && c.documentId === 'p');
    expect(moveIndex).toBeLessThan(trashIndex);
  });

  it('reports the real outcome of an item placement and rolls back a refused one', async () => {
    const harness = createHarness(SCOPE);
    (harness.dataSource.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [{ ...document('p'), parentFolderId: null }],
      containers: [],
      itemPlacements: [{ itemId: 'i1', projectId: 'p1', parentId: null, sortOrder: 1, createdBy: 'm', createdAt: 1, updatedAt: 1 }],
      pageTree: true,
    });
    await harness.session.start();

    await expect(harness.session.setItemPlacement('i1', 'p')).resolves.toEqual({ ok: true });
    expect(harness.session.getItemPlacements()[0].parentId).toBe('p');

    const command = harness.dataSource.command as ReturnType<typeof vi.fn>;
    command.mockRejectedValueOnce(new Error('timed out waiting for the server'));
    await expect(harness.session.setItemPlacement('i1', null)).resolves.toEqual({ ok: false, error: 'timed out waiting for the server' });
    expect(harness.session.getItemPlacements()[0].parentId).toBe('p');

    command.mockRejectedValueOnce(new Error('refused'));
    await expect(harness.session.removeItemPlacement('i1')).resolves.toEqual({ ok: false, error: 'refused' });
    expect(harness.session.getItemPlacements().map((placement) => placement.itemId)).toEqual(['i1']);
    await expect(harness.session.removeItemPlacement('i1')).resolves.toEqual({ ok: true });
    expect(harness.session.getItemPlacements()).toEqual([]);
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

  it('recovers from a non-retryable resolution failure when the host invalidates', async () => {
    const harness = createHarness(LIFECYCLE_SCOPE);
    const scopeListener: { current?: (scope: CollabScope | null) => void } = {};
    // "Not authenticated" and "No team found" are non-retryable on purpose, so
    // a window opened before sign-in stops resolving entirely. Signing in has
    // to push it back through resolution via the scope-changed contract.
    const resolveScope = vi.fn()
      .mockRejectedValueOnce(
        new CollabScopeResolutionError('Not authenticated. Sign in first.', { retryable: false }),
      )
      .mockImplementation(async () => LIFECYCLE_SCOPE);
    const host = {
      ...harness.host,
      resolveScope,
      onScopeChanged: (listener: (scope: CollabScope | null) => void) => {
        scopeListener.current = listener;
        return () => { scopeListener.current = undefined; };
      },
    } as unknown as CollabHost;
    const changes: Array<string | null> = [];
    const onError = vi.fn();
    const lifecycle = createCollabDocsScopeLifecycle(host as never, {
      retryDelaysMs: [0],
      onSessionChanged: (session) => changes.push(session?.scope.scopeKey ?? null),
      onError,
    });

    lifecycle.start();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(resolveScope).toHaveBeenCalledTimes(1);
    expect(changes).not.toContain(LIFECYCLE_SCOPE.scopeKey);

    scopeListener.current?.(null);

    await vi.waitFor(() => expect(changes.at(-1)).toBe(LIFECYCLE_SCOPE.scopeKey));
    expect(store.get(workspaceHasTeamAtom)).toBe(true);

    lifecycle.dispose();
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

describe('CollabDocsSession project split', () => {
  const inProject = (documentId: string, projectId: string | null, extra: Partial<SharedDocument> = {}): SharedDocument =>
    ({ ...document(documentId, `${documentId} title`), teamProjectId: projectId, ...extra });
  const ids = (documents: SharedDocument[]) => documents.map((entry) => entry.documentId).sort();
  const ORG_DOCUMENTS = [
    inProject('a-page', 'project-a'),
    inProject('b-page', 'project-b'),
    inProject('legacy-page', null),
    inProject('b-trashed', 'project-b', { trashedAt: 50 }),
    inProject('a-trashed', 'project-a', { trashedAt: 40 }),
  ];

  it('keeps only the current project in every window list, and a null project means the primary', async () => {
    const harness = createHarness(PRIMARY_PROJECT_SCOPE, { documents: ORG_DOCUMENTS, primaryProjectId: 'project-a' });
    await harness.session.start();
    store.set(activeCollabScopeAtom, PRIMARY_PROJECT_SCOPE);

    expect(ids(harness.session.getDocuments())).toEqual(['a-page', 'legacy-page']);
    expect(ids(store.get(sharedDocumentsAtom))).toEqual(['a-page', 'legacy-page']);
    expect(ids(store.get(trashedSharedDocumentsAtom))).toEqual(['a-trashed']);
    expect(ids(getSharedDocumentsForScopeKey(PRIMARY_PROJECT_SCOPE.scopeKey))).toEqual(['a-page', 'legacy-page']);
  });

  it("still resolves a link to another project's page", async () => {
    const harness = createHarness(PRIMARY_PROJECT_SCOPE, { documents: ORG_DOCUMENTS, primaryProjectId: 'project-a' });
    await harness.session.start();

    const linkable = store.get(sharedDocumentsForScopeAtom(PRIMARY_PROJECT_SCOPE.scopeKey));
    expect(linkable.find((entry) => entry.documentId === 'b-page')?.title).toBe('b-page title');
    expect(ids(linkable)).toEqual(['a-page', 'b-page', 'legacy-page']);
  });

  it('puts the primary project\'s null-project rows outside a secondary project', async () => {
    const harness = createHarness(SECONDARY_PROJECT_SCOPE, { documents: ORG_DOCUMENTS, primaryProjectId: 'project-a' });
    await harness.session.start();

    expect(ids(harness.session.getDocuments())).toEqual(['b-page']);
  });

  it('takes the primary from the snapshot when the scope has no project of its own', async () => {
    const harness = createHarness(UNKNOWN_PROJECT_SCOPE, { documents: ORG_DOCUMENTS, primaryProjectId: 'project-a' });
    await harness.session.start();

    expect(ids(harness.session.getDocuments())).toEqual(['a-page', 'legacy-page']);
  });

  it('routes live upserts and removals to the right list', async () => {
    const harness = createHarness(PRIMARY_PROJECT_SCOPE, { documents: [], primaryProjectId: 'project-a' });
    await harness.session.start();

    harness.emitData({ type: 'items-upserted', items: [inProject('b-live', 'project-b'), inProject('a-live', 'project-a')] });
    expect(ids(harness.session.getDocuments())).toEqual(['a-live']);
    expect(ids(store.get(sharedDocumentsForScopeAtom(PRIMARY_PROJECT_SCOPE.scopeKey)))).toEqual(['a-live', 'b-live']);

    harness.emitData({ type: 'items-removed', itemIds: ['b-live'] });
    expect(ids(store.get(sharedDocumentsForScopeAtom(PRIMARY_PROJECT_SCOPE.scopeKey)))).toEqual(['a-live']);
  });

  it('re-splits the rows it already holds as soon as the primary becomes known', async () => {
    const harness = createHarness(UNKNOWN_PROJECT_SCOPE, { documents: ORG_DOCUMENTS });
    await harness.session.start();
    // No project known yet: nothing is held out of the window.
    expect(ids(harness.session.getDocuments())).toEqual(['a-page', 'b-page', 'legacy-page']);

    // A snapshot that names the primary but carries no rows (team state before the index).
    harness.emitData({ type: 'snapshot', snapshot: { items: [], containers: [], primaryProjectId: 'project-a' } });
    expect(ids(harness.session.getDocuments())).toEqual(['a-page', 'legacy-page']);
    expect(findOtherProjectDocument(UNKNOWN_PROJECT_SCOPE.scopeKey, 'b-page')).toMatchObject({ projectId: 'project-b' });
  });

  it("refuses writes to another project's page, or under it, before they reach the data source", async () => {
    const harness = createHarness(PRIMARY_PROJECT_SCOPE, { documents: ORG_DOCUMENTS, primaryProjectId: 'project-a' });
    await harness.session.start();
    const refused = { ok: false, error: expect.stringContaining('another project') };

    expect(await harness.session.updateDocumentTitle('b-page', 'Renamed')).toEqual(refused);
    expect(await harness.session.removeDocument('b-page')).toEqual(refused);
    expect(await harness.session.trashDocument('b-page')).toEqual(refused);
    expect(await harness.session.moveDocument('b-page', null)).toEqual(refused);
    expect(await harness.session.moveDocument('a-page', 'b-page')).toEqual(refused);
    expect(await harness.session.removePage('b-page')).toEqual(refused);
    expect(await harness.session.placeType('module', 'b-page')).toEqual(refused);
    expect(await harness.session.setItemPlacement('item-1', 'b-page')).toEqual(refused);
    harness.session.restoreDocument('b-trashed');
    await expect(harness.session.registerDocument({ documentId: 'b-page', title: 'Clash', documentType: 'markdown', parentFolderId: null }))
      .rejects.toThrow(/another project/);
    await expect(harness.session.registerDocument({ documentId: 'new-page', title: 'Child', documentType: 'markdown', parentFolderId: 'b-page' }))
      .rejects.toThrow(/another project/);

    expect(harness.commands).toEqual([]);
    expect(ids(harness.session.getDocuments())).toEqual(['a-page', 'legacy-page']);
    expect(store.get(sharedDocumentsForScopeAtom(PRIMARY_PROJECT_SCOPE.scopeKey)).find((entry) => entry.documentId === 'b-page')?.title)
      .toBe('b-page title');
  });
});
