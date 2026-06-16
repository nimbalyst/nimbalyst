import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockQuery,
  mockUpsertWorkspaceTrackerSchema,
  mockDeleteWorkspaceTrackerSchema,
  mockGetAllTrackerSchemas,
  mockIsBuiltinTrackerSchema,
  mockGlobalRegistry,
  mockApplyHeadlessBodyMarkdown,
  mockDocumentServices,
  mockDocService,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockUpsertWorkspaceTrackerSchema: vi.fn(),
  mockDeleteWorkspaceTrackerSchema: vi.fn(),
  mockGetAllTrackerSchemas: vi.fn((): any[] => []),
  mockIsBuiltinTrackerSchema: vi.fn(() => false),
  mockGlobalRegistry: {
    get: vi.fn(() => undefined),
    validate: vi.fn(() => ({ valid: true, errors: [] as Array<{ field: string; message: string }> })),
  },
  mockApplyHeadlessBodyMarkdown: vi.fn(async () => undefined),
  mockDocumentServices: new Map<string, any>(),
  mockDocService: {
    getTrackerItemById: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    listTrackerItems: vi.fn<(...args: any[]) => Promise<any[]>>(async () => []),
    ensureTrackerProjection: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    updateTrackerItemInFile: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    archiveTrackerItem: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    destroy: vi.fn(),
  },
}));

vi.mock('../../../database/initialize', () => ({
  getDatabase: () => ({
    query: mockQuery,
  }),
}));

vi.mock('../../../services/TrackerIdentityService', () => ({
  getCurrentIdentity: vi.fn(() => ({ displayName: 'Test User' })),
}));

vi.mock('../../../services/TrackerPolicyService', () => ({
  getEffectiveTrackerSyncPolicy: vi.fn(() => ({ mode: 'local', scope: 'project' })),
  getInitialTrackerSyncStatus: vi.fn(() => 'local'),
  shouldSyncTrackerPolicy: vi.fn(() => false),
}));

vi.mock('../../../services/TrackerSyncManager', () => ({
  isTrackerSyncActive: vi.fn(() => false),
  syncTrackerItem: vi.fn(),
}));

vi.mock('../../../services/TrackerSchemaService', () => {
  class MockTrackerTypeExistsError extends Error {
    readonly code = 'TRACKER_TYPE_EXISTS';
    constructor(readonly type: string, readonly filePath: string) {
      super(`Tracker type '${type}' already exists at ${filePath}.`);
      this.name = 'TrackerTypeExistsError';
    }
  }
  return {
    getTrackerRoleField: vi.fn(() => null),
    ensureWorkspaceTrackerSchemasLoaded: vi.fn(),
    upsertWorkspaceTrackerSchema: mockUpsertWorkspaceTrackerSchema,
    deleteWorkspaceTrackerSchema: mockDeleteWorkspaceTrackerSchema,
    getAllTrackerSchemas: mockGetAllTrackerSchemas,
    isBuiltinTrackerSchema: mockIsBuiltinTrackerSchema,
    TrackerTypeExistsError: MockTrackerTypeExistsError,
  };
});

vi.mock('../../../utils/store', () => ({
  getWorkspaceState: vi.fn(() => ({ issueKeyPrefix: 'NIM' })),
  isAnalyticsEnabled: vi.fn(() => true),
}));

vi.mock('../../../window/WindowManager', () => ({
  findWindowByWorkspace: vi.fn(() => null),
  documentServices: mockDocumentServices,
}));

vi.mock('@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel', () => ({
  globalRegistry: mockGlobalRegistry,
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
    isPackaged: false,
    getName: vi.fn(() => 'Nimbalyst'),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

// NIM-640 regression guard: `handleTrackerUpdate` must seed the live
// DocumentRoom Y.Doc when description changes, otherwise the body lands
// only in PGLite + cache and shared `fullDocument` trackers (incident,
// plan, decision) render blank for every peer.
vi.mock('../../../services/MainBodyDocService', () => ({
  applyHeadlessBodyMarkdown: mockApplyHeadlessBodyMarkdown,
}));

import {
  createBidirectionalLink,
  handleTrackerCreate,
  handleTrackerDefineType,
  handleTrackerDeleteType,
  handleTrackerGet,
  handleTrackerLinkSession,
  handleTrackerListTypes,
  handleTrackerUnlinkSession,
  handleTrackerUpdate,
  readLinkedTrackerItemIds,
  removeBidirectionalLink,
  rowToTrackerItem,
} from '../trackerToolHandlers';
import { isTrackerSyncActive } from '../../../services/TrackerSyncManager';
import { getEffectiveTrackerSyncPolicy, shouldSyncTrackerPolicy } from '../../../services/TrackerPolicyService';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bug_internal',
    issue_key: 'NIM-1',
    issue_number: 1,
    type: 'bug',
    type_tags: ['bug'],
    data: JSON.stringify({
      title: 'Scoped bug',
      status: 'to-do',
      priority: 'high',
    }),
    updated: '2026-04-02T00:00:00.000Z',
    ...overrides,
  };
}

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bug_target',
    issueNumber: 1,
    issueKey: 'NIM-1',
    type: 'bug',
    typeTags: ['bug'],
    title: 'Scoped bug',
    status: 'to-do',
    priority: 'high',
    workspace: '/tmp/ws',
    source: 'native',
    ...overrides,
  };
}

