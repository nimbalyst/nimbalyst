// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockQuery,
  mockGetEngine,
  mockUpsertWorkspaceTrackerSchema,
  mockUpsertWorkspaceTrackerSchemaPatch,
  mockResetWorkspaceTrackerSchemaOverride,
  mockPreviewWorkspaceTrackerSchemaChange,
  mockDeleteWorkspaceTrackerSchema,
  mockGetTrackerSchemaOwnershipDetails,
  mockWriteThroughTeamTrackerSchemaEdit,
  mockGetAllTrackerSchemas,
  mockIsBuiltinTrackerSchema,
  mockGlobalRegistry,
  mockApplyHeadlessBodyMarkdown,
  mockOnTrackerItemApplied,
  mockAwaitServerIssueKey,
  mockDocumentServices,
  mockDocService,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetEngine: vi.fn(() => 'pglite'),
  mockUpsertWorkspaceTrackerSchema: vi.fn(),
  mockUpsertWorkspaceTrackerSchemaPatch: vi.fn(),
  mockResetWorkspaceTrackerSchemaOverride: vi.fn(),
  // Default: nothing to price. Tests that exercise the destructive guard rail
  // override this with a real classification.
  mockPreviewWorkspaceTrackerSchemaChange: vi.fn(async () => ({
    classification: { classification: 'none' as const, changes: [], renameCandidates: [] },
    verdict: { allowed: true as const, reason: 'no-change' as const },
    blastRadius: [],
    blastRadiusText: 'No items are affected.',
    actorRole: 'admin' as const,
    sharing: undefined,
  })),
  mockDeleteWorkspaceTrackerSchema: vi.fn(),
  // Annotated with the real return type: inferring it from this default fixture
  // pins `lastChangedBy` to `null` and `activity` to `never[]`, so a per-test
  // override supplying a real editor or trail no longer type-checks.
  mockGetTrackerSchemaOwnershipDetails: vi.fn(async (
    _workspacePath: string,
    models: any[],
  ): Promise<Map<string, import(
    '../../../services/TrackerSchemaService'
  ).TrackerSchemaOwnershipDetails>> => new Map(
    models.map((model) => [model.type, {
      owner: model.sharing === 'team' ? 'team:Acme' : 'personal',
      lastChangedBy: null,
      activity: [],
      fileName: `${model.type}.yaml`,
      gitTracked: false,
      ownershipNotice: model.sharing === 'team'
        ? 'Shared with Acme. Saving this file updates it for everyone. Last changed by unknown.'
        : undefined,
    }]),
  )),
  mockWriteThroughTeamTrackerSchemaEdit: vi.fn(async () => undefined),
  mockGetAllTrackerSchemas: vi.fn((): any[] => []),
  mockIsBuiltinTrackerSchema: vi.fn(() => false),
  mockGlobalRegistry: {
    // `(): any` so tests can return partial models; inferring `undefined` from
    // this default made every such override an error.
    get: vi.fn((): any => undefined),
    getAll: vi.fn(() => []),
    validate: vi.fn(() => ({ valid: true, errors: [] as Array<{ field: string; message: string }> })),
  },
  mockApplyHeadlessBodyMarkdown: vi.fn<(...args: any[]) => Promise<boolean>>(async () => true),
  mockOnTrackerItemApplied: vi.fn<(listener: any) => () => void>(() => () => {}),
  mockAwaitServerIssueKey: vi.fn<(...args: any[]) => Promise<string | null>>(async () => null),
  mockDocumentServices: new Map<string, any>(),
  mockDocService: {
    getTrackerItemById: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    listTrackerItems: vi.fn<(...args: any[]) => Promise<any[]>>(async () => []),
    ensureTrackerProjection: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    updateTrackerItemInFile: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    propagateInverseForUpdate: vi.fn<(...args: any[]) => Promise<void>>(async () => undefined),
    archiveTrackerItem: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    setTrackerItemPublished: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
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
  getEffectiveTrackerSharingPolicy: vi.fn(() => ({ sharing: 'personal', draftByDefault: false })),
  getInitialTrackerSyncStatus: vi.fn(() => 'local'),
  shouldSyncTrackerItem: vi.fn(() => false),
}));

vi.mock('../../../services/TrackerSyncManager', () => ({
  isTrackerSyncActive: vi.fn(() => false),
  syncTrackerItem: vi.fn(),
  onTrackerItemApplied: mockOnTrackerItemApplied,
}));

