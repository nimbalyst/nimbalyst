// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type {
  CollabDocsSession,
  CollabTypeTreeResolver,
  SharedDocument,
  SharedItemPlacement,
  SharedTypePlacement,
} from '@nimbalyst/collab-client/docs';
import {
  createPageTool,
  deletePageTool,
  listPagesTool,
  movePageTreeNodeTool,
  renamePageTool,
  searchPagesTool,
  setPageFieldsTool,
  setPageTypeTool,
  type PageTreeSection,
  type PageTreeToolEnv,
} from '@nimbalyst/collab-client/docs/pageTreeToolCore';
import type { PageSearchHit } from '@nimbalyst/collab-protocol';
import { registerPageTreeToolHandlers } from '../pageTreeToolHandlers';
import { importFileToPagesTool } from '../importFileToPagesTool';

vi.mock('../../shareToTeamFlow', () => ({
  resolveShareDescriptor: (name: string) => (name.endsWith('.excalidraw')
    ? { ok: true, descriptor: { documentType: 'excalidraw', fileExtensions: ['.excalidraw'], defaultExtension: '.excalidraw' } }
    : name.endsWith('.ts')
      ? { ok: true, descriptor: { documentType: 'code', fileExtensions: ['.ts'], defaultExtension: '.ts' } }
    : name.endsWith('.md')
      ? { ok: true, descriptor: { documentType: 'markdown', fileExtensions: ['.md'], defaultExtension: '.md' } }
      : { ok: false, reason: 'No collaborative document type is registered for this file.' }),
  shareFileToTeam: vi.fn(),
}));
vi.mock('../../../components/ShareToTeamDialog/ShareToTeamDialog', () => ({
  splitShareFileName: (fileName: string) => {
    const dot = fileName.indexOf('.');
    return { baseName: fileName.slice(0, dot), suffix: fileName.slice(dot) };
  },
}));

const page = (documentId: string, title: string, parent: string | null = null, extra: Partial<SharedDocument> = {}): SharedDocument => ({
  documentId, title, teamProjectId: 'p1', documentType: 'markdown', createdBy: 'u', createdAt: 1, updatedAt: 1,
  parentFolderId: parent, ...extra,
});

/** Records every write; answers each with the store's outcome, a refusal when `refuse` is set. */
class FakeSession {
  calls: Array<[string, ...unknown[]]> = [];
  typePlacementList: SharedTypePlacement[];
  refuse: string | null = null;
  constructor(public documents: SharedDocument[], typePlacements: SharedTypePlacement[] = [], public itemPlacements: SharedItemPlacement[] = []) {
    this.typePlacementList = typePlacements;
  }
  private outcome = async () => (this.refuse ? { ok: false as const, error: this.refuse } : { ok: true as const });
  scope = { scopeKey: 'team', orgId: 'org1', indexConfig: { teamProjectId: 'proj1' } };
  start = async () => {};
  isPageTree = () => true;
  getDocuments = () => this.documents;
  getItemPlacements = () => this.itemPlacements;
  movePage = (id: string, parentId: string | null, options?: unknown) => {
    this.calls.push(['movePage', id, parentId, options]);
    return this.outcome();
  };
  moveDocument = (...args: unknown[]) => { this.calls.push(['moveDocument', ...args]); return this.outcome(); };
  moveFolder = (...args: unknown[]) => { this.calls.push(['moveFolder', ...args]); };
  placeType = async (...args: unknown[]) => { this.calls.push(['placeType', ...args]); return this.outcome(); };
  moveTypePlacement = async (...args: unknown[]) => { this.calls.push(['moveTypePlacement', ...args]); return this.outcome(); };
  setItemPlacement = async (...args: unknown[]) => { this.calls.push(['setItemPlacement', ...args]); return this.outcome(); };
  removeItemPlacement = async (...args: unknown[]) => { this.calls.push(['removeItemPlacement', ...args]); return this.outcome(); };
  removeDocument = (...args: unknown[]) => { this.calls.push(['removeDocument', ...args]); return this.outcome(); };
  trashDocument = (...args: unknown[]) => { this.calls.push(['trashDocument', ...args]); return this.outcome(); };
  removePage = (...args: unknown[]) => { this.calls.push(['removePage', ...args]); return this.outcome(); };
  pageRemovalCount = () => 0;
  updateDocumentTitle = async (...args: unknown[]) => { this.calls.push(['updateDocumentTitle', ...args]); return this.outcome(); };
  updateDocumentFields = async (...args: unknown[]) => { this.calls.push(['updateDocumentFields', ...args]); return this.outcome(); };
  createFolder = async (name: string, parentId: string | null) => {
    this.calls.push(['createFolder', name, parentId]);
    this.documents.push(page(`new-${name}`, name, parentId));
    return `new-${name}`;
  };
  writes = () => this.calls.map(([name]) => name);
}