describe('rowToTrackerItem typeTags normalization', () => {
  it('parses the SQLite JSON-string shape into an array', () => {
    const item = rowToTrackerItem(makeRow({ type_tags: '["bug","task"]' }));
    expect(item.typeTags).toEqual(['bug', 'task']);
  });

  it('passes through the PGLite array shape unchanged', () => {
    const item = rowToTrackerItem(makeRow({ type_tags: ['bug', 'task'] }));
    expect(item.typeTags).toEqual(['bug', 'task']);
  });

  it('falls back to [type] when type_tags is missing or unparseable', () => {
    expect(rowToTrackerItem(makeRow({ type_tags: null })).typeTags).toEqual(['bug']);
    expect(rowToTrackerItem(makeRow({ type_tags: 'not json' })).typeTags).toEqual(['bug']);
  });

  it('surfaces data.origin as a top-level field (not buried in customFields)', () => {
    // Regression: origin landing in customFields made item.origin undefined, so
    // the TrackerRecord write-back dropped data.origin and the URN index went
    // empty -- imports could not resolve their own URN after the first sync.
    const origin = {
      kind: 'external',
      external: { providerId: 'github-issues', externalId: 'owner/repo#42', urn: 'github://owner/repo#42' },
    };
    const item = rowToTrackerItem(
      makeRow({ data: JSON.stringify({ title: 'Imported', status: 'to-do', origin }) })
    );
    expect(item.origin).toEqual(origin);
    expect(item.customFields?.origin).toBeUndefined();
  });
});

describe('handleTrackerGet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDocumentServices.clear();
  });

  it('reads items through the workspace document service', async () => {
    mockDocumentServices.set('/tmp/workspace-a', mockDocService);
    mockDocService.getTrackerItemById.mockResolvedValueOnce(
      makeItem({
        id: 'fm:plan:plans/example.md',
        issueKey: undefined,
        issueNumber: undefined,
        type: 'plan',
        typeTags: ['plan'],
        title: 'Example plan',
        workspace: '/tmp/workspace-a',
        source: 'frontmatter',
        sourceRef: 'plans/example.md',
        content: '# Body',
      }),
    );

    const result = await handleTrackerGet({ id: 'fm:plan:plans/example.md' }, '/tmp/workspace-a');

    expect(result.isError).toBe(false);
    expect(mockDocService.getTrackerItemById).toHaveBeenCalledWith('fm:plan:plans/example.md');
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('tracker schema tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDocumentServices.clear();
    mockGetAllTrackerSchemas.mockReturnValue([]);
    mockIsBuiltinTrackerSchema.mockReturnValue(false);
  });

  it('lists tracker types with builtin metadata', async () => {
    mockGetAllTrackerSchemas.mockReturnValue([
      {
        type: 'incident',
        displayName: 'Incident',
        displayNamePlural: 'Incidents',
        icon: 'warning',
        color: '#f97316',
        modes: { inline: true, fullDocument: false },
        idPrefix: 'INC',
        idFormat: 'ulid',
        fields: [{ name: 'severity', type: 'select' }],
      },
    ]);

    const result = await handleTrackerListTypes({});

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.count).toBe(1);
    expect(payload.structured.items[0].type).toBe('incident');
    expect(payload.structured.items[0].builtin).toBe(false);
  });

  it('defines a custom tracker type through the schema service', async () => {
    mockUpsertWorkspaceTrackerSchema.mockResolvedValue({
      model: {
        type: 'incident',
        displayName: 'Incident',
        displayNamePlural: 'Incidents',
        icon: 'warning',
        color: '#f97316',
        modes: { inline: true, fullDocument: false },
        idPrefix: 'INC',
        idFormat: 'ulid',
        fields: [{ name: 'severity', type: 'select' }],
      },
      filePath: '/tmp/ws/.nimbalyst/trackers/incident.yaml',
    });

    const result = await handleTrackerDefineType(
      {
        schema: {
          type: 'incident',
          displayName: 'Incident',
          displayNamePlural: 'Incidents',
          icon: 'warning',
          color: '#f97316',
          modes: { inline: true, fullDocument: false },
          idPrefix: 'INC',
          fields: [{ name: 'severity', type: 'select' }],
        },
      },
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    expect(mockUpsertWorkspaceTrackerSchema).toHaveBeenCalledWith(
      '/tmp/ws',
      expect.objectContaining({ type: 'incident' }),
      { fileName: undefined, overwrite: false },
    );
  });

  it('blocks deleting a tracker type that still has items', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: 2 }] });

    const result = await handleTrackerDeleteType({ type: 'incident' }, '/tmp/ws');

    expect(result.isError).toBe(true);
    expect(mockDeleteWorkspaceTrackerSchema).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('still reference this type');
  });
});

