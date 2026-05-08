import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery, mockUpsertWorkspaceTrackerSchema, mockDeleteWorkspaceTrackerSchema, mockGetAllTrackerSchemas, mockIsBuiltinTrackerSchema, mockGlobalRegistry } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockUpsertWorkspaceTrackerSchema: vi.fn(),
  mockDeleteWorkspaceTrackerSchema: vi.fn(),
  mockGetAllTrackerSchemas: vi.fn((): any[] => []),
  mockIsBuiltinTrackerSchema: vi.fn(() => false),
  mockGlobalRegistry: {
    get: vi.fn(() => undefined),
    validate: vi.fn(() => ({ valid: true, errors: [] as Array<{ field: string; message: string }> })),
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

vi.mock('../../../services/TrackerSchemaService', () => ({
  getTrackerRoleField: vi.fn(() => null),
  upsertWorkspaceTrackerSchema: mockUpsertWorkspaceTrackerSchema,
  deleteWorkspaceTrackerSchema: mockDeleteWorkspaceTrackerSchema,
  getAllTrackerSchemas: mockGetAllTrackerSchemas,
  isBuiltinTrackerSchema: mockIsBuiltinTrackerSchema,
}));

vi.mock('../../../utils/store', () => ({
  getWorkspaceState: vi.fn(() => ({ issueKeyPrefix: 'NIM' })),
}));

vi.mock('../../../window/WindowManager', () => ({
  findWindowByWorkspace: vi.fn(() => null),
  documentServices: new Map(),
}));

vi.mock('@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel', () => ({
  globalRegistry: mockGlobalRegistry,
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import {
  handleTrackerCreate,
  handleTrackerDefineType,
  handleTrackerDeleteType,
  handleTrackerGet,
  handleTrackerLinkSession,
  handleTrackerListTypes,
  handleTrackerUnlinkSession,
  handleTrackerUpdate,
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

describe('handleTrackerGet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scopes issue key lookups to the active workspace', async () => {
    mockQuery.mockResolvedValue({
      rows: [makeRow({ workspace: '/tmp/workspace-a' })],
    });

    const result = await handleTrackerGet({ id: 'NIM-1' }, '/tmp/workspace-a');

    expect(result.isError).toBe(false);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE (id = $1 OR issue_key = $1) AND workspace = $2'),
      ['NIM-1', '/tmp/workspace-a'],
    );
  });
});

describe('tracker schema tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      { fileName: undefined },
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
});

describe('handleTrackerUnlinkSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      .mockResolvedValueOnce({ rows: [] })                                    // UPDATE tracker_items SET content
      .mockResolvedValueOnce({ rows: [trackerRow] })                          // notifyTrackerItemUpdated read
      .mockResolvedValueOnce({ rows: [trackerRow] })                          // refreshedRow read for sync block
      .mockResolvedValueOnce({ rows: [trackerRow] })                          // postSyncRow read
      .mockResolvedValueOnce({ rows: [{ type_tags: ['bug'] }] });             // re-read type_tags
    return trackerRow;
  }

  function setupUpdateQueueNoContentWrite() {
    // Same as above but no SET content step (collab path skips it)
    const trackerRow = makeRow({
      id: 'bug_target',
      workspace: '/tmp/ws',
      source: 'native',
      document_path: '',
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [trackerRow] })                          // resolveTrackerRowByReference (initial)
      .mockResolvedValueOnce({ rows: [] })                                    // UPDATE tracker_items SET data
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
      (c) => /UPDATE tracker_items SET content/.test(String(c[0])),
    );
    expect(updateContentCalls).toHaveLength(1);

    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.skippedFields).toBeUndefined();
    expect(payload.structured.changes.description).toEqual({ from: undefined, to: 'New body text' });
  });

  it('refuses description writes for collab native items and skips the content column update', async () => {
    vi.mocked(getEffectiveTrackerSyncPolicy).mockReturnValue({ mode: 'shared', scope: 'project' });
    vi.mocked(shouldSyncTrackerPolicy).mockReturnValue(true);
    vi.mocked(isTrackerSyncActive).mockReturnValue(true);
    setupUpdateQueueNoContentWrite();

    const result = await handleTrackerUpdate(
      { id: 'NIM-1', description: 'AI-authored body' },
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    const updateContentCalls = mockQuery.mock.calls.filter(
      (c) => /UPDATE tracker_items SET content/.test(String(c[0])),
    );
    expect(updateContentCalls).toHaveLength(0);

    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.skippedFields?.description).toMatch(/collaborative Y\.Doc/);
    expect(payload.structured.changes.description).toBeUndefined();
    expect(payload.summary).toMatch(/Description.*NOT applied/);
  });

  it('still applies non-body field updates when description is refused for a collab item', async () => {
    vi.mocked(getEffectiveTrackerSyncPolicy).mockReturnValue({ mode: 'shared', scope: 'project' });
    vi.mocked(shouldSyncTrackerPolicy).mockReturnValue(true);
    vi.mocked(isTrackerSyncActive).mockReturnValue(true);
    setupUpdateQueueNoContentWrite();

    const result = await handleTrackerUpdate(
      { id: 'NIM-1', description: 'AI body', status: 'in-progress', priority: 'high' },
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.changes.status).toEqual({ from: 'to-do', to: 'in-progress' });
    expect(payload.structured.changes.priority).toEqual({ from: 'high', to: 'high' });
    expect(payload.structured.changes.description).toBeUndefined();
    expect(payload.structured.skippedFields?.description).toBeDefined();
  });

  it('also blocks description set via the generic fields bag for collab items', async () => {
    vi.mocked(getEffectiveTrackerSyncPolicy).mockReturnValue({ mode: 'shared', scope: 'project' });
    vi.mocked(shouldSyncTrackerPolicy).mockReturnValue(true);
    vi.mocked(isTrackerSyncActive).mockReturnValue(true);
    setupUpdateQueueNoContentWrite();

    const result = await handleTrackerUpdate(
      { id: 'NIM-1', fields: { description: 'sneaky body via fields' } },
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.changes.description).toBeUndefined();
    expect(payload.structured.skippedFields?.description).toBeDefined();
  });

  it('does NOT refuse description for inline / file-backed items even when sync is active', async () => {
    // Inline tracker item (frontmatter or marker) keeps its body in the
    // source file, not Y.Doc. The collab body bug doesn't apply.
    vi.mocked(getEffectiveTrackerSyncPolicy).mockReturnValue({ mode: 'shared', scope: 'project' });
    vi.mocked(shouldSyncTrackerPolicy).mockReturnValue(true);
    vi.mocked(isTrackerSyncActive).mockReturnValue(true);
    setupUpdateQueueWithDescription({ source: 'frontmatter', document_path: 'design/foo.md' });

    const result = await handleTrackerUpdate(
      { id: 'NIM-1', description: 'updated body' },
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.skippedFields).toBeUndefined();
    expect(payload.structured.changes.description).toEqual({ from: undefined, to: 'updated body' });
  });

  it('does NOT refuse description when tracker sync is inactive (no team plumbing in this process)', async () => {
    vi.mocked(getEffectiveTrackerSyncPolicy).mockReturnValue({ mode: 'shared', scope: 'project' });
    vi.mocked(shouldSyncTrackerPolicy).mockReturnValue(true);
    vi.mocked(isTrackerSyncActive).mockReturnValue(false);
    setupUpdateQueueWithDescription();

    const result = await handleTrackerUpdate(
      { id: 'NIM-1', description: 'body while sync is offline' },
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.skippedFields).toBeUndefined();
    expect(payload.structured.changes.description).toEqual({ from: undefined, to: 'body while sync is offline' });
  });
});
