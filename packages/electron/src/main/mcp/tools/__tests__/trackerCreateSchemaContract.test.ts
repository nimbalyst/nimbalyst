// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Contract tests for tracker_create against the REAL builtin tracker schemas
 * (packages/runtime .../models/builtins/*.yaml) and the real registry
 * validator — no mocked globalRegistry. This pins the promise that the MCP
 * create path can create every creatable builtin type with only the arguments
 * the tool's own docs (docs/TRACKER_WORKFLOWS.md) tell agents to pass:
 * - the initial status comes from the schema's own `default`, not a
 *   hardcoded "to-do" (plan defaults to 'draft', idea to 'new');
 * - required non-inline self-id fields (plan.planId, decision.decisionId)
 *   are populated instead of failing validation.
 */

const { mockQuery, mockDocumentServices } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockDocumentServices: new Map<string, any>(),
}));

vi.mock('../../../database/initialize', () => ({
  getDatabase: () => ({
    query: mockQuery,
    runTransaction: async (statements: Array<{ sql: string; params: unknown[] }>) => { for (const statement of statements) await mockQuery(statement.sql, statement.params); },
    getEngine: vi.fn(() => 'pglite'),
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
  isTrackerSyncConfigured: vi.fn(() => false),
  syncTrackerItem: vi.fn(),
}));

vi.mock('../../../services/TrackerSchemaService', () => ({
  getTrackerRoleField: vi.fn(() => null),
  ensureWorkspaceTrackerSchemasLoaded: vi.fn(),
}));

vi.mock('../../../utils/store', () => ({
  getWorkspaceState: vi.fn(() => ({ issueKeyPrefix: 'NIM' })),
  isAnalyticsEnabled: vi.fn(() => true),
}));

vi.mock('../../../window/WindowManager', () => ({
  findWindowByWorkspace: vi.fn(() => null),
  documentServices: mockDocumentServices,
}));

vi.mock('../../../services/MainBodyDocService', () => ({
  applyHeadlessBodyMarkdown: vi.fn(async () => undefined),
}));

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../../test-stubs/privateUserData')).testApp.getPath,
    isPackaged: false,
    getName: vi.fn(() => 'Nimbalyst'),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { handleTrackerCreate } from '../trackerToolHandlers';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/ModelLoader';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item_test',
    issue_key: null,
    issue_number: null,
    type: 'task',
    type_tags: ['task'],
    data: JSON.stringify({ title: 'x', status: 'to-do', priority: 'medium' }),
    updated: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}

function setupCreateQueue(type: string, hasDescription = false) {
  const createdRow = makeRow({ id: `${type}_test`, type, type_tags: [type], workspace: '/tmp/ws' });
  mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT item
  if (hasDescription) mockQuery.mockResolvedValueOnce({ rows: [] }); // cache in same transaction
  mockQuery.mockResolvedValueOnce({ rows: [createdRow] }); // resolve created
  mockQuery.mockResolvedValueOnce({ rows: [createdRow] }); // notify

}

/** The data JSONB handed to the INSERT. */
function insertedData(): Record<string, any> {
  const insert = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO tracker_items'));
  expect(insert, 'expected an INSERT INTO tracker_items call').toBeTruthy();
  return JSON.parse(String((insert as any[])[1][3]));
}

beforeAll(() => {
  loadBuiltinTrackers();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockDocumentServices.clear();
});

describe('tracker_create honors the builtin schema contract (real schemas)', () => {
  it('creates a decision with exactly the docs/TRACKER_WORKFLOWS.md arguments', async () => {
    setupCreateQueue('decision', true);
    // Verbatim shape from docs/TRACKER_WORKFLOWS.md "Decision Tracking".
    const result = await handleTrackerCreate(
      {
        type: 'decision',
        title: 'Use library X over Y',
        priority: 'medium',
        labels: ['extensions'],
        description: '## Context\nwhy\n\n## Reasoning\nbecause',
      },
      '/tmp/ws',
    );
    expect(result.isError).toBe(false);
    const data = insertedData();
    expect(typeof data.decisionId).toBe('string');
    expect(data.decisionId.length).toBeGreaterThan(0);
  });

  it('creates a plan with title only, defaulting status to the schema default', async () => {
    setupCreateQueue('plan');
    const result = await handleTrackerCreate({ type: 'plan', title: 'A plan' }, '/tmp/ws');
    expect(result.isError).toBe(false);
    const data = insertedData();
    expect(data.status).toBe('draft');
    expect(typeof data.planId).toBe('string');
  });

  it('creates an idea with the schema default status, not an out-of-schema "to-do"', async () => {
    setupCreateQueue('idea');
    const result = await handleTrackerCreate({ type: 'idea', title: 'An idea' }, '/tmp/ws');
    expect(result.isError).toBe(false);
    const model = globalRegistry.get('idea');
    const statusOptions = model?.fields.find((f) => f.name === 'status')?.options?.map((o) => o.value) ?? [];
    expect(insertedData().status).toBe('new');
    expect(statusOptions).toContain(insertedData().status);
  });

  it('still creates a task with status to-do', async () => {
    setupCreateQueue('task');
    const result = await handleTrackerCreate({ type: 'task', title: 'A task' }, '/tmp/ws');
    expect(result.isError).toBe(false);
    expect(insertedData().status).toBe('to-do');
  });
});