describe('handleTrackerCreate session linking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDocumentServices.clear();
    mockGlobalRegistry.validate.mockReturnValue({ valid: true, errors: [] });
  });

  // Drive every query handleTrackerCreate makes through one queue. The handler
  // doesn't care about return shapes for the writes; the reads need just enough
  // to keep it walking through the create flow.
  function setupCreateQueueWithoutLink() {
    const createdRow = makeRow({
      id: 'bug_test',
      workspace: '/tmp/ws',
      issue_key: null,
      issue_number: null,
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [] })                              // INSERT
      .mockResolvedValueOnce({ rows: [createdRow] })                    // resolve created
      .mockResolvedValueOnce({ rows: [{ max_num: 0 }] })                // MAX(issue_number)
      .mockResolvedValueOnce({ rows: [] })                              // UPDATE issue_key
      .mockResolvedValueOnce({ rows: [{ ...createdRow, issue_key: 'NIM-1', issue_number: 1 }] }) // re-resolve
      .mockResolvedValueOnce({ rows: [{ ...createdRow, issue_key: 'NIM-1', issue_number: 1 }] }); // notifyTrackerItemAdded
  }

  it('does NOT auto-link the current session when linkSession is omitted', async () => {
    setupCreateQueueWithoutLink();

    const result = await handleTrackerCreate(
      { type: 'bug', title: 'Some bug' },
      '/tmp/ws',
      'session_abc',
    );

    expect(result.isError).toBe(false);
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('UPDATE ai_sessions'))).toBe(false);
    expect(sqls.some((s) => s.includes('SELECT metadata FROM ai_sessions'))).toBe(false);
  });

  it('links the current session when linkSession: true', async () => {
    const createdRow = makeRow({
      id: 'bug_test',
      workspace: '/tmp/ws',
      issue_key: null,
      issue_number: null,
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [] })                              // INSERT
      .mockResolvedValueOnce({ rows: [createdRow] })                    // resolve created
      .mockResolvedValueOnce({ rows: [{ max_num: 0 }] })                // MAX(issue_number)
      .mockResolvedValueOnce({ rows: [] })                              // UPDATE issue_key
      .mockResolvedValueOnce({ rows: [{ ...createdRow, issue_key: 'NIM-1', issue_number: 1 }] }) // re-resolve
      // createBidirectionalLink:
      .mockResolvedValueOnce({ rows: [{ data: {} }] })                  // SELECT data FROM tracker_items
      .mockResolvedValueOnce({ rows: [] })                              // UPDATE tracker_items
      .mockResolvedValueOnce({ rows: [{ metadata: {} }] })              // SELECT metadata FROM ai_sessions
      .mockResolvedValueOnce({ rows: [] })                              // UPDATE ai_sessions
      // notifySessionLinkedTrackerChanged read:
      .mockResolvedValueOnce({ rows: [{ metadata: { linkedTrackerItemIds: ['bug_test'] } }] })
      // notifyTrackerItemAdded:
      .mockResolvedValueOnce({ rows: [{ ...createdRow, issue_key: 'NIM-1', issue_number: 1 }] });

    const result = await handleTrackerCreate(
      { type: 'bug', title: 'Some bug', linkSession: true },
      '/tmp/ws',
      'session_abc',
    );

    expect(result.isError).toBe(false);
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('UPDATE ai_sessions'))).toBe(true);
  });

  it('does NOT link when linkSession: true but no session is active', async () => {
    setupCreateQueueWithoutLink();

    const result = await handleTrackerCreate(
      { type: 'bug', title: 'Some bug', linkSession: true },
      '/tmp/ws',
      undefined,
    );

    expect(result.isError).toBe(false);
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('UPDATE ai_sessions'))).toBe(false);
  });

  it('persists a structured origin and derives source/source_ref for imports', async () => {
    setupCreateQueueWithoutLink();

    const origin = {
      kind: 'external' as const,
      external: {
        providerId: 'github-issues',
        externalId: 'owner/repo#42',
        urn: 'github://owner/repo#42',
        url: 'https://github.com/owner/repo/issues/42',
        titleSnapshot: 'Some bug',
        stateSnapshot: 'open',
        importedAt: '2026-06-07T00:00:00.000Z',
        lastSyncedAt: '2026-06-07T00:00:00.000Z',
      },
    };

    const result = await handleTrackerCreate(
      { type: 'bug', title: 'Some bug', origin, createdByAgent: false },
      '/tmp/ws',
      undefined,
    );

    expect(result.isError).toBe(false);
    const insertCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO tracker_items'),
    );
    expect(insertCall).toBeTruthy();
    const params = insertCall![1] as unknown[];
    // External imports are native DB items; provenance lives in data.origin, not
    // the legacy source column (which would otherwise be treated as file-backed).
    expect(params[7]).toBe('native');
    expect(params[8]).toBeNull();
    const data = JSON.parse(params[3] as string);
    expect(data.origin.kind).toBe('external');
    expect(data.origin.external.urn).toBe('github://owner/repo#42');
    expect(data.createdByAgent).toBe(false);
  });

  it('rejects tracker_create when the schema validation fails', async () => {
    mockGlobalRegistry.validate.mockReturnValue({
      valid: false,
      errors: [{ field: 'status', message: "Field 'status' has invalid option: invalid" }],
    });

    const result = await handleTrackerCreate(
      { type: 'bug', title: 'Some bug', status: 'invalid' },
      '/tmp/ws',
      undefined,
    );

    expect(result.isError).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.action).toBe('validationFailed');
    expect(payload.structured.tool).toBe('tracker_create');
  });
});

