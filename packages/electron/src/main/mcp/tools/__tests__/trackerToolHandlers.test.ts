import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockQuery,
  mockGetEngine,
  mockUpsertWorkspaceTrackerSchema,
  mockUpsertWorkspaceTrackerSchemaPatch,
  mockResetWorkspaceTrackerSchemaOverride,
  mockDeleteWorkspaceTrackerSchema,
  mockGetAllTrackerSchemas,
  mockIsBuiltinTrackerSchema,
  mockGlobalRegistry,
  mockApplyHeadlessBodyMarkdown,
  mockDocumentServices,
  mockDocService,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetEngine: vi.fn(() => 'pglite'),
  mockUpsertWorkspaceTrackerSchema: vi.fn(),
  mockUpsertWorkspaceTrackerSchemaPatch: vi.fn(),
  mockResetWorkspaceTrackerSchemaOverride: vi.fn(),
  mockDeleteWorkspaceTrackerSchema: vi.fn(),
  mockGetAllTrackerSchemas: vi.fn((): any[] => []),
  mockIsBuiltinTrackerSchema: vi.fn(() => false),
  mockGlobalRegistry: {
    get: vi.fn(() => undefined),
    getAll: vi.fn(() => []),
    validate: vi.fn(() => ({ valid: true, errors: [] as Array<{ field: string; message: string }> })),
  },
  mockApplyHeadlessBodyMarkdown: vi.fn(async () => undefined),
  mockDocumentServices: new Map<string, any>(),
  mockDocService: {
    getTrackerItemById: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    listTrackerItems: vi.fn<(...args: any[]) => Promise<any[]>>(async () => []),
    ensureTrackerProjection: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    updateTrackerItemInFile: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    propagateInverseForUpdate: vi.fn<(...args: any[]) => Promise<void>>(async () => undefined),
    archiveTrackerItem: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    destroy: vi.fn(),
  },
}));

vi.mock('../../../database/initialize', () => ({
  getDatabase: () => ({
    query: mockQuery,
    getEngine: mockGetEngine,
  }),
}));

vi.mock('../../../services/TrackerIdentityService', () => ({
  getCurrentIdentity: vi.fn(() => ({ displayName: 'Test User' })),
}));