// Modules (placed at root): Sync engine (MOD-1) placed under Architecture, Tracker engine (MOD-2) under its type.
const resolver: CollabTypeTreeResolver = {
  typeName: (typeId) => ({ module: 'Modules', technology: 'Technologies', library: 'Libraries' } as Record<string, string>)[typeId] ?? null,
  typeExtends: (typeId) => (typeId === 'library' ? 'technology' : null),
  itemsOfType: (typeId) => (typeId === 'module'
    ? [{ itemId: 'mod_1', title: 'Sync engine' }, { itemId: 'mod_2', title: 'Tracker engine' }]
    : []),
  item: (itemId) => (itemId === 'mod_1' ? { itemId, title: 'Sync engine', typeId: 'module' }
    : itemId === 'mod_2' ? { itemId, title: 'Tracker engine', typeId: 'module' } : null),
  listedTypes: () => [{ typeId: 'module', name: 'Modules' }, { typeId: 'technology', name: 'Technologies' }],
};

function tree() {
  return new FakeSession(
    [
      page('arch', 'Architecture'),
      page('overview', 'Overview', 'arch'),
      page('deep', 'Deep', 'overview'),
      page('notes', 'Notes', 'mod_1', { parentKind: 'item' }),
      page('more', 'More', 'mod_1', { parentKind: 'item' }),
    ],
    [{ typeId: 'module', projectId: 'p1', parentFolderId: null, sortOrder: 5e12, createdBy: 'u', createdAt: 1, updatedAt: 1 }],
    [{ itemId: 'mod_1', projectId: 'p1', parentId: 'arch', sortOrder: 6e12, createdBy: 'u', createdAt: 1, updatedAt: 1 }],
  );
}

function envFor(sessions: Partial<Record<PageTreeSection, FakeSession>>, overrides: Partial<PageTreeToolEnv> = {}): PageTreeToolEnv {
  return {
    session: async (section) => {
      const session = sessions[section];
      if (!session) throw new Error('No active collaboration scope is available.');
      return session as unknown as CollabDocsSession;
    },
    resolver: () => resolver,
    typePlacements: (session) => (session as unknown as FakeSession).typePlacementList,
    findItem: (ref) => {
      const byKey: Record<string, string> = { 'MOD-1': 'mod_1', 'MOD-2': 'mod_2' };
      const itemId = byKey[ref] ?? ref;
      const item = resolver.item!(itemId);
      return item ? { itemId, typeId: item.typeId, issueKey: Object.keys(byKey).find((key) => byKey[key] === itemId) } : null;
    },
    createPage: vi.fn(async () => 'created'),
    setPageType: vi.fn(async () => ({ status: 'done' as const })),
    pageUri: (section, documentId) => (section === 'team' ? `collab://org:org1:doc:${documentId}` : `personal://${documentId}`),
    ...overrides,
  };
}

