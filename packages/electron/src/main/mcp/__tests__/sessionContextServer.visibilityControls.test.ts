import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  getMany: vi.fn(),
  list: vi.fn(),
  search: vi.fn(),
  setPinned: vi.fn(),
  setWorkstream: vi.fn(),
  rename: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    get: mocks.get,
    getMany: mocks.getMany,
    list: mocks.list,
    search: mocks.search,
  },
  SessionFilesRepository: { getFilesBySession: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../../services/SessionVisibilityControlService', () => {
  const canonicalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  return {
    canonicalizeSessionWorkspacePath: canonicalize,
    toSessionVisibilityErrorPayload: (error: any) => ({
      ok: false,
      code: error.code ?? 'INTERNAL_ERROR',
      ...(error.auditId && { auditId: error.auditId }),
      ...(error.timestamp && { timestamp: error.timestamp }),
      ...(error.correlationId && { correlationId: error.correlationId }),
    }),
    SessionVisibilityControlService: {
      getInstance: () => ({
        setPinned: mocks.setPinned,
        setWorkstream: mocks.setWorkstream,
        rename: mocks.rename,
      }),
    },
  };
});

vi.mock('../../database/initialize', () => ({
  getDatabase: () => ({ query: mocks.query }),
}));

import {
  SESSION_CONTEXT_TOOL_SCHEMAS,
  deriveHostBoundSessionVisibilityAuthority,
  dispatchHostBoundSessionVisibilityTool,
  dispatchSessionContextTool,
  getSessionVisibilityOpenAITools,
} from '../sessionContextServer';

function storedSession(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    provider: 'claude-code',
    workspacePath: '/repo',
    messages: [],
    title: id,
    createdAt: 1,
    updatedAt: 2,
    isPinned: false,
    parentSessionId: null,
    ...overrides,
  };
}