describe('handleTrackerLinkSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDocumentServices.clear();
  });

  it('links the explicit target sessionId, not the ambient session', async () => {
    const trackerRow = makeRow({ id: 'bug_target', workspace: '/tmp/ws' });
    mockQuery
      // resolveTrackerRowByReference (existing item lookup)
      .mockResolvedValueOnce({ rows: [trackerRow] })
      // explicit-session existence check
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      // createBidirectionalLink: SELECT data FROM tracker_items
      .mockResolvedValueOnce({ rows: [{ data: {} }] })
      // createBidirectionalLink: UPDATE tracker_items
      .mockResolvedValueOnce({ rows: [] })
      // createBidirectionalLink: SELECT metadata FROM ai_sessions
      .mockResolvedValueOnce({ rows: [{ metadata: {} }] })
      // createBidirectionalLink: UPDATE ai_sessions
      .mockResolvedValueOnce({ rows: [] })
      // post-link SELECT data FROM tracker_items (for linkedSessions count)
      .mockResolvedValueOnce({ rows: [{ data: { linkedSessions: ['session_explicit'] } }] })
      // notifyTrackerItemUpdated read
      .mockResolvedValueOnce({ rows: [trackerRow] })
      // notifySessionLinkedTrackerChanged read
      .mockResolvedValueOnce({ rows: [{ metadata: { linkedTrackerItemIds: ['bug_target'] } }] });

    const result = await handleTrackerLinkSession(
      { trackerId: 'NIM-1', sessionId: 'session_explicit' },
      'session_ambient',
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    const updateSessionCalls = mockQuery.mock.calls.filter(
      (c) => String(c[0]).includes('UPDATE ai_sessions'),
    );
    expect(updateSessionCalls).toHaveLength(1);
    expect(updateSessionCalls[0][1]).toContain('session_explicit');
    expect(updateSessionCalls[0][1]).not.toContain('session_ambient');

    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.sessionId).toBe('session_explicit');
  });

  it('falls back to the ambient session when sessionId is omitted', async () => {
    const trackerRow = makeRow({ id: 'bug_target', workspace: '/tmp/ws' });
    mockQuery
      .mockResolvedValueOnce({ rows: [trackerRow] })                              // resolveTrackerRowByReference
      .mockResolvedValueOnce({ rows: [{ data: {} }] })                            // SELECT data
      .mockResolvedValueOnce({ rows: [] })                                        // UPDATE tracker_items
      .mockResolvedValueOnce({ rows: [{ metadata: {} }] })                        // SELECT metadata
      .mockResolvedValueOnce({ rows: [] })                                        // UPDATE ai_sessions
      .mockResolvedValueOnce({ rows: [{ data: { linkedSessions: ['session_ambient'] } }] }) // post-link tracker read
      .mockResolvedValueOnce({ rows: [trackerRow] })                              // notifyTrackerItemUpdated
      .mockResolvedValueOnce({ rows: [{ metadata: { linkedTrackerItemIds: ['bug_target'] } }] });

    const result = await handleTrackerLinkSession(
      { trackerId: 'NIM-1' },
      'session_ambient',
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    const sessionExistsChecks = mockQuery.mock.calls.filter((c) =>
      String(c[0]).includes('SELECT 1 FROM ai_sessions'),
    );
    expect(sessionExistsChecks).toHaveLength(0);

    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.sessionId).toBe('session_ambient');
  });

  it('returns an error when an explicit sessionId does not exist', async () => {
    const trackerRow = makeRow({ id: 'bug_target', workspace: '/tmp/ws' });
    mockQuery
      // resolveTrackerRowByReference
      .mockResolvedValueOnce({ rows: [trackerRow] })
      // explicit session existence check returns no rows
      .mockResolvedValueOnce({ rows: [] });

    const result = await handleTrackerLinkSession(
      { trackerId: 'NIM-1', sessionId: 'session_missing' },
      undefined,
      '/tmp/ws',
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Session not found');
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('UPDATE ai_sessions'))).toBe(false);
    expect(sqls.some((s) => s.includes('UPDATE tracker_items'))).toBe(false);
  });

  it('links a frontmatter-backed plan using its canonical public id', async () => {
    const publicId = 'fm:plan:plans/example.md';
    const trackerRow = makeRow({
      id: 'plan_projection',
      issue_key: null,
      issue_number: null,
      type: 'plan',
      source: 'frontmatter',
      source_ref: 'plans/example.md',
      document_path: 'plans/example.md',
      workspace: '/tmp/ws',
      data: JSON.stringify({ title: 'Example plan', status: 'to-do', priority: 'high' }),
    });
    mockDocumentServices.set('/tmp/ws', mockDocService);
    mockDocService.getTrackerItemById.mockResolvedValueOnce(
      makeItem({
        id: publicId,
        issueKey: undefined,
        issueNumber: undefined,
        type: 'plan',
        typeTags: ['plan'],
        title: 'Example plan',
        source: 'frontmatter',
        sourceRef: 'plans/example.md',
      }),
    );
    mockDocService.ensureTrackerProjection.mockResolvedValueOnce(
      makeItem({
        id: publicId,
        issueKey: undefined,
        issueNumber: undefined,
        type: 'plan',
        typeTags: ['plan'],
        title: 'Example plan',
        source: 'frontmatter',
        sourceRef: 'plans/example.md',
      }),
    );
    mockQuery
      .mockResolvedValueOnce({ rows: [trackerRow] }) // resolveTrackerRowByReference
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // explicit-session existence
      .mockResolvedValueOnce({ rows: [{ data: {} }] }) // createBidirectionalLink: SELECT tracker
      .mockResolvedValueOnce({ rows: [] }) // createBidirectionalLink: UPDATE tracker
      .mockResolvedValueOnce({ rows: [{ metadata: {} }] }) // createBidirectionalLink: SELECT session
      .mockResolvedValueOnce({ rows: [] }) // createBidirectionalLink: UPDATE session
      .mockResolvedValueOnce({ rows: [{ data: { linkedSessions: ['session_explicit'] } }] }) // linked count
      .mockResolvedValueOnce({ rows: [trackerRow] }) // notifyTrackerItemUpdated
      .mockResolvedValueOnce({ rows: [{ metadata: { linkedTrackerItemIds: [publicId] } }] }); // notifySessionLinkedTrackerChanged

    const result = await handleTrackerLinkSession(
      { trackerId: publicId, sessionId: 'session_explicit' },
      'session_ambient',
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    expect(mockDocService.ensureTrackerProjection).toHaveBeenCalledWith(publicId);
    const updateSessionCall = mockQuery.mock.calls.find((call) =>
      String(call[0]).includes('UPDATE ai_sessions'),
    );
    expect(updateSessionCall?.[1]?.[0]).toContain(publicId);
    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.trackerId).toBe(publicId);
  });
});