vi.mock('../../../services/TrackerPolicyService', () => ({
  getEffectiveTrackerSyncPolicy: vi.fn(() => ({ mode: 'local', scope: 'project' })),
  getInitialTrackerSyncStatus: vi.fn(() => 'local'),
  shouldSyncTrackerItem: vi.fn(() => false),
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
    upsertWorkspaceTrackerSchemaPatch: mockUpsertWorkspaceTrackerSchemaPatch,
    resetWorkspaceTrackerSchemaOverride: mockResetWorkspaceTrackerSchemaOverride,
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
  handleTrackerAddComment,
  handleTrackerDefineType,
  handleTrackerDeleteType,
  handleTrackerGet,
  handleTrackerLinkSession,
  handleTrackerList,
  handleTrackerListTypes,
  handleTrackerUnlinkSession,
  handleTrackerUpdate,
  readLinkedTrackerItemIds,
  removeBidirectionalLink,
  rowToTrackerItem,
} from '../trackerToolHandlers';
import { isTrackerSyncActive } from '../../../services/TrackerSyncManager';
import { getEffectiveTrackerSyncPolicy, shouldSyncTrackerItem } from '../../../services/TrackerPolicyService';

describe('handleTrackerList structured records', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDocumentServices.clear();
  });

  it('returns custom fields under `full` and honors the all-items sentinel', async () => {
    const items = Array.from({ length: 260 }, (_, index) => ({
      id: `release-${index}`,
      issueKey: `NIM-${index}`,
      type: 'release',
      typeTags: ['release'],
      title: `Release ${index}`,
      status: 'planned',
      priority: '',
      workspace: '/tmp/ws',
      customFields: {
        version: `1.0.${index}`,
        items: [{ itemId: `member-${index}` }],
      },
      updated: `2026-07-23T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
    }));
    mockDocService.listTrackerItems.mockResolvedValue(items);
    mockDocumentServices.set('/tmp/ws', mockDocService);

    const result = await handleTrackerList({ type: 'release', limit: -1, full: true }, '/tmp/ws');
    const payload = JSON.parse(result.content[0].text!);

    expect(result.isError).toBeFalsy();
    expect(payload.structured.items).toHaveLength(260);
    expect(payload.structured.items[0].customFields).toMatchObject({
      version: expect.any(String),
      items: [expect.objectContaining({ itemId: expect.any(String) })],
    });
  });

  it('treats a where `=` with an empty operand as "match empties"', async () => {
    mockDocService.listTrackerItems.mockResolvedValue([
      { id: 'a', type: 'bug', typeTags: ['bug'], title: 'No owner', status: 'to-do', workspace: '/tmp/ws', customFields: { owner: '' } },
      { id: 'b', type: 'bug', typeTags: ['bug'], title: 'Has owner', status: 'to-do', workspace: '/tmp/ws', customFields: { owner: 'greg' } },
    ]);
    mockDocumentServices.set('/tmp/ws', mockDocService);

    const result = await handleTrackerList(
      { where: [{ field: 'owner', op: '=', value: '' }] },
      '/tmp/ws',
    );
    const items = JSON.parse(result.content[0].text!).structured.items;

    // The blank binary clause must select the empty-owner item, not vanish and
    // return everything (the pre-`is-empty` idiom).
    expect(items.map((i: any) => i.id)).toEqual(['a']);
  });

  it('registers workspace schemas before resolving roles', async () => {
    const { ensureWorkspaceTrackerSchemasLoaded } = await import('../../../services/TrackerSchemaService');
    vi.mocked(ensureWorkspaceTrackerSchemasLoaded).mockClear();
    mockDocService.listTrackerItems.mockResolvedValue([]);
    mockDocumentServices.set('/tmp/ws', mockDocService);

    await handleTrackerList({ inbox: true }, '/tmp/ws');

    expect(ensureWorkspaceTrackerSchemasLoaded).toHaveBeenCalledWith('/tmp/ws');
  });

  it('omits the heavy fields by default so an ordinary list stays small', async () => {
    mockDocService.listTrackerItems.mockResolvedValue([
      {
        id: 'release-0',
        issueKey: 'NIM-0',
        type: 'release',
        typeTags: ['release'],
        title: 'Release 0',
        status: 'planned',
        priority: '',
        workspace: '/tmp/ws',
        customFields: { version: '1.0.0', items: [{ itemId: 'member-0' }] },
        linkedSessions: ['session-1'],
        origin: 'agent',
        updated: '2026-07-23T00:00:00.000Z',
      },
    ]);
    mockDocumentServices.set('/tmp/ws', mockDocService);

    const result = await handleTrackerList({ type: 'release' }, '/tmp/ws');
    const item = JSON.parse(result.content[0].text!).structured.items[0];

    // Lean identity fields survive; the heavy fields are gone without `full`.
    expect(item.title).toBe('Release 0');
    expect(item.status).toBe('planned');
    expect(item.customFields).toBeUndefined();
    expect(item.linkedSessions).toBeUndefined();
    expect(item.origin).toBeUndefined();
  });
});

describe('handleTrackerAddComment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists an agent comment and attributed activity through the tracker row', async () => {
    const row = makeRow({ workspace: '/tmp/ws' });
    mockQuery
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] });

    const result = await handleTrackerAddComment(
      { trackerId: 'NIM-1', body: '**Agent** comment' },
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    const updateCall = mockQuery.mock.calls.find((call) =>
      String(call[0]).includes('UPDATE tracker_items SET data'),
    );
    expect(updateCall).toBeTruthy();
    const data = JSON.parse(updateCall![1]![0] as string);
    expect(data.comments).toHaveLength(1);
    expect(data.comments[0].body).toBe('**Agent** comment');
    expect(data.activity).toHaveLength(1);
    expect(data.activity[0]).toMatchObject({
      action: 'commented',
      authorIdentity: { displayName: 'Test User' },
    });
  });
});

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

  it('un-nests a synced data.customFields bag instead of double-nesting it (NIM-1305 / NIM-1077)', () => {
    // Synced items store custom + relationship fields NESTED under
    // data.customFields. Double-nesting here (customFields.customFields) made the
    // sync round-trip bury sourceDocument/features one level deeper until they
    // vanished from the flattened read model.
    const item = rowToTrackerItem(
      makeRow({
        type: 'feature-module',
        type_tags: ['feature-module'],
        data: JSON.stringify({
          title: 'Module',
          status: 'current',
          customFields: {
            sourceDocument: 'doc.md',
            sourceHeading: 'H',
            features: [{ itemId: 'feat-1' }],
          },
        }),
      })
    );
    expect(item.customFields?.sourceDocument).toBe('doc.md');
    expect(item.customFields?.sourceHeading).toBe('H');
    expect(item.customFields?.features).toEqual([{ itemId: 'feat-1' }]);
    // The raw nested bag must NOT be carried through as a nested key.
    expect(item.customFields?.customFields).toBeUndefined();
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

describe('rowToTrackerItem content decoding', () => {
  it('parses the JSON-encoded content column back into a plain markdown string', () => {
    // `content` is stored as JSON.stringify(markdown) (see updateTrackerItemContent /
    // tracker_create). Reading it back without JSON.parse leaves literal quotes and
    // escaped \n sequences, which is what rendered as raw text after close/reopen.
    const markdown = '**Objetivo**: validar\n\n### Links';
    const item = rowToTrackerItem(makeRow({ content: JSON.stringify(markdown) }));
    expect(item.content).toBe(markdown);
  });

  it('passes through non-JSON content unchanged (legacy/plain rows)', () => {
    const item = rowToTrackerItem(makeRow({ content: 'plain text' }));
    expect(item.content).toBe('plain text');
  });

  it('returns undefined when content is null', () => {
    const item = rowToTrackerItem(makeRow({ content: null }));
    expect(item.content).toBeUndefined();
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

  it('uses backend-portable SQL for SQLite tracker type usage checks', async () => {
    mockGetEngine.mockReturnValueOnce('sqlite');
    mockQuery.mockResolvedValueOnce({ rows: [{ count: 2 }] });

    const result = await handleTrackerDeleteType({ type: 'incident' }, '/tmp/ws');

    expect(result.isError).toBe(true);
    const usageSql = String(mockQuery.mock.calls[0][0]);
    expect(usageSql).toContain('COUNT(*) AS count');
    expect(usageSql).toContain('json_each(type_tags)');
    expect(usageSql).not.toContain('ANY(type_tags)');
    expect(usageSql).not.toContain('::int');
  });

  it('overrides a built-in via patch instead of refusing', async () => {
    mockIsBuiltinTrackerSchema.mockReturnValue(true); // 'feature' is a builtin
    mockUpsertWorkspaceTrackerSchemaPatch.mockResolvedValue({
      model: { type: 'feature', fields: [] },
      filePath: '/tmp/ws/.nimbalyst/trackers/feature.patch.yaml',
    });

    const patch = {
      type: 'feature',
      fields: [{ name: 'status', options: { set: [{ value: 'wont-do', label: "Won't Do" }] } }],
    };
    const result = await handleTrackerDefineType({ patch }, '/tmp/ws');

    expect(result.isError).toBe(false);
    expect(mockUpsertWorkspaceTrackerSchemaPatch).toHaveBeenCalledWith(
      '/tmp/ws',
      expect.objectContaining({ type: 'feature' }),
      { overwrite: true },
    );
    const payload = JSON.parse(result.content[0].text as string);
    expect(payload.structured.mode).toBe('patch');
  });

  it('still refuses a FULL-schema redefine of a built-in and points to patch', async () => {
    mockIsBuiltinTrackerSchema.mockReturnValue(true);

    const result = await handleTrackerDefineType(
      { schema: { type: 'bug', displayName: 'Bug', fields: [] } },
      '/tmp/ws',
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('patch');
    expect(mockUpsertWorkspaceTrackerSchema).not.toHaveBeenCalled();
  });

  it('resets a built-in override back to default via resetOverride', async () => {
    mockIsBuiltinTrackerSchema.mockReturnValue(true);
    mockResetWorkspaceTrackerSchemaOverride.mockResolvedValue({
      reset: true,
      filePath: '/tmp/ws/.nimbalyst/trackers/feature.patch.yaml',
    });

    const result = await handleTrackerDeleteType(
      { type: 'feature', resetOverride: true },
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    expect(mockResetWorkspaceTrackerSchemaOverride).toHaveBeenCalledWith('/tmp/ws', 'feature');
    const payload = JSON.parse(result.content[0].text as string);
    expect(payload.structured.action).toBe('reset-override');
  });

  it('refuses to reset a built-in that has no override', async () => {
    mockIsBuiltinTrackerSchema.mockReturnValue(true);
    mockResetWorkspaceTrackerSchemaOverride.mockResolvedValue({ reset: false });

    const result = await handleTrackerDeleteType(
      { type: 'feature', resetOverride: true },
      '/tmp/ws',
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no workspace override');
  });
});

describe('handleTrackerCreate session linking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDocumentServices.clear();
    mockGlobalRegistry.get.mockReturnValue(undefined);
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

  function setupCreateQueueWithDescription() {
    const createdRow = makeRow({
      id: 'bug_test',
      workspace: '/tmp/ws',
      issue_key: null,
      issue_number: null,
    });
    const keyedRow = { ...createdRow, issue_key: 'NIM-1', issue_number: 1 };
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // INSERT
      .mockResolvedValueOnce({ rows: [createdRow] }) // resolve created
      .mockResolvedValueOnce({ rows: [{ max_num: 0 }] }) // MAX(issue_number)
      .mockResolvedValueOnce({ rows: [] }) // UPDATE issue_key
      .mockResolvedValueOnce({ rows: [keyedRow] }) // re-resolve after issue key
      .mockResolvedValueOnce({ rows: [{ body_version: 1 }] }) // UPDATE content + body_version
      .mockResolvedValueOnce({ rows: [] }) // INSERT tracker_body_cache
      .mockResolvedValueOnce({ rows: [keyedRow] }); // notifyTrackerItemAdded
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

  it('seeds body cache and the live Y.Doc when creating with a description', async () => {
    setupCreateQueueWithDescription();

    const result = await handleTrackerCreate(
      { id: 'bug_test', type: 'bug', title: 'Some bug', description: 'Created body text' },
      '/tmp/ws',
      undefined,
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
      'bug_test',
      1,
      JSON.stringify('Created body text'),
    ]);

    expect(mockApplyHeadlessBodyMarkdown).toHaveBeenCalledTimes(1);
    expect(mockApplyHeadlessBodyMarkdown).toHaveBeenCalledWith(
      '/tmp/ws',
      'bug_test',
      'Created body text',
    );
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
    mockGlobalRegistry.get.mockReturnValue(undefined);
    mockGlobalRegistry.validate.mockReturnValue({ valid: true, errors: [] });
    // Default: non-collab (local) workspace -- description writes proceed.
    vi.mocked(getEffectiveTrackerSyncPolicy).mockReturnValue({ mode: 'local', scope: 'project' });
    vi.mocked(shouldSyncTrackerItem).mockReturnValue(false);
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

  it('clears nested relationship fields with unsetFields and propagates inverse removals (NIM-1305)', async () => {
    mockDocumentServices.set('/tmp/ws', mockDocService);
    (mockGlobalRegistry.get as any).mockReturnValue({
      sync: { mode: 'local', scope: 'project' },
      fields: [
        {
          name: 'modules',
          type: 'relationship',
          relationshipTypeKey: 'belongs-to',
          inverseFieldId: 'features',
          inverseRelationshipTypeKey: 'contains',
          multiValue: true,
        },
      ],
    });
    const trackerRow = makeRow({
      id: 'feature_target',
      type: 'product-feature',
      type_tags: ['product-feature'],
      workspace: '/tmp/ws',
      source: 'native',
      document_path: '',
      data: JSON.stringify({
        title: 'Feature',
        status: 'to-do',
        customFields: {
          modules: [{ itemId: 'module-1' }],
          sourceDocument: 'features.md',
        },
      }),
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [trackerRow] }) // resolveTrackerRowByReference
      .mockResolvedValueOnce({ rows: [] }) // UPDATE tracker_items SET data
      .mockResolvedValueOnce({ rows: [trackerRow] }) // notifyTrackerItemUpdated read
      .mockResolvedValueOnce({ rows: [trackerRow] }) // refreshedRow read for sync block
      .mockResolvedValueOnce({ rows: [trackerRow] }) // postSyncRow read
      .mockResolvedValueOnce({ rows: [{ type_tags: ['product-feature'] }] }); // re-read type_tags

    const result = await handleTrackerUpdate(
      { id: 'NIM-1', unsetFields: ['modules'] },
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    const updateCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE tracker_items SET data = $1'),
    );
    expect(updateCall).toBeDefined();
    const writtenData = JSON.parse(updateCall![1]![0] as string);
    expect(writtenData.customFields).toEqual({ sourceDocument: 'features.md' });
    expect(writtenData.modules).toBeUndefined();
    expect(mockDocService.propagateInverseForUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'feature_target', type: 'product-feature' }),
      { modules: undefined },
      expect.objectContaining({
        customFields: expect.objectContaining({ modules: [{ itemId: 'module-1' }] }),
      }),
      'local',
    );
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

  it('seeds the body when description arrives via the fields bag (NIM-438)', async () => {
    setupUpdateQueueWithDescription();

    const result = await handleTrackerUpdate(
      { id: 'NIM-1', fields: { description: 'body via fields bag' } },
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);

    const updateContentSql = mockQuery.mock.calls.find(
      (c) => /UPDATE tracker_items[\s\S]+SET content[\s\S]+body_version/.test(String(c[0])),
    );
    expect(updateContentSql).toBeDefined();

    const cacheInsert = mockQuery.mock.calls.find(
      (c) => /INSERT INTO tracker_body_cache/.test(String(c[0])),
    );
    expect(cacheInsert).toBeDefined();
    expect(cacheInsert![1]).toEqual([
      'bug_target',
      1,
      JSON.stringify('body via fields bag'),
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

// NIM-879: tracker_create made session-linking opt-in (NIM-408), but
// tracker_update was left auto-linking the ambient session on every field
// change, re-polluting sessions with unrelated items. Linking on update must
// now require an explicit linkSession: true.
describe('handleTrackerUpdate session linking (NIM-879)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDocumentServices.clear();
    mockGlobalRegistry.validate.mockReturnValue({ valid: true, errors: [] });
    vi.mocked(getEffectiveTrackerSyncPolicy).mockReturnValue({ mode: 'local', scope: 'project' });
    vi.mocked(shouldSyncTrackerItem).mockReturnValue(false);
    vi.mocked(isTrackerSyncActive).mockReturnValue(false);
  });

  it('does NOT link the ambient session on a status update when linkSession is omitted', async () => {
    // Catch-all: every read returns a consistent native row so the handler walks
    // its update path without us hand-counting each query.
    mockQuery.mockResolvedValue({ rows: [makeRow({ id: 'bug_target', workspace: '/tmp/ws', source: 'native', document_path: '' })] });

    const result = await handleTrackerUpdate(
      { id: 'NIM-1', status: 'in-progress' },
      '/tmp/ws',
      'session_abc',
    );

    expect(result.isError).toBe(false);
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('UPDATE ai_sessions'))).toBe(false);
    expect(sqls.some((s) => s.includes('SELECT metadata FROM ai_sessions'))).toBe(false);
  });

  it('links the ambient session on update when linkSession: true', async () => {
    mockQuery.mockResolvedValue({ rows: [makeRow({ id: 'bug_target', workspace: '/tmp/ws', source: 'native', document_path: '', metadata: '{}', data: '{}' })] });

    const result = await handleTrackerUpdate(
      { id: 'NIM-1', status: 'in-progress', linkSession: true },
      '/tmp/ws',
      'session_abc',
    );

    expect(result.isError).toBe(false);
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('UPDATE ai_sessions'))).toBe(true);
  });
});