describe('page tree agent tools', () => {
  it('bounds large tree responses and pages without duplicates', async () => {
    const session = new FakeSession(Array.from({ length: 205 }, (_, i) => page(`p-${i}`, `Page ${i}`)));
    const env = envFor({ team: session });
    const first = await listPagesTool(env, {});
    expect(first.success).toBe(true);
    if (!first.success) return;
    expect(first.nodes).toHaveLength(100);
    expect(first.truncated).toBe(true);
    const second = await listPagesTool(env, { cursor: first.nextCursor });
    expect(second.success).toBe(true);
    if (!second.success) return;
    const a = first.nodes as Array<{ nodeId: string }>;
    const b = second.nodes as Array<{ nodeId: string }>;
    expect(b).toHaveLength(100);
    expect(b.every((node) => !a.some((before) => before.nodeId === node.nodeId))).toBe(true);
    session.documents.push(page('new', 'A new page'));
    expect(await listPagesTool(env, { cursor: second.nextCursor })).toMatchObject({ success: false, error: expect.stringMatching(/changed.*restart/i) });
  });

  it('inspects a subtree by depth and kind, with compact results and child counts', async () => {
    const env = envFor({ team: tree() });
    const result = await listPagesTool(env, { root: 'arch', maxDepth: 1, kinds: ['page'], projection: 'compact' });
    expect(result).toMatchObject({ success: true, truncated: false, nextCursor: null });
    if (!result.success) return;
    expect((result.nodes as Array<{ id: string }>).map((node) => node.id)).toEqual(['arch', 'overview']);
    expect(result.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'overview', childCount: 1, updatedAt: 1 })]));
    expect((result.nodes as Array<object>).every((node) => !('link' in node))).toBe(true);
    expect(await listPagesTool(env, { root: 'not-present' })).toMatchObject({ success: false });
    expect(await listPagesTool(env, { kinds: ['typo'] })).toMatchObject({ success: false });
  });

  it('lists pages, types and typed pages with their parents, order and uri', async () => {
    const result = await listPagesTool(envFor({ team: tree() }), { section: 'team' });
    expect(result.success).toBe(true);
    const nodes = (result as unknown as { nodes: Array<Record<string, unknown>> }).nodes;
    const byId = Object.fromEntries(nodes.map((node) => [node.nodeId, node]));
    expect(byId['document:overview']).toMatchObject({ kind: 'page', title: 'Overview', parentNodeId: 'document:arch', uri: 'collab://org:org1:doc:overview' });
    expect(byId['item:mod_1']).toMatchObject({ kind: 'typedPage', issueKey: 'MOD-1', typeId: 'module', placed: true, parentNodeId: 'document:arch' });
    expect(byId['item:mod_2']).toMatchObject({ kind: 'typedPage', placed: false, parentNodeId: 'type:module' });
    expect(byId['document:notes']).toMatchObject({ parentNodeId: 'item:mod_1' });
    expect(byId['type:module']).toMatchObject({ kind: 'type', title: 'Modules', parentNodeId: null });
    // Console links an agent writes into page content, built from the section's own scope.
    const base = 'https://console.nimbalyst.com/org/org1/project/proj1';
    expect(byId['document:overview'].link).toBe(`${base}/document/overview`);
    expect(byId['item:mod_1'].link).toBe(`${base}/page/item/MOD-1`);
    expect(byId['type:module']).toMatchObject({ link: `${base}/page/type/module`, viewLink: `${base}/view/type/module` });
  });

  it('creates a page under a typed page named by issue key, as an item parent', async () => {
    const env = envFor({ team: tree() });
    const result = await createPageTool(env, { section: 'team', title: 'Design notes', parentFolderId: 'MOD-2', initialContent: '# Hi' });
    expect(result).toMatchObject({ success: true, documentId: 'created', link: 'https://console.nimbalyst.com/org/org1/project/proj1/document/created' });
    expect(env.createPage).toHaveBeenCalledWith('team', expect.anything(), expect.objectContaining({
      title: 'Design notes', parentId: 'mod_2', parentKind: 'item', content: '# Hi',
    }));
  });

  it('refuses to move a page under its own descendant, for kind doc and kind folder', async () => {
    for (const kind of ['doc', 'folder'] as const) {
      const session = tree();
      const result = await movePageTreeNodeTool(envFor({ team: session }), { section: 'team', kind, itemId: 'arch', newParentFolderId: 'deep' });
      expect(result).toMatchObject({ success: false });
      expect((result as { error: string }).error).toMatch(/inside itself/);
      expect(session.writes()).toEqual([]);
    }
  });

  it('keeps a page under its typed page when it is reordered among its siblings', async () => {
    const session = tree();
    const result = await movePageTreeNodeTool(envFor({ team: session }), { section: 'team', kind: 'doc', itemId: 'notes', after: 'document:more' });
    expect(result.success).toBe(true);
    const moves = session.calls.filter(([name]) => name === 'movePage');
    expect(moves.length).toBeGreaterThan(0);
    for (const [, , parentId, options] of moves) {
      expect(parentId).toBe('mod_1');
      expect(options).toMatchObject({ parentKind: 'item' });
    }
    expect(session.writes()).not.toContain('moveDocument');
  });

  it('places a typed page under a page, and sends it back under its type', async () => {
    const session = tree();
    const env = envFor({ team: session });
    expect(await movePageTreeNodeTool(env, { section: 'team', kind: 'item', itemId: 'MOD-2', newParentFolderId: 'overview' })).toMatchObject({ success: true });
    expect(session.calls).toContainEqual(['setItemPlacement', 'mod_2', 'overview', undefined, 'page']);
    expect(await movePageTreeNodeTool(env, { section: 'team', kind: 'item', itemId: 'MOD-1', underType: true })).toMatchObject({ success: true });
    expect(session.calls).toContainEqual(['removeItemPlacement', 'mod_1']);
    // A typed page cannot go under a page that sits below it.
    expect(await movePageTreeNodeTool(env, { section: 'team', kind: 'item', itemId: 'MOD-1', newParentFolderId: 'notes' })).toMatchObject({ success: false });
  });

  it('places an unplaced type, moves a placed one, and refuses a type of the other section', async () => {
    const session = tree();
    const env = envFor({ team: session });
    expect(await movePageTreeNodeTool(env, { section: 'team', kind: 'type', itemId: 'technology', newParentFolderId: 'arch' })).toMatchObject({ success: true });
    expect(session.calls).toContainEqual(['placeType', 'technology', 'arch', 'page']);
    expect(await movePageTreeNodeTool(env, { section: 'team', kind: 'type', itemId: 'module', before: 'document:arch' })).toMatchObject({ success: true });
    expect(session.writes()).toContain('moveTypePlacement');
    expect(await movePageTreeNodeTool(env, { section: 'team', kind: 'type', itemId: 'bug', newParentFolderId: 'arch' })).toMatchObject({ success: false });
  });

  it('sets a type on a plain page only, with a type of its own section', async () => {
    const env = envFor({ team: tree() });
    expect(await setPageTypeTool(env, { section: 'team', pageId: 'overview', typeId: 'module' })).toMatchObject({ success: true });
    expect(env.setPageType).toHaveBeenCalledWith('team', expect.anything(), expect.objectContaining({ documentId: 'overview' }), 'module');
    expect(await setPageTypeTool(env, { section: 'team', pageId: 'overview', typeId: 'bug' })).toMatchObject({ success: false });
    expect(await setPageTypeTool(env, { section: 'team', pageId: 'missing', typeId: 'module' })).toMatchObject({ success: false });
  });

  it('refuses to delete a page that has children unless its subtree goes too', async () => {
    const session = tree();
    const env = envFor({ team: session });
    expect(await deletePageTool(env, { section: 'team', itemId: 'arch', kind: 'doc' })).toMatchObject({ success: false });
    expect(session.writes()).toEqual([]);
    expect(await deletePageTool(env, { section: 'team', itemId: 'arch', kind: 'folder' })).toMatchObject({ success: true });
    expect(session.writes()).toEqual(['removePage']);
  });

  it('moves a deleted page to Trash and never removes it outright', async () => {
    const session = tree();
    expect(await deletePageTool(envFor({ team: session }), { section: 'team', itemId: 'deep', kind: 'doc' })).toMatchObject({ success: true });
    expect(session.calls).toEqual([['trashDocument', 'deep']]);
  });

  it('reports a write the store refused instead of success', async () => {
    const session = tree();
    session.refuse = 'Personal pages refused the write';
    const env = envFor({ team: session });
    const attempts: Array<Record<string, unknown>> = [
      { tool: 'move', kind: 'doc', itemId: 'overview', newParentFolderId: null },
      { tool: 'move', kind: 'doc', itemId: 'notes', after: 'document:more' },
      { tool: 'move', kind: 'type', itemId: 'module', newParentFolderId: 'arch' },
      { tool: 'move', kind: 'type', itemId: 'technology', newParentFolderId: 'arch' },
      { tool: 'rename', itemId: 'deep', newName: 'Deeper' },
      { tool: 'delete', itemId: 'deep', kind: 'doc' },
      { tool: 'delete', itemId: 'arch', kind: 'folder' },
    ];
    for (const { tool, ...args } of attempts) {
      const run = tool === 'move' ? movePageTreeNodeTool : tool === 'rename' ? renamePageTool : deletePageTool;
      const result = await run(env, { section: 'team', ...args });
      expect(result, JSON.stringify(args)).toMatchObject({ success: false, error: expect.stringContaining('Personal pages refused the write') });
    }
  });

  it('searches page text: names typed pages from the tree, adds typed-page title matches, drops typed pages the tree does not show', async () => {
    const session = tree();
    const hit = (documentId: string, kind: PageSearchHit['kind'], id: string, score: number, title: string | null = null): PageSearchHit => ({
      kind, id, documentId, title, issueKey: null, snippet: `${id} sync notes`, highlights: [], updatedAt: 7, score,
    });
    Object.assign(session, {
      searchPages: vi.fn(async () => ({
        status: 'ready',
        hits: [hit('overview', 'page', 'overview', 3, 'Overview'), hit('tracker-content/mod_2', 'typed', 'mod_2', 2), hit('tracker-content/gone', 'typed', 'gone', 9)],
      })),
    });
    const result = await searchPagesTool(envFor({ team: session }), { query: 'sync', limit: 10 });
    // Only the types the tree shows, so typed pages it would drop never use up the limit.
    expect((session as unknown as { searchPages: ReturnType<typeof vi.fn> }).searchPages).toHaveBeenCalledWith({ query: 'sync', limit: 10, typeIds: ['module'] });
    expect(result).toMatchObject({ success: true, section: 'team', query: 'sync', status: 'ready' });
    expect((result as unknown as { results: Array<Record<string, unknown>> }).results.map((r) => [r.kind, r.id, r.title, r.matchedIn, r.uri])).toEqual([
      // "Sync engine" matches by title only (no snippet); the archived/unknown typed page is dropped.
      ['typedPage', 'mod_1', 'Sync engine', 'title', 'collab://tracker-content/mod_1'],
      ['page', 'overview', 'Overview', 'body', 'collab://org:org1:doc:overview'],
      ['typedPage', 'mod_2', 'Tracker engine', 'body', 'collab://tracker-content/mod_2'],
    ]);
    expect(await searchPagesTool(envFor({ team: session }), { query: '  ' })).toMatchObject({ success: false });
    Object.assign(session, { searchPages: async () => null });
    expect(await searchPagesTool(envFor({ team: session }), { query: 'sync' })).toMatchObject({ success: false, error: expect.stringMatching(/unavailable/) });
  });

  it('sets a plain page\'s fields as a patch, reports what the page keeps, and lists them', async () => {
    const personal = new FakeSession([page('ideas', 'Ideas', null, { fields: { status: 'draft', owner: 'ana@example.com' } })]);
    const env = envFor({ personal });
    const set = await setPageFieldsTool(env, { section: 'personal', itemId: 'ideas', fields: { owner: null, status: 'shipped', tags: ['sync'] } });
    expect(personal.calls).toEqual([['updateDocumentFields', 'ideas', { owner: null, status: 'shipped', tags: ['sync'] }]]);
    // The invalid status is ignored, so the page keeps 'draft'.
    expect(set).toEqual({ success: true, fields: { status: 'draft', tags: ['sync'] } });

    const listed = await listPagesTool(env, { section: 'personal', projection: 'compact' }) as unknown as { nodes: Array<{ fields?: unknown }> };
    expect(listed.nodes[0].fields).toEqual({ status: 'draft', owner: 'ana@example.com' });
    expect(await setPageFieldsTool(env, { section: 'personal', itemId: 'type-page:module', fields: {} })).toMatchObject({ success: false });
    personal.refuse = 'Page fields are not available in this section yet.';
    expect(await setPageFieldsTool(env, { section: 'personal', itemId: 'ideas', fields: { status: 'current' } }))
      .toMatchObject({ success: false, error: expect.stringMatching(/not available/) });
  });

  it('works in the Personal section with no team, through the registered handler', async () => {
    const personal = new FakeSession([page('ideas', 'Ideas')]);
    const env = envFor({ personal });
    const listed = await listPagesTool(env, { section: 'personal' }) as unknown as { nodes: Array<{ link?: string }> };
    expect(listed.nodes[0].link).toBe('https://console.nimbalyst.com/app/page/ideas');
    const listeners = new Map<string, (payload: Record<string, unknown>) => void>();
    const send = vi.fn();
    const unsubscribe = registerPageTreeToolHandlers({
      on: (channel, listener) => { listeners.set(channel, listener); return () => listeners.delete(channel); },
      send,
    }, () => env);

    listeners.get('mcp:moveSharedItem')!({ section: 'personal', kind: 'doc', itemId: 'ideas', newParentFolderId: null, resultChannel: 'r1' });
    listeners.get('mcp:moveSharedItem')!({ kind: 'doc', itemId: 'ideas', resultChannel: 'r2' });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenCalledWith('r1', expect.objectContaining({ success: true }));
    expect(send).toHaveBeenCalledWith('r2', expect.objectContaining({ success: false, error: expect.stringMatching(/collaboration scope/) }));
    unsubscribe.forEach((fn) => fn());
    expect(listeners.size).toBe(0);
  });
});