describe('handleTrackerUnlinkSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDocumentServices.clear();
  });

  it('unlinks the explicit target sessionId, not the ambient session', async () => {
    const trackerRow = makeRow({ id: 'bug_target', workspace: '/tmp/ws' });
    mockQuery
      .mockResolvedValueOnce({ rows: [trackerRow] }) // resolveTrackerRowByReference
      .mockResolvedValueOnce({ rows: [{ data: { linkedSessions: ['session_explicit', 'session_other'] } }] }) // SELECT data
      .mockResolvedValueOnce({ rows: [] }) // UPDATE tracker_items
      .mockResolvedValueOnce({ rows: [{ metadata: { linkedTrackerItemIds: ['bug_target', 'bug_other'] } }] }) // SELECT metadata
      .mockResolvedValueOnce({ rows: [] }) // UPDATE ai_sessions
      .mockResolvedValueOnce({ rows: [{ data: { linkedSessions: ['session_other'] } }] }) // post-unlink tracker read
      .mockResolvedValueOnce({ rows: [trackerRow] }) // notifyTrackerItemUpdated
      .mockResolvedValueOnce({ rows: [{ metadata: { linkedTrackerItemIds: ['bug_other'] } }] }); // notifySessionLinkedTrackerChanged read

    const result = await handleTrackerUnlinkSession(
      { trackerId: 'NIM-1', sessionId: 'session_explicit' },
      'session_ambient',
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    const updateSessionCalls = mockQuery.mock.calls.filter(
      (c) => String(c[0]).includes('UPDATE ai_sessions'),
    );
    expect(updateSessionCalls).toHaveLength(1);
    expect(updateSessionCalls[0][1]).toContain('session_explicit');
    expect(updateSessionCalls[0][1]).not.toContain('session_ambient');

    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.sessionId).toBe('session_explicit');
    expect(payload.structured.linkedCount).toBe(1);
    expect(payload.structured.removed).toBe(true);
  });

  it('falls back to the ambient session when sessionId is omitted', async () => {
    const trackerRow = makeRow({ id: 'bug_target', workspace: '/tmp/ws' });
    mockQuery
      .mockResolvedValueOnce({ rows: [trackerRow] }) // resolveTrackerRowByReference
      .mockResolvedValueOnce({ rows: [{ data: { linkedSessions: ['session_ambient'] } }] }) // SELECT data
      .mockResolvedValueOnce({ rows: [] }) // UPDATE tracker_items
      .mockResolvedValueOnce({ rows: [{ metadata: { linkedTrackerItemIds: ['bug_target'] } }] }) // SELECT metadata
      .mockResolvedValueOnce({ rows: [] }) // UPDATE ai_sessions
      .mockResolvedValueOnce({ rows: [{ data: {} }] }) // post-unlink tracker read
      .mockResolvedValueOnce({ rows: [trackerRow] }) // notifyTrackerItemUpdated
      .mockResolvedValueOnce({ rows: [{ metadata: {} }] }); // notifySessionLinkedTrackerChanged read

    const result = await handleTrackerUnlinkSession(
      { trackerId: 'NIM-1' },
      'session_ambient',
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    const sessionExistsChecks = mockQuery.mock.calls.filter((c) =>
      String(c[0]).includes('SELECT 1 FROM ai_sessions'),
    );
    expect(sessionExistsChecks).toHaveLength(0);

    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.sessionId).toBe('session_ambient');
    expect(payload.structured.linkedCount).toBe(0);
    expect(payload.structured.removed).toBe(true);
  });

  it('cleans the tracker side even when the explicit session no longer exists', async () => {
    const trackerRow = makeRow({ id: 'bug_target', workspace: '/tmp/ws' });
    mockQuery
      .mockResolvedValueOnce({ rows: [trackerRow] }) // resolveTrackerRowByReference
      .mockResolvedValueOnce({ rows: [{ data: { linkedSessions: ['session_missing'] } }] }) // SELECT data
      .mockResolvedValueOnce({ rows: [] }) // UPDATE tracker_items
      .mockResolvedValueOnce({ rows: [] }) // SELECT metadata (session missing)
      .mockResolvedValueOnce({ rows: [{ data: {} }] }) // post-unlink tracker read
      .mockResolvedValueOnce({ rows: [trackerRow] }) // notifyTrackerItemUpdated
      .mockResolvedValueOnce({ rows: [] }); // post-unlink session read for notification

    const result = await handleTrackerUnlinkSession(
      { trackerId: 'NIM-1', sessionId: 'session_missing' },
      undefined,
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('SELECT 1 FROM ai_sessions'))).toBe(false);
    expect(sqls.some((s) => s.includes('UPDATE ai_sessions'))).toBe(false);

    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.sessionId).toBe('session_missing');
    expect(payload.structured.linkedCount).toBe(0);
    expect(payload.structured.removed).toBe(true);
  });
});