// The wait itself (ack listener, pre-read, timeout) is covered in
// awaitServerIssueKey.test.ts; here we only care what the handler reports for
// each of its two outcomes.
vi.mock('../../../services/tracker/awaitServerIssueKey', () => ({
  awaitServerIssueKey: mockAwaitServerIssueKey,
  SERVER_ISSUE_KEY_TIMEOUT_MS: 2000,
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
    previewWorkspaceTrackerSchemaChange: mockPreviewWorkspaceTrackerSchemaChange,
    deleteWorkspaceTrackerSchema: mockDeleteWorkspaceTrackerSchema,
    getTrackerSchemaOwnershipDetails: mockGetTrackerSchemaOwnershipDetails,
    writeThroughTeamTrackerSchemaEdit: mockWriteThroughTeamTrackerSchemaEdit,
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
import { isTrackerSyncActive, syncTrackerItem } from '../../../services/TrackerSyncManager';
import { getEffectiveTrackerSharingPolicy, shouldSyncTrackerItem } from '../../../services/TrackerPolicyService';
import { resolveTrackerPromotionEligibility } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerLifecycle';

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

  // NIM-2072 / NIM-2280: on the SQLite backend `archived` reaches the handler as
  // 0/1, so the old `=== true` / `!== true` pair listed archived items in the
  // default view and returned nothing for `archived: true`.
  it('splits archived from active items when the flag is a database integer', async () => {
    const items = [
      { id: 'active', type: 'bug', typeTags: ['bug'], title: 'Active', status: 'to-do', workspace: '/tmp/ws', archived: 0 },
      { id: 'gone', type: 'bug', typeTags: ['bug'], title: 'Gone', status: 'to-do', workspace: '/tmp/ws', archived: 1 },
    ];
    mockDocService.listTrackerItems.mockResolvedValue(items);
    mockDocumentServices.set('/tmp/ws', mockDocService);

    const active = await handleTrackerList({}, '/tmp/ws');
    expect(JSON.parse(active.content[0].text!).structured.items.map((i: any) => i.id)).toEqual(['active']);

    const archived = await handleTrackerList({ archived: true }, '/tmp/ws');
    expect(JSON.parse(archived.content[0].text!).structured.items.map((i: any) => i.id)).toEqual(['gone']);
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

describe('handleTrackerCreate issue-key timing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDocumentServices.clear();
    mockGlobalRegistry.get.mockReturnValue(undefined);
    mockGlobalRegistry.validate.mockReturnValue({ valid: true, errors: [] });
    mockAwaitServerIssueKey.mockResolvedValue(null);
    vi.mocked(isTrackerSyncActive).mockReturnValue(true);
    vi.mocked(shouldSyncTrackerItem).mockReturnValue(true);
  });

  afterEach(() => {
    // `isTrackerSyncActive` / `shouldSyncTrackerItem` are shared with every
    // other describe here, and an unconsumed `mockResolvedValueOnce` queue
    // survives `clearAllMocks` -- either one leaking turns a later test's
    // unrelated create into a synced one.
    vi.mocked(isTrackerSyncActive).mockReturnValue(false);
    vi.mocked(shouldSyncTrackerItem).mockReturnValue(false);
    mockQuery.mockReset();
  });

  function setupUnkeyedCreateQueue({ published, serverKeyArrives }: { published: boolean; serverKeyArrives: boolean }) {
    const base = makeRow({ id: 'bug_test', workspace: '/tmp/ws', issue_key: null, issue_number: null });
    mockQuery
      .mockResolvedValueOnce({ rows: [] })     // INSERT
      .mockResolvedValueOnce({ rows: [base] }); // resolve created
    if (published) {
      mockQuery.mockResolvedValueOnce({ rows: [base] }); // re-resolve after sync
    }
    mockQuery.mockResolvedValueOnce({ rows: [base] }); // notifyTrackerItemAdded
    if (serverKeyArrives) {
      mockQuery.mockResolvedValueOnce({
        rows: [{ ...base, issue_key: 'NIM-2615', issue_number: 2615 }],
      });
    }
  }

  function parseResult(result: any) {
    return JSON.parse(result.content[0].text);
  }

  it('leaves a personal tracker item without any key', async () => {
    vi.mocked(isTrackerSyncActive).mockReturnValue(false);
    vi.mocked(shouldSyncTrackerItem).mockReturnValue(false);
    setupUnkeyedCreateQueue({ published: false, serverKeyArrives: false });

    const result = await handleTrackerCreate({ type: 'bug', title: 'Personal bug' }, '/tmp/ws');
    const { structured, summary } = parseResult(result);

    expect(structured.item.issueKey).toBeUndefined();
    expect(structured.item.issueKeyStatus).toBe('unassigned');
    expect(summary).toContain('This item has no key until it is published.');
    expect(mockAwaitServerIssueKey).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls.some(([sql]) => /UPDATE tracker_items[\s\S]*SET[\s\S]*issue_key|MAX\(issue_number\)|LC-/.test(String(sql)))).toBe(false);
  });

  it('leaves a team draft without any key', async () => {
    (mockGlobalRegistry.get as any).mockReturnValue({ sharing: 'team', draftByDefault: true });
    vi.mocked(shouldSyncTrackerItem).mockReturnValue(false);
    setupUnkeyedCreateQueue({ published: false, serverKeyArrives: false });

    const result = await handleTrackerCreate({ type: 'bug', title: 'Draft bug' }, '/tmp/ws');
    const { structured, summary } = parseResult(result);

    expect(structured.item.issueKey).toBeUndefined();
    expect(structured.item.issueKeyStatus).toBe('unassigned');
    expect(summary).toContain('This item has no key until it is published.');
    expect(mockAwaitServerIssueKey).not.toHaveBeenCalled();
  });

  it('reports exactly one server-issued key for a published team item', async () => {
    setupUnkeyedCreateQueue({ published: true, serverKeyArrives: true });
    mockAwaitServerIssueKey.mockResolvedValue('NIM-2615');

    const result = await handleTrackerCreate({ type: 'bug', title: 'Some bug' }, '/tmp/ws');
    const { structured, summary } = parseResult(result);

    expect(mockAwaitServerIssueKey).toHaveBeenCalledWith(expect.anything(), structured.item.id);
    expect(structured.item.issueKey).toBe('NIM-2615');
    expect(structured.item.issueKeyStatus).toBe('assigned');
    expect(summary).toContain('NIM-2615');
    expect(syncTrackerItem).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls.some(([sql]) => /UPDATE tracker_items[\s\S]*SET[\s\S]*issue_key|MAX\(issue_number\)|LC-/.test(String(sql)))).toBe(false);
  });

  it('explains that a published item still has no key when server assignment is pending', async () => {
    setupUnkeyedCreateQueue({ published: true, serverKeyArrives: false });
    mockAwaitServerIssueKey.mockResolvedValue(null);

    const result = await handleTrackerCreate({ type: 'bug', title: 'Some bug' }, '/tmp/ws');
    const { structured, summary } = parseResult(result);

    expect(structured.item.issueKey).toBeUndefined();
    expect(structured.item.issueKeyStatus).toBe('unassigned');
    expect(summary).toContain('server-issued key is still pending');
  });

  it('never asks for or rewrites a different key when one already exists', async () => {
    const base = makeRow({ id: 'bug_test', workspace: '/tmp/ws', issue_key: null, issue_number: null });
    const keyed = { ...base, issue_key: 'NIM-2521', issue_number: 2521 };
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [keyed] })
      .mockResolvedValueOnce({ rows: [keyed] })
      .mockResolvedValueOnce({ rows: [keyed] });

    const result = await handleTrackerCreate({ type: 'bug', title: 'Some bug' }, '/tmp/ws');
    const { structured, summary } = parseResult(result);

    expect(structured.item.issueKey).toBe('NIM-2521');
    expect(summary).toContain('NIM-2521');
    expect(mockAwaitServerIssueKey).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls.some(([sql]) => String(sql).includes('SET issue_key'))).toBe(false);
  });
});