describe('importFileToPages', () => {
  it('copies a drawing under a page by title through the share flow, and refuses what Pages cannot hold', async () => {
    const share = vi.fn(async () => ({ status: 'shared' as const, documentId: 'doc-arch', orgId: 'org1', title: 'architecture', warnings: [] }));
    const env = envFor({ team: tree() });
    const result = await importFileToPagesTool(env, { filePath: '/repo/docs/architecture.excalidraw', folderPath: 'Architecture' }, share);
    expect(result).toMatchObject({ success: true, documentId: 'doc-arch', uri: 'collab://org:org1:doc:doc-arch' });
    expect(share).toHaveBeenCalledWith(expect.objectContaining({
      filePath: '/repo/docs/architecture.excalidraw',
      openAfterCreate: false,
      showNotifications: false,
      answers: expect.objectContaining({ section: 'team', folderId: 'arch', sharedName: 'architecture.excalidraw' }),
    }));

    expect(await importFileToPagesTool(env, { filePath: '/repo/src/index.ts', section: 'personal' }, share))
      .toMatchObject({ success: false, error: expect.stringMatching(/cannot hold index\.ts/) });
    expect(await importFileToPagesTool(env, { filePath: 'docs/notes.md' }, share))
      .toMatchObject({ success: false, error: expect.stringMatching(/absolute path/) });
    expect(await importFileToPagesTool(env, { filePath: '/repo/model.stl' }, share)).toMatchObject({ success: false });
    expect(share).toHaveBeenCalledTimes(1);
  });
});