describe('handleTrackerUpdate description / collab body', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDocumentServices.clear();
    mockGlobalRegistry.validate.mockReturnValue({ valid: true, errors: [] });
    // Default: non-collab (local) workspace -- description writes proceed.
    vi.mocked(getEffectiveTrackerSyncPolicy).mockReturnValue({ mode: 'local', scope: 'project' });
    vi.mocked(shouldSyncTrackerPolicy).mockReturnValue(false);
    vi.mocked(isTrackerSyncActive).mockReturnValue(false);
  });

  function setupUpdateQueueWithDescription(extraRowFields: Record<string, unknown> = {}) {
    const trackerRow = makeRow({
      id: 'bug_target',
      workspace: '/tmp/ws',
      source: 'native',
      document_path: '',
      ...extraRowFields,
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [trackerRow] })                          // resolveTrackerRowByReference (initial)
      .mockResolvedValueOnce({ rows: [] })                                    // UPDATE tracker_items SET data
      .mockResolvedValueOnce({ rows: [{ body_version: 1 }] })                 // UPDATE tracker_items SET content + body_version
      .mockResolvedValueOnce({ rows: [] })                                    // INSERT tracker_body_cache
      .mockResolvedValueOnce({ rows: [trackerRow] })                          // notifyTrackerItemUpdated read
      .mockResolvedValueOnce({ rows: [trackerRow] })                          // refreshedRow read for sync block
      .mockResolvedValueOnce({ rows: [trackerRow] })                          // postSyncRow read
      .mockResolvedValueOnce({ rows: [{ type_tags: ['bug'] }] });             // re-read type_tags
    return trackerRow;
  }

  it('rejects tracker_update when the schema validation fails', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeRow({ id: 'bug_target', workspace: '/tmp/ws' })],
    });
    mockGlobalRegistry.validate.mockReturnValue({
      valid: false,
      errors: [{ field: 'priority', message: "Field 'priority' has invalid option: urgent" }],
    });

    const result = await handleTrackerUpdate(
      { id: 'NIM-1', priority: 'urgent' },
      '/tmp/ws',
    );

    expect(result.isError).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.action).toBe('validationFailed');
    expect(payload.structured.tool).toBe('tracker_update');
  });

  it('writes description to PGLite for local-only items', async () => {
    setupUpdateQueueWithDescription();

    const result = await handleTrackerUpdate(
      { id: 'NIM-1', description: 'New body text' },
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    const updateContentCalls = mockQuery.mock.calls.filter(
      (c) => /UPDATE tracker_items[\s\S]+SET content/.test(String(c[0])),
    );
    expect(updateContentCalls).toHaveLength(1);

    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.skippedFields).toBeUndefined();
    expect(payload.structured.changes.description).toEqual({ from: undefined, to: 'New body text' });
  });

  it('bumps body_version and writes a tracker_body_cache row on description write', async () => {
    setupUpdateQueueWithDescription();

    const result = await handleTrackerUpdate(
      { id: 'NIM-1', description: 'phase 5 body bump' },
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);

    const updateContentSql = mockQuery.mock.calls.find(
      (c) => /UPDATE tracker_items[\s\S]+SET content[\s\S]+body_version/.test(String(c[0])),
    );
    expect(updateContentSql).toBeDefined();
    expect(String(updateContentSql![0])).toMatch(/RETURNING body_version/);

    const cacheInsert = mockQuery.mock.calls.find(
      (c) => /INSERT INTO tracker_body_cache/.test(String(c[0])),
    );
    expect(cacheInsert).toBeDefined();
    expect(cacheInsert![1]).toEqual([
      'bug_target',
      1,
      JSON.stringify('phase 5 body bump'),
    ]);
  });

  // The "refuse description writes when body is collaborative" tests (NIM-436)
  // were removed as part of phase 1 of the tracker-sync rewrite
  // (design/Collaboration/tracker-sync-redesign.md). With phase 5 the body
  // path bumps body_version + writes tracker_body_cache so cold peers learn
  // the body changed via the metadata layer; the live body Y.Doc in
  // DocumentRoom is still the source of truth for warm readers.

  // NIM-640: `tracker_update` was forgetting to seed the live DocumentRoom
  // Y.Doc the way `tracker_create` does, so shared `fullDocument` trackers
  // (incident, plan, decision) had their body land only in PGLite + cache.
  // Peers (including the editor panel) rendered blank until somebody opened
  // the editor and the renderer bootstrap pushed the local seed up. This
  // test pins the contract: when description is updated and a workspace is
  // attached, applyHeadlessBodyMarkdown is called with the matching
  // arguments.
  it('seeds the live Y.Doc via applyHeadlessBodyMarkdown when description changes (NIM-640)', async () => {
    setupUpdateQueueWithDescription();

    await handleTrackerUpdate(
      { id: 'NIM-1', description: 'NIM-640 description content' },
      '/tmp/ws',
    );

    expect(mockApplyHeadlessBodyMarkdown).toHaveBeenCalledTimes(1);
    expect(mockApplyHeadlessBodyMarkdown).toHaveBeenCalledWith(
      '/tmp/ws',
      'bug_target',
      'NIM-640 description content',
    );
  });

  it('routes frontmatter-backed plan status updates through updateTrackerItemInFile', async () => {
    const publicId = 'fm:plan:plans/example.md';
    const trackerRow = makeRow({
      id: 'plan_projection',
      issue_key: null,
      issue_number: null,
      type: 'plan',
      source: 'frontmatter',
      source_ref: 'plans/example.md',
      document_path: 'plans/example.md',
      workspace: '/tmp/ws',
      data: JSON.stringify({ title: 'Example plan', status: 'to-do', priority: 'high' }),
    });
    const planItem = makeItem({
      id: publicId,
      issueKey: undefined,
      issueNumber: undefined,
      type: 'plan',
      typeTags: ['plan'],
      title: 'Example plan',
      status: 'to-do',
      priority: 'high',
      source: 'frontmatter',
      sourceRef: 'plans/example.md',
      workspace: '/tmp/ws',
    });
    mockDocumentServices.set('/tmp/ws', mockDocService);
    mockDocService.getTrackerItemById
      .mockResolvedValueOnce(planItem)
      .mockResolvedValueOnce({ ...planItem, status: 'in-progress' });
    mockDocService.ensureTrackerProjection.mockResolvedValueOnce(planItem);
    mockDocService.updateTrackerItemInFile.mockResolvedValueOnce({ ...planItem, status: 'in-progress' });
    mockQuery
      .mockResolvedValueOnce({ rows: [trackerRow] }) // resolveTrackerRowByReference after ensureProjection
      .mockResolvedValueOnce({ rows: [trackerRow] }) // resolveTrackerRowByReference after file update
      .mockResolvedValueOnce({ rows: [] }) // UPDATE tracker_items SET data
      .mockResolvedValueOnce({ rows: [trackerRow] }) // notifyTrackerItemUpdated
      .mockResolvedValue({ rows: [trackerRow] });

    const result = await handleTrackerUpdate(
      { id: publicId, status: 'in-progress' },
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    expect(mockDocService.updateTrackerItemInFile).toHaveBeenCalledWith(publicId, {
      status: 'in-progress',
    });
    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.id).toBe(publicId);
    expect(payload.structured.type).toBe('plan');
  });
});