describe('session-context visibility controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockImplementation(async (id: string) => {
      if (id === 'actor') return storedSession('actor');
      if (id === 'target') return storedSession('target', {
        isPinned: true,
        parentSessionId: 'workstream',
      });
      if (id === 'workstream') return storedSession('workstream', {
        title: 'Release train',
        sessionType: 'workstream',
      });
      if (id === 'cross') return storedSession('cross', { workspacePath: '/other' });
      return null;
    });
    mocks.query.mockResolvedValue({ rows: [] });
  });

  it('declares strict schemas without workspace or authority arguments', () => {
    const schemas = new Map(SESSION_CONTEXT_TOOL_SCHEMAS.map((tool) => [tool.name, tool.inputSchema]));
    expect(Array.from(schemas.keys())).toEqual(expect.arrayContaining([
      'session_set_pinned',
      'session_set_workstream',
      'session_rename',
    ]));
    for (const name of ['session_set_pinned', 'session_set_workstream', 'session_rename']) {
      const schema = schemas.get(name) as any;
      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties).not.toHaveProperty('workspacePath');
      expect(schema.properties).not.toHaveProperty('worktreeId');
      expect(schema.properties).not.toHaveProperty('metadata');
    }
  });

  it('provides extension-agent schemas backed by the same strict visibility definitions', () => {
    const tools = getSessionVisibilityOpenAITools();
    expect(tools.map((tool) => tool.function.name)).toEqual([
      'session_set_pinned',
      'session_set_workstream',
      'session_rename',
    ]);
    for (const tool of tools) {
      expect(tool.function.parameters).toMatchObject({ additionalProperties: false });
    }
  });

  it('derives immutable MCP authority from host state rather than a provider worktree query', () => {
    const authority = deriveHostBoundSessionVisibilityAuthority('actor', {
      workspacePath: '/canonical-repo',
    }, '/provider-worktree');

    expect(authority).toEqual({
      actorSessionId: 'actor',
      workspacePath: '/canonical-repo',
    });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(deriveHostBoundSessionVisibilityAuthority('actor', null)).toBeNull();
  });

  it('preserves the host Windows spelling through production visibility dispatch', async () => {
    mocks.setPinned.mockResolvedValue({ ok: true, operation: 'session_set_pinned' });
    const authority = deriveHostBoundSessionVisibilityAuthority('actor', {
      workspacePath: 'C:\\repo',
    }, 'c:/REPO-worktrees/repair');

    await dispatchHostBoundSessionVisibilityTool(
      'session_set_pinned',
      { sessionId: 'target', pinned: true },
      authority,
    );

    expect(mocks.setPinned).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: 'C:\\repo' }),
      'target',
      true,
    );
  });

  it('dispatches extension-agent visibility calls with immutable host-bound authority', async () => {
    mocks.setPinned.mockResolvedValue({ ok: true, operation: 'session_set_pinned' });
    const authority = Object.freeze({ actorSessionId: 'actor', workspacePath: '/repo' });

    const result = await dispatchHostBoundSessionVisibilityTool(
      'session_set_pinned',
      { sessionId: 'target', pinned: true },
      authority,
    );

    expect(result.isError).toBe(false);
    expect(mocks.setPinned).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSessionId: 'actor',
        workspacePath: '/repo',
        source: 'mcp-host',
      }),
      'target',
      true,
    );
  });

  it('injects actor and canonical workspace context into mutations', async () => {
    mocks.setPinned.mockResolvedValue({ ok: true, operation: 'session_set_pinned' });

    const result = await dispatchSessionContextTool(
      'session_set_pinned',
      { sessionId: 'target', pinned: true },
      'actor',
      '/repo',
    );

    expect(result.isError).toBe(false);
    expect(mocks.setPinned).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSessionId: 'actor',
        workspacePath: '/repo',
        source: 'mcp-host',
        correlationId: expect.any(String),
        requestArgumentsValid: true,
      }),
      'target',
      true,
    );
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: true });
  });

  it('marks unknown properties invalid before the service can mutate', async () => {
    mocks.setPinned.mockImplementation(async (serviceContext: any) => {
      if (!serviceContext.requestArgumentsValid) {
        throw { code: 'INVALID_ARGUMENT' };
      }
      return { ok: true };
    });

    const result = await dispatchSessionContextTool(
      'session_set_pinned',
      { sessionId: 'target', pinned: true, workspacePath: '/other' },
      'actor',
      '/repo',
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: false,
      code: 'INVALID_ARGUMENT',
    });
    expect(mocks.setPinned).toHaveBeenCalledWith(
      expect.objectContaining({ requestArgumentsValid: false, workspacePath: '/repo' }),
      'target',
      true,
    );
  });

  it('returns stable redacted service errors as JSON', async () => {
    mocks.setPinned.mockRejectedValue(Object.assign(new Error('do not expose /secret/path'), {
      code: 'TARGET_NOT_FOUND',
      auditId: 'sv-1',
      timestamp: '2026-07-19T00:00:00.000Z',
      correlationId: 'correlation-1',
    }));

    const result = await dispatchSessionContextTool(
      'session_set_pinned',
      { sessionId: 'target', pinned: true },
      'actor',
      '/repo',
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: false,
      code: 'TARGET_NOT_FOUND',
      auditId: 'sv-1',
      timestamp: '2026-07-19T00:00:00.000Z',
      correlationId: 'correlation-1',
    });
    expect(result.content[0].text).not.toContain('/secret/path');
  });

  it('adds pinned and stable workstream identity to authorized summary reads', async () => {
    const result = await dispatchSessionContextTool(
      'get_session_summary',
      { sessionId: 'target' },
      'actor',
      '/repo',
    );

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('Pinned: yes');
    expect(result.content[0].text).toContain('Workstream: "Release train" (workstream)');
  });

  it('does not enumerate arbitrary cross-workspace reads', async () => {
    const missing = await dispatchSessionContextTool(
      'get_session_summary',
      { sessionId: 'missing' },
      'actor',
      '/repo',
    );
    const cross = await dispatchSessionContextTool(
      'get_session_summary',
      { sessionId: 'cross' },
      'actor',
      '/repo',
    );

    expect(missing).toEqual(cross);
    expect(missing.content[0].text).toContain('TARGET_NOT_FOUND');
    expect(missing.content[0].text).not.toContain('missing');
  });

  it('does not disclose a cross-workspace parent title in recent-session reads', async () => {
    mocks.list.mockResolvedValue([
      storedSession('target', { parentSessionId: 'foreign-parent' }),
    ]);
    mocks.getMany.mockResolvedValue([
      storedSession('foreign-parent', {
        workspacePath: '/other',
        title: 'Secret foreign workstream',
        sessionType: 'workstream',
      }),
    ]);

    const result = await dispatchSessionContextTool(
      'list_recent_sessions',
      {},
      'actor',
      '/repo',
    );

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('Workstream: foreign-parent (title unavailable)');
    expect(result.content[0].text).not.toContain('Secret foreign workstream');
  });
});