describe('provisional keys are not resolvable references', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    mockDocumentServices.clear();
  });

  // An LC suffix is handed out again after the ack clears it, so matching one
  // against `issue_key` silently lands on whichever item holds it now.
  it('refuses to resolve an LC- reference instead of matching the wrong row', async () => {
    const result = await handleTrackerAddComment(
      { trackerId: 'LC-2', body: 'comment' },
      '/tmp/ws',
    );

    expect(result.isError).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
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

  afterEach(() => {
    mockDocService.getTrackerItemById.mockResolvedValue(null);
    mockDocService.listTrackerItems.mockResolvedValue([]);
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

  it('refuses a provisional key before it can resolve to a reused row', async () => {
    mockDocumentServices.set('/tmp/workspace-a', mockDocService);

    const result = await handleTrackerGet({ id: 'LC-2' }, '/tmp/workspace-a');

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('stable ID');
    expect(mockDocService.getTrackerItemById).not.toHaveBeenCalled();
    expect(mockDocService.listTrackerItems).not.toHaveBeenCalled();
  });

  it('explains why an unpublished item has no issue key', async () => {
    mockDocService.getTrackerItemById.mockResolvedValue(makeItem({
      id: 'bug_draft',
      issueKey: undefined,
      issueNumber: undefined,
      workspace: '/tmp/workspace-a',
    }));
    mockDocumentServices.set('/tmp/workspace-a', mockDocService);

    const result = await handleTrackerGet({ id: 'bug_draft' }, '/tmp/workspace-a');

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.item.issueKey).toBeUndefined();
    expect(payload.structured.item.issueKeyStatus).toBe('unassigned');
    expect(payload.summary).toContain('This item has no key until it is published.');
  });

  // MUL-26: `structured.item` was built from a 12-key whitelist that omitted
  // `archived`, so an archived item read back as active through `tracker_get`
  // forever -- while `tracker_list` and the markdown summary both said archived.
  // `nim`'s LiveGateway then turned the absent key into a confident `false`.
  it('reports archive state in the structured payload, not just the summary', async () => {
    mockDocumentServices.set('/tmp/ws', mockDocService);
    mockDocService.getTrackerItemById.mockResolvedValueOnce(
      makeItem({ archived: true, archivedAt: '2026-08-10T16:38:19.899Z' }),
    );

    const payload = JSON.parse(
      (await handleTrackerGet({ id: 'NIM-1' }, '/tmp/ws')).content[0].text!,
    );

    expect(payload.summary).toContain('**Archived**: yes');
    expect(payload.structured.item.archived).toBe(true);
    expect(payload.structured.item.archivedAt).toBe('2026-08-10T16:38:19.899Z');
  });

  it('defaults archive state to false rather than dropping the key', async () => {
    mockDocumentServices.set('/tmp/ws', mockDocService);
    mockDocService.getTrackerItemById.mockResolvedValueOnce(makeItem());

    const payload = JSON.parse(
      (await handleTrackerGet({ id: 'NIM-1' }, '/tmp/ws')).content[0].text!,
    );

    expect(payload.structured.item.archived).toBe(false);
    expect(payload.structured.item.archivedAt).toBeUndefined();
  });

  it('agrees with tracker_list on archive state for the same item', async () => {
    const item = makeItem({ id: 'gone', archived: true, syncStatus: 'synced' });
    mockDocumentServices.set('/tmp/ws', mockDocService);
    mockDocService.getTrackerItemById.mockResolvedValueOnce(item);
    mockDocService.listTrackerItems.mockResolvedValue([item]);

    const got = JSON.parse(
      (await handleTrackerGet({ id: 'gone' }, '/tmp/ws')).content[0].text!,
    ).structured.item;
    const listed = JSON.parse(
      (await handleTrackerList({ archived: true }, '/tmp/ws')).content[0].text!,
    ).structured.items[0];

    expect(got.archived).toBe(listed.archived);
    expect(got.syncStatus).toBe(listed.syncStatus);
  });

  // The comment write path canonicalizes to `data.comments`, which
  // `rowToTrackerItem` lifts into the customFields bag -- and
  // `internalCustomFieldKeys` then stripped it back out, so a posted comment
  // was readable through no MCP surface at all.
  it('surfaces comments that reach the item through the customFields bag', async () => {
    mockDocumentServices.set('/tmp/ws', mockDocService);
    mockDocService.getTrackerItemById.mockResolvedValueOnce(
      makeItem({
        customFields: {
          prUrl: 'https://example.test/pr/1',
          comments: [
            {
              id: 'comment_1',
              authorIdentity: { displayName: 'Test User' },
              body: 'PROBE-XYZZY',
              createdAt: 1785790418549,
              deleted: false,
            },
          ],
        },
      }),
    );

    const payload = JSON.parse(
      (await handleTrackerGet({ id: 'NIM-1' }, '/tmp/ws')).content[0].text!,
    );

    expect(payload.structured.item.comments).toHaveLength(1);
    expect(payload.structured.item.comments[0].body).toBe('PROBE-XYZZY');
    // Genuine schema fields keep their place in the bag, and `comments` is not
    // duplicated into it (the summary would render it as a stray field line).
    expect(payload.structured.item.customFields).toEqual({
      prUrl: 'https://example.test/pr/1',
    });
  });

  it('reports an empty comment list rather than dropping the key', async () => {
    mockDocumentServices.set('/tmp/ws', mockDocService);
    mockDocService.getTrackerItemById.mockResolvedValueOnce(makeItem());

    const payload = JSON.parse(
      (await handleTrackerGet({ id: 'NIM-1' }, '/tmp/ws')).content[0].text!,
    );

    expect(payload.structured.item.comments).toEqual([]);
  });
});

// The fix above reads comments out of `item.customFields`. That only holds
// because neither row mapper lists `comments` in its "known" first-class key
// set, so `extractItemCustomFields` leaves it in the bag. Guard that here: if a
// mapper ever promotes `comments` to a top-level field, tracker_get goes quiet
// again rather than failing loudly.
describe('rowToTrackerItem archive and comment mapping', () => {
  it('carries data.comments into the customFields bag', () => {
    const item = rowToTrackerItem(
      makeRow({
        data: JSON.stringify({
          title: 'Scoped bug',
          comments: [{ id: 'comment_1', body: 'PROBE-XYZZY', deleted: false }],
        }),
      }),
    );

    expect(item.comments).toBeUndefined();
    expect(item.customFields?.comments).toEqual([
      { id: 'comment_1', body: 'PROBE-XYZZY', deleted: false },
    ]);
  });

  it('maps the archive columns onto first-class fields', () => {
    const archived = rowToTrackerItem(
      makeRow({ archived: 1, archived_at: '2026-08-10T16:38:19.899Z' }),
    );
    expect(archived.archived).toBe(1);
    expect(archived.archivedAt).toBe('2026-08-10T16:38:19.899Z');

    const active = rowToTrackerItem(makeRow({ archived: 0, archived_at: null }));
    expect(active.archivedAt).toBeUndefined();
  });
});

describe('tracker schema tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDocumentServices.clear();
    mockGetAllTrackerSchemas.mockReturnValue([]);
    mockIsBuiltinTrackerSchema.mockReturnValue(false);
    mockGlobalRegistry.get.mockReturnValue(undefined);
    mockDocService.listTrackerItems.mockResolvedValue([]);
    mockDocService.setTrackerItemPublished.mockResolvedValue(null);
    // Default: nothing destructive to price, so the guard rail stays out of the
    // way of every test that is not about it.
    mockPreviewWorkspaceTrackerSchemaChange.mockResolvedValue({
      classification: { classification: 'none' as const, changes: [], renameCandidates: [] },
      verdict: { allowed: true as const, reason: 'no-change' as const },
      blastRadius: [],
      blastRadiusText: 'No items are affected.',
      actorRole: 'admin' as const,
      sharing: undefined,
    });
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

  it('reports team ownership, last editor, activity, and git warning to agents', async () => {
    const teamModel = {
      type: 'incident',
      displayName: 'Incident',
      displayNamePlural: 'Incidents',
      sharing: 'team',
      fields: [],
    };
    mockGetAllTrackerSchemas.mockReturnValue([teamModel]);
    mockGetTrackerSchemaOwnershipDetails.mockResolvedValueOnce(new Map([['incident', {
      owner: 'team:Acme',
      lastChangedBy: 'Alice',
      activity: [{ action: 'schema_updated', authorIdentity: { displayName: 'Alice' }, timestamp: 1 }],
      fileName: 'incident.yaml',
      gitTracked: true,
      ownershipNotice: 'Shared with Acme. Saving this file updates it for everyone. Last changed by Alice.',
      warning: "This file is tracked by git. The team's copy will overwrite it. Restoring an older version while Nimbalyst is running updates it for everyone.",
    }]]));

    const result = await handleTrackerListTypes({}, '/tmp/ws');
    const payload = JSON.parse(result.content[0].text!);

    expect(payload.structured.items[0]).toMatchObject({
      owner: 'team:Acme',
      lastChangedBy: 'Alice',
      gitTracked: true,
      activity: [expect.objectContaining({ action: 'schema_updated' })],
      warning: expect.stringContaining("team's copy will overwrite it"),
    });
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
      { fileName: undefined, overwrite: false, confirmDestructive: false },
    );
  });

  it('promotes a personal tracker by publishing every existing item and preserving existing keys', async () => {
    (mockGlobalRegistry.get as any).mockReturnValue({ type: 'incident', sharing: 'personal', draftByDefault: false });
    mockUpsertWorkspaceTrackerSchemaPatch.mockResolvedValue({
      model: { type: 'incident', sharing: 'team', draftByDefault: false, fields: [] },
      filePath: '/tmp/ws/.nimbalyst/trackers/incident.patch.yaml',
    });
    const unkeyed = makeRow({ id: 'incident-1', type: 'incident', workspace: '/tmp/ws', issue_key: null, issue_number: null });
    const keyed = makeRow({ id: 'incident-2', type: 'incident', workspace: '/tmp/ws', issue_key: 'NIM-2521', issue_number: 2521 });
    mockDocService.listTrackerItems.mockResolvedValue([rowToTrackerItem(unkeyed), rowToTrackerItem(keyed)]);
    mockDocService.setTrackerItemPublished.mockImplementation(async (id: string) =>
      id === 'incident-1' ? rowToTrackerItem(unkeyed) : rowToTrackerItem(keyed));
    mockDocumentServices.set('/tmp/ws', mockDocService);
    vi.mocked(isTrackerSyncActive).mockReturnValue(true);
    mockAwaitServerIssueKey.mockResolvedValue('NIM-2522');

    const result = await handleTrackerDefineType(
      {
        patch: { type: 'incident', sharing: 'team' },
        promoteExistingItems: true,
      },
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    expect(mockDocService.setTrackerItemPublished).toHaveBeenCalledTimes(2);
    expect(syncTrackerItem).toHaveBeenCalledTimes(2);
    expect(mockAwaitServerIssueKey).toHaveBeenCalledTimes(1);
    expect(mockAwaitServerIssueKey).toHaveBeenCalledWith(expect.anything(), 'incident-1');
    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.promotion).toEqual({
      publishedCount: 2,
      assignedKeyCount: 2,
      pendingKeyCount: 0,
    });
    expect(payload.structured).toMatchObject({
      owner: 'team:Acme',
      changeScope: 'team',
      ownershipNotice: expect.stringContaining('updates it for everyone'),
    });
    expect(mockWriteThroughTeamTrackerSchemaEdit).toHaveBeenCalledWith(
      '/tmp/ws',
      '/tmp/ws/.nimbalyst/trackers/incident.patch.yaml',
      expect.objectContaining({ type: 'incident', activity: [expect.objectContaining({ action: 'schema_updated' })] }),
    );
  });

  it('leaves a mid-sweep body failure as a team-owned, user-retryable promotion', async () => {
    const personalModel = { type: 'incident', sharing: 'personal', draftByDefault: false };
    const teamModel = { type: 'incident', sharing: 'team' as const, draftByDefault: false, fields: [] };
    (mockGlobalRegistry.get as any).mockReturnValue(personalModel);
    mockUpsertWorkspaceTrackerSchemaPatch.mockResolvedValue({
      model: teamModel,
      filePath: '/tmp/ws/.nimbalyst/trackers/incident.patch.yaml',
    });
    const items = ['incident-1', 'incident-2', 'incident-3'].map((id) =>
      rowToTrackerItem(makeRow({ id, type: 'incident', workspace: '/tmp/ws', issue_key: null, issue_number: null })));
    mockDocService.listTrackerItems.mockResolvedValue(items);
    let roomWriteFails = true;
    mockDocService.setTrackerItemPublished.mockImplementation(async (id: string) => {
      if (id === 'incident-2' && roomWriteFails) {
        throw new Error('could not move the body into the team tracker');
      }
      return items.find((item) => item.id === id);
    });
    mockDocumentServices.set('/tmp/ws', mockDocService);
    vi.mocked(isTrackerSyncActive).mockReturnValue(false);

    const args = {
      patch: { type: 'incident', sharing: 'team' },
      promoteExistingItems: true,
    };
    const failed = await handleTrackerDefineType(args, '/tmp/ws');

    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toMatch(/team-owned|team tracker/i);
    expect(failed.content[0].text).toMatch(/retry|again/i);
    expect(mockUpsertWorkspaceTrackerSchemaPatch).toHaveBeenCalledTimes(1);
    expect(mockDocService.setTrackerItemPublished.mock.calls.map(([id]) => id)).toEqual([
      'incident-1',
      'incident-2',
    ]);

    // The schema write is intentionally one-way. The normal lifecycle action
    // remains available and replays the idempotent sweep instead of demoting.
    (mockGlobalRegistry.get as any).mockReturnValue(teamModel);
    expect(resolveTrackerPromotionEligibility(teamModel)).toMatchObject({
      canPromote: true,
      mode: 'resume',
    });
    roomWriteFails = false;

    const retried = await handleTrackerDefineType(args, '/tmp/ws');

    expect(retried.isError).toBe(false);
    expect(mockDocService.setTrackerItemPublished.mock.calls.slice(2).map(([id]) => id)).toEqual([
      'incident-1',
      'incident-2',
      'incident-3',
    ]);
    const payload = JSON.parse(retried.content[0].text!);
    expect(payload.structured.promotion.publishedCount).toBe(3);
  });

  it('requires an explicit backfill when promoting a personal tracker', async () => {
    (mockGlobalRegistry.get as any).mockReturnValue({ type: 'incident', sharing: 'personal', draftByDefault: false });

    const result = await handleTrackerDefineType(
      { patch: { type: 'incident', sharing: 'team' } },
      '/tmp/ws',
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('promoteExistingItems: true');
    expect(mockUpsertWorkspaceTrackerSchemaPatch).not.toHaveBeenCalled();
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
      { overwrite: true, confirmDestructive: false },
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
    expect(mockResetWorkspaceTrackerSchemaOverride).toHaveBeenCalledWith('/tmp/ws', 'feature', {
      confirmDestructive: false,
      actorRole: 'admin',
    });
    const payload = JSON.parse(result.content[0].text as string);
    expect(payload.structured.action).toBe('reset-override');
  });

  /**
   * `resetOverride: true` on a team tracker pushes a tombstone that resets the
   * type for everyone. Before W4-B it did so unwarned; these pin that it now
   * costs a stated blast radius, and that no tool argument gets a member past
   * the admin half of D3.
   */
  describe('destructive reset guard rail', () => {
    function destructiveReset(sharing: 'personal' | 'team', actorRole: 'admin' | 'member') {
      mockPreviewWorkspaceTrackerSchemaChange.mockResolvedValue({
        classification: {
          classification: 'destructive' as const,
          changes: [
            {
              kind: 'field-removed' as const,
              fieldName: 'severity',
              field: { name: 'severity', type: 'number' as const },
            },
          ],
          renameCandidates: [],
        },
        verdict: { allowed: false as const, reason: 'needs-confirmation' as const, blocking: [] },
        blastRadius: [],
        blastRadiusText: '7 items have `severity`.',
        actorRole,
        sharing,
      } as any);
    }

    beforeEach(() => {
      mockIsBuiltinTrackerSchema.mockReturnValue(true);
      mockResetWorkspaceTrackerSchemaOverride.mockResolvedValue({
        reset: true,
        filePath: '/tmp/ws/.nimbalyst/trackers/feature.patch.yaml',
      });
    });

    it('refuses an unconfirmed reset and reports the blast radius', async () => {
      destructiveReset('team', 'admin');

      const result = await handleTrackerDeleteType(
        { type: 'feature', resetOverride: true },
        '/tmp/ws',
      );

      expect(result.isError).toBe(true);
      expect(mockResetWorkspaceTrackerSchemaOverride).not.toHaveBeenCalled();
      // The attribution write must not run either: a refused call leaves no
      // trace, so nothing stamps a `schema_reset` entry onto the mirror row.
      expect(
        mockQuery.mock.calls.filter(([sql]) => String(sql).includes('tracker_type_defs')),
      ).toEqual([]);
      const payload = JSON.parse(result.content[0].text as string);
      expect(payload.structured).toMatchObject({
        action: 'schema-change-blocked',
        reason: 'needs-confirmation',
        blastRadius: '7 items have `severity`.',
        changeScope: 'team',
      });
      expect(payload.summary).toContain('confirmDestructive: true');
    });

    it('applies the reset once the caller confirms', async () => {
      destructiveReset('team', 'admin');

      const result = await handleTrackerDeleteType(
        { type: 'feature', resetOverride: true, confirmDestructive: true },
        '/tmp/ws',
      );

      expect(result.isError).toBe(false);
      expect(mockResetWorkspaceTrackerSchemaOverride).toHaveBeenCalledWith('/tmp/ws', 'feature', {
        confirmDestructive: true,
        actorRole: 'admin',
      });
    });

    it('refuses a member a team-wide reset even with confirmDestructive', async () => {
      destructiveReset('team', 'member');

      const result = await handleTrackerDeleteType(
        { type: 'feature', resetOverride: true, confirmDestructive: true },
        '/tmp/ws',
      );

      expect(result.isError).toBe(true);
      expect(mockResetWorkspaceTrackerSchemaOverride).not.toHaveBeenCalled();
      const payload = JSON.parse(result.content[0].text as string);
      expect(payload.structured.reason).toBe('requires-admin');
    });

    it('lets a member reset their own personal tracker once confirmed', async () => {
      destructiveReset('personal', 'member');

      const result = await handleTrackerDeleteType(
        { type: 'feature', resetOverride: true, confirmDestructive: true },
        '/tmp/ws',
      );

      expect(result.isError).toBe(false);
      expect(mockResetWorkspaceTrackerSchemaOverride).toHaveBeenCalled();
    });
  });

  it('makes a team-wide reset blast radius explicit', async () => {
    mockIsBuiltinTrackerSchema.mockReturnValue(true);
    mockGlobalRegistry.get.mockReturnValue({ type: 'feature', sharing: 'team', fields: [] });
    mockResetWorkspaceTrackerSchemaOverride.mockResolvedValue({
      reset: true,
      filePath: '/tmp/ws/.nimbalyst/trackers/feature.patch.yaml',
    });

    const result = await handleTrackerDeleteType(
      { type: 'feature', resetOverride: true },
      '/tmp/ws',
    );
    const payload = JSON.parse(result.content[0].text as string);

    expect(payload.structured).toMatchObject({
      owner: 'team:Acme',
      lastChangedBy: 'Test User',
      blastRadius: 'team',
      blastRadiusMessage: "This change updates tracker 'feature' for everyone in Acme.",
    });
    expect(payload.summary).toContain('for everyone in Acme');
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
      .mockResolvedValueOnce({ rows: [createdRow] });                   // notifyTrackerItemAdded
  }

  function setupCreateQueueWithDescription() {
    const createdRow = makeRow({
      id: 'bug_test',
      workspace: '/tmp/ws',
      issue_key: null,
      issue_number: null,
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // INSERT
      .mockResolvedValueOnce({ rows: [createdRow] }) // resolve created
      .mockResolvedValueOnce({ rows: [{ body_version: 1 }] }) // UPDATE content + body_version
      .mockResolvedValueOnce({ rows: [] }) // INSERT tracker_body_cache
      .mockResolvedValueOnce({ rows: [createdRow] }); // notifyTrackerItemAdded
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
      // createBidirectionalLink:
      .mockResolvedValueOnce({ rows: [{ data: {} }] })                  // SELECT data FROM tracker_items
      .mockResolvedValueOnce({ rows: [] })                              // UPDATE tracker_items
      .mockResolvedValueOnce({ rows: [{ metadata: {} }] })              // SELECT metadata FROM ai_sessions
      .mockResolvedValueOnce({ rows: [] })                              // UPDATE ai_sessions
      // notifySessionLinkedTrackerChanged read:
      .mockResolvedValueOnce({ rows: [{ metadata: { linkedTrackerItemIds: ['bug_test'] } }] })
      // notifyTrackerItemAdded:
      .mockResolvedValueOnce({ rows: [createdRow] });

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

  it('reports partial success when a shared create cannot store the collaborative body', async () => {
    setupCreateQueueWithDescription();
    vi.mocked(shouldSyncTrackerItem).mockReturnValue(true);
    vi.mocked(isTrackerSyncActive).mockReturnValue(false);
    mockApplyHeadlessBodyMarkdown.mockResolvedValueOnce(false);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await handleTrackerCreate(
        { id: 'bug_test', type: 'bug', title: 'Some bug', description: 'Body that did not propagate' },
        '/tmp/ws',
        undefined,
      );
      const payload = JSON.parse(result.content[0].text!);

      expect(result.isError).toBe(false);
      expect(payload.structured.bodyWrite).toEqual({
        status: 'failed',
        itemFieldsStored: true,
        localSnapshotStored: true,
        collaborativeBodyStored: false,
        message: expect.stringContaining('body was not stored in collaborative tracker content'),
      });
      expect(payload.summary).toContain('**Body write**: Failed');
      expect(payload.summary).toContain('body was not stored in collaborative tracker content');
      expect(errorSpy).toHaveBeenCalledWith(
        '[MCP Server] tracker_create collaborative body write failed:',
        { itemId: 'bug_test', workspacePath: '/tmp/ws' },
      );
    } finally {
      errorSpy.mockRestore();
    }
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
    vi.mocked(getEffectiveTrackerSharingPolicy).mockReturnValue({ sharing: 'personal', draftByDefault: false });
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
      sharing: 'personal',
      draftByDefault: false,
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
      'personal',
      false,
    );
  });

  it('lands an MCP field write on the nested copy the readers surface, not a top-level shadow (NIM-1305)', async () => {
    // The durable synced shape nests custom fields, and nested wins on read. A
    // writer whose schema no longer types `modules` as a relationship leaves the
    // nesting pass with nothing to move, so a plain top-level assignment is
    // shadowed by the stale nested value and the agent's edit silently reverts.
    const staleValue = [{ itemId: 'module-old' }];
    const editedValue = [{ itemId: 'module-new' }];
    (mockGlobalRegistry.get as any).mockReturnValue({
      sharing: 'personal',
      draftByDefault: false,
      fields: [{ name: 'title', type: 'string' }],
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
        customFields: { modules: staleValue, sourceDocument: 'features.md' },
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
      { id: 'NIM-1', fields: { modules: editedValue } },
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    const updateCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE tracker_items SET data = $1'),
    );
    const writtenData = JSON.parse(updateCall![1]![0] as string);
    expect(writtenData.customFields).toEqual({
      modules: editedValue,
      sourceDocument: 'features.md',
    });
    expect(writtenData.modules).toBeUndefined();
  });

  it('still canonicalizes and reports a known relationship write to inverse propagation', async () => {
    // The same routing must not run ahead of applyRelationshipFieldWrites: a
    // field the schema DOES know still has to be validated and serialized, and
    // inverse propagation still has to see the new value.
    mockDocumentServices.set('/tmp/ws', mockDocService);
    (mockGlobalRegistry.get as any).mockReturnValue({
      sharing: 'personal',
      draftByDefault: false,
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
        customFields: { modules: [{ itemId: 'module-1' }] },
      }),
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [trackerRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [trackerRow] })
      .mockResolvedValueOnce({ rows: [trackerRow] })
      .mockResolvedValueOnce({ rows: [trackerRow] })
      .mockResolvedValueOnce({ rows: [{ type_tags: ['product-feature'] }] });

    // A bare id string is the uncanonicalized shape an agent may send.
    const result = await handleTrackerUpdate(
      { id: 'NIM-1', fields: { modules: ['module-2'] } },
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    const updateCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE tracker_items SET data = $1'),
    );
    const writtenData = JSON.parse(updateCall![1]![0] as string);
    expect(writtenData.customFields.modules).toEqual([
      expect.objectContaining({ itemId: 'module-2' }),
    ]);
    expect(writtenData.modules).toBeUndefined();
    expect(mockDocService.propagateInverseForUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'feature_target' }),
      { modules: [expect.objectContaining({ itemId: 'module-2' })] },
      expect.anything(),
      'personal',
      false,
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

  it('reports partial success when an update cannot store the collaborative body', async () => {
    setupUpdateQueueWithDescription();
    vi.mocked(getEffectiveTrackerSharingPolicy).mockReturnValue({ sharing: 'team', draftByDefault: false });
    vi.mocked(shouldSyncTrackerItem).mockReturnValue(true);
    vi.mocked(isTrackerSyncActive).mockReturnValue(true);
    mockApplyHeadlessBodyMarkdown.mockResolvedValueOnce(false);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await handleTrackerUpdate(
        { id: 'NIM-1', description: 'Updated body that did not propagate' },
        '/tmp/ws',
      );
      const payload = JSON.parse(result.content[0].text!);

      expect(result.isError).toBe(false);
      expect(payload.structured.bodyWrite).toEqual({
        status: 'failed',
        itemFieldsStored: true,
        localSnapshotStored: true,
        collaborativeBodyStored: false,
        message: expect.stringContaining('body was not stored in collaborative tracker content'),
      });
      expect(payload.summary).toContain('**Body write**: Failed');
      expect(payload.summary).toContain('body was not stored in collaborative tracker content');
      expect(errorSpy).toHaveBeenCalledWith(
        '[MCP Server] tracker_update collaborative body write failed:',
        { itemId: 'bug_target', workspacePath: '/tmp/ws' },
      );
    } finally {
      errorSpy.mockRestore();
    }
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

describe('handleTrackerUpdate Draft/Published operation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    mockDocumentServices.clear();
    (mockGlobalRegistry.get as any).mockReturnValue({ sharing: 'team', draftByDefault: true });
    mockGlobalRegistry.validate.mockReturnValue({ valid: true, errors: [] });
    vi.mocked(isTrackerSyncActive).mockReturnValue(true);
    mockDocumentServices.set('/tmp/ws', mockDocService);
  });

  afterEach(() => {
    mockDocService.getTrackerItemById.mockResolvedValue(null);
    mockDocService.listTrackerItems.mockResolvedValue([]);
    mockDocService.setTrackerItemPublished.mockResolvedValue(null);
    mockGlobalRegistry.get.mockReturnValue(undefined);
    mockAwaitServerIssueKey.mockResolvedValue(null);
    vi.mocked(isTrackerSyncActive).mockReturnValue(false);
  });

  it('publishes a draft and returns the one key minted by the server', async () => {
    const draftRow = makeRow({ id: 'bug_draft', workspace: '/tmp/ws', issue_key: null, issue_number: null });
    const draft = rowToTrackerItem(draftRow);
    const keyedRow = { ...draftRow, issue_key: 'NIM-2522', issue_number: 2522 };
    mockDocService.getTrackerItemById.mockResolvedValue(draft);
    mockDocService.setTrackerItemPublished.mockResolvedValue(draft);
    mockAwaitServerIssueKey.mockResolvedValue('NIM-2522');
    mockQuery
      .mockResolvedValueOnce({ rows: [draftRow] })
      .mockResolvedValueOnce({ rows: [keyedRow] });

    const result = await handleTrackerUpdate({ id: 'bug_draft', published: true }, '/tmp/ws');

    expect(result.isError).toBe(false);
    expect(mockDocService.setTrackerItemPublished).toHaveBeenCalledWith('bug_draft', true);
    expect(mockAwaitServerIssueKey).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured).toMatchObject({
      action: 'published',
      issueKey: 'NIM-2522',
      issueKeyStatus: 'assigned',
      published: true,
    });
  });

  it('keeps an existing key unchanged when publication is retried', async () => {
    const keyedRow = makeRow({ id: 'bug_keyed', workspace: '/tmp/ws', issue_key: 'NIM-2521', issue_number: 2521 });
    const keyed = rowToTrackerItem(keyedRow);
    mockDocService.getTrackerItemById.mockResolvedValue(keyed);
    mockDocService.setTrackerItemPublished.mockResolvedValue(keyed);
    mockQuery.mockResolvedValueOnce({ rows: [keyedRow] });

    const result = await handleTrackerUpdate({ id: 'bug_keyed', published: true }, '/tmp/ws');

    expect(result.isError).toBe(false);
    expect(mockAwaitServerIssueKey).not.toHaveBeenCalled();
    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.issueKey).toBe('NIM-2521');
  });

  it('refuses to publish one item from a personal tracker', async () => {
    const personalRow = makeRow({ id: 'bug_personal', workspace: '/tmp/ws', issue_key: null, issue_number: null });
    (mockGlobalRegistry.get as any).mockReturnValue({ sharing: 'personal', draftByDefault: false });
    mockDocService.getTrackerItemById.mockResolvedValue(rowToTrackerItem(personalRow));
    mockQuery.mockResolvedValueOnce({ rows: [personalRow] });

    const result = await handleTrackerUpdate({ id: 'bug_personal', published: true }, '/tmp/ws');

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Promote the tracker');
    expect(mockDocService.setTrackerItemPublished).not.toHaveBeenCalled();
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
    vi.mocked(getEffectiveTrackerSharingPolicy).mockReturnValue({ sharing: 'personal', draftByDefault: false });
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

describe('handleTrackerCreate schema defaults', () => {
  // A plan-shaped model: its status has no 'to-do' option, and planId is a
  // required, non-inline field no MCP caller ever supplies.
  const PLAN_MODEL = {
    type: 'plan',
    fields: [
      { name: 'planId', type: 'string', required: true, displayInline: false },
      { name: 'title', type: 'string', required: true, displayInline: true },
      {
        name: 'status',
        type: 'select',
        required: true,
        default: 'draft',
        options: [{ value: 'draft' }, { value: 'in-development' }, { value: 'completed' }],
      },
    ],
  };

  function setupCreateQueue() {
    const createdRow = makeRow({ id: 'plan_test', type: 'plan', workspace: '/tmp/ws', issue_key: null, issue_number: null });
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // INSERT
      .mockResolvedValueOnce({ rows: [createdRow] }) // resolve created
      .mockResolvedValueOnce({ rows: [createdRow] }); // notifyTrackerItemAdded
  }

  /** The data JSONB handed to the INSERT. */
  function insertedData(): Record<string, any> {
    const insert = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO tracker_items'));
    return JSON.parse(String((insert as any[])[1][3]));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockDocumentServices.clear();
    mockGlobalRegistry.get.mockReturnValue(PLAN_MODEL as any);
    mockGlobalRegistry.validate.mockReturnValue({ valid: true, errors: [] });
  });

  it('defaults status from the schema rather than a hardcoded "to-do"', async () => {
    setupCreateQueue();
    const result = await handleTrackerCreate({ type: 'plan', title: 'A plan' }, '/tmp/ws');
    expect(result.isError).toBe(false);
    expect(insertedData().status).toBe('draft');
  });

  it('honours an explicit status over the schema default', async () => {
    setupCreateQueue();
    await handleTrackerCreate({ type: 'plan', title: 'A plan', status: 'in-development' }, '/tmp/ws');
    expect(insertedData().status).toBe('in-development');
  });

  it('populates a required self-id field no caller supplies', async () => {
    setupCreateQueue();
    await handleTrackerCreate({ type: 'plan', title: 'A plan' }, '/tmp/ws');
    const data = insertedData();
    expect(typeof data.planId).toBe('string');
    expect(data.planId.length).toBeGreaterThan(0);
  });

  it('does not clobber a caller-supplied self-id field', async () => {
    setupCreateQueue();
    await handleTrackerCreate(
      { type: 'plan', title: 'A plan', fields: { planId: 'explicit-id' } },
      '/tmp/ws',
    );
    expect(insertedData().planId).toBe('explicit-id');
  });

  it('leaves inline required fields (title) alone', async () => {
    setupCreateQueue();
    await handleTrackerCreate({ type: 'plan', title: 'A plan' }, '/tmp/ws');
    expect(insertedData().title).toBe('A plan');
  });

  it('falls back to "to-do" when the schema declares no default', async () => {
    mockGlobalRegistry.get.mockReturnValue({
      type: 'task',
      fields: [{ name: 'title', type: 'string', required: true }, { name: 'status', type: 'select' }],
    } as any);
    setupCreateQueue();
    await handleTrackerCreate({ type: 'task', title: 'A task' }, '/tmp/ws');
    expect(insertedData().status).toBe('to-do');
  });
});