/**
 * NIM-829: whole-column reads of ai_sessions.metadata return a parsed object on
 * PGLite but a raw JSON string on SQLite (see packages/electron/DATABASE.md).
 * The link helpers read metadata.linkedTrackerItemIds without parsing, so on
 * SQLite they always saw [] — linking a second item erased the first, unlink
 * silently no-oped, and the linked-tracker broadcast told renderers the session
 * had zero links (TrackerPanel never rendered).
 */
describe('session metadata parsing on SQLite (NIM-829)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('readLinkedTrackerItemIds parses string metadata (SQLite) and object metadata (PGLite)', () => {
    expect(readLinkedTrackerItemIds('{"linkedTrackerItemIds":["a","b"]}')).toEqual(['a', 'b']);
    expect(readLinkedTrackerItemIds({ linkedTrackerItemIds: ['a'] })).toEqual(['a']);
    expect(readLinkedTrackerItemIds(null)).toEqual([]);
    expect(readLinkedTrackerItemIds(undefined)).toEqual([]);
    expect(readLinkedTrackerItemIds('{}')).toEqual([]);
    expect(readLinkedTrackerItemIds({ linkedTrackerItemIds: 'not-an-array' })).toEqual([]);
  });

  it('createBidirectionalLink preserves existing links when metadata arrives as a string', async () => {
    mockQuery
      // SELECT tracker_items (local row -> linkedSessions persisted)
      .mockResolvedValueOnce({
        rows: [{ workspace: '/tmp/ws', type: 'bug', sync_status: 'local', data: '{}' }],
      })
      // UPDATE tracker_items (linkedSessions write)
      .mockResolvedValueOnce({ rows: [] })
      // SELECT metadata FROM ai_sessions — string shape, one existing link
      .mockResolvedValueOnce({
        rows: [{ metadata: '{"linkedTrackerItemIds":["bug_existing"]}' }],
      })
      // UPDATE ai_sessions
      .mockResolvedValueOnce({ rows: [] });

    const changed = await createBidirectionalLink('bug_new', 'session_1');

    expect(changed).toBe(true);
    const updateCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE ai_sessions'),
    );
    expect(updateCall).toBeTruthy();
    const written = JSON.parse(updateCall![1]![0] as string);
    // Both the pre-existing link and the new one must survive; the unparsed
    // string read started from [] and clobbered bug_existing.
    expect(written.linkedTrackerItemIds).toEqual(['bug_existing', 'bug_new']);
  });

  it('removeBidirectionalLink removes a link when metadata arrives as a string', async () => {
    mockQuery
      // SELECT tracker_items
      .mockResolvedValueOnce({
        rows: [{ workspace: '/tmp/ws', type: 'bug', sync_status: 'local', data: '{}' }],
      })
      // SELECT metadata FROM ai_sessions — string shape, contains the link
      .mockResolvedValueOnce({
        rows: [{ metadata: '{"linkedTrackerItemIds":["bug_a","bug_b"]}' }],
      })
      // UPDATE ai_sessions
      .mockResolvedValueOnce({ rows: [] });

    const changed = await removeBidirectionalLink('bug_a', 'session_1');

    expect(changed).toBe(true);
    const updateCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE ai_sessions'),
    );
    expect(updateCall).toBeTruthy();
    const written = JSON.parse(updateCall![1]![0] as string);
    expect(written.linkedTrackerItemIds).toEqual(['bug_b']);
  });
});
