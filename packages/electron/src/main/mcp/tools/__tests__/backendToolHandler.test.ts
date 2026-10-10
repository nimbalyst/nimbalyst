/**
 * Unit test for backend tool execution routing. Confirms `handleBackendTool`
 * resolves a registered tool and routes the call to the backend module's RPC
 * method via PrivilegedExtensionHost.request (no renderer hop), serializing the
 * result. The host singleton is mocked so no real module/electron is needed.
 *
 * Run from repo root:
 *   npx vitest --run packages/electron/src/main/mcp/tools/__tests__/backendToolHandler.test.ts
 */
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();
vi.mock('../../../extensions/PrivilegedExtensionHost', () => ({
  getPrivilegedExtensionHost: () => ({ request: requestMock }),
}));
const getSessionMock = vi.fn();
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: (id: string) => getSessionMock(id) },
}));

import { filterBackendToolsForSession, handleBackendTool, isBackendTool } from '../backendToolHandler';
import {
  registerBackendTools,
  getBackendTools,
  getVoiceEnabledBackendTools,
  findOwnedBackendTool,
  _resetBackendToolRegistry,
} from '../../backendToolRegistry';

const WS = '/ws/project';
const EXT = 'com.nimbalyst.memory';
const MOD = 'memory-engine';

beforeEach(() => {
  vi.clearAllMocks();
  _resetBackendToolRegistry();
  registerBackendTools(WS, EXT, MOD, [
    {
      name: 'search_project_knowledge',
      description: 'search',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      voiceAgent: true,
    },
    { name: 'roster', description: 'panel data', panelOnly: true, voiceAgent: true },
  ]);
});

const AGENT_CALL = { sessionId: null, caller: 'agent' as const };

afterEach(() => {
  _resetBackendToolRegistry();
});

describe('handleBackendTool', () => {
  it('routes a registered tool to the module RPC method and serializes the result', async () => {
    requestMock.mockResolvedValue({ chunks: [{ text: 'hit', source: 'design/x.md' }] });

    const result = await handleBackendTool(
      'memory.search_project_knowledge',
      'memory.search_project_knowledge',
      { query: 'voice grounding' },
      WS,
      AGENT_CALL
    );

    // Routed to the backend module via request() with method = raw name.
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith({
      extensionId: EXT,
      moduleId: MOD,
      workspacePath: WS,
      method: 'search_project_knowledge',
      params: { query: 'voice grounding' },
      requiredPermission: null,
      callContext: { sessionId: null, workspacePath: WS, sessionOwner: null, caller: 'agent' },
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('"source": "design/x.md"');
  });

  it('resolves the sanitized (underscore) tool name too', async () => {
    requestMock.mockResolvedValue('ok');
    const result = await handleBackendTool(
      'memory_search_project_knowledge',
      'memory_search_project_knowledge',
      {},
      WS,
      AGENT_CALL
    );
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'search_project_knowledge' })
    );
    expect(result.content[0].text).toBe('ok');
  });

  it('returns isError for an unknown tool name', async () => {
    await expect(handleBackendTool('memory.nope', 'memory.nope', {}, WS, AGENT_CALL)).rejects.toThrow(
      /Unknown tool/
    );
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('surfaces a backend error as an error result, not a throw', async () => {
    requestMock.mockRejectedValue(new Error('module not running'));
    const result = await handleBackendTool(
      'memory.search_project_knowledge',
      'memory.search_project_knowledge',
      { query: 'x' },
      WS,
      AGENT_CALL
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('module not running');
  });

  it('isBackendTool reflects registry membership', () => {
    expect(isBackendTool('memory.search_project_knowledge', WS)).toBe(true);
    expect(isBackendTool('memory.search_project_knowledge', '/other')).toBe(false);
    expect(isBackendTool('nope', WS)).toBe(false);
  });

  it('tells the handler which session called, and its owner only when this extension owns it', async () => {
    requestMock.mockResolvedValue('ok');
    const owner = { extensionId: EXT, key: 'ada' };
    getSessionMock.mockImplementation(async (id: string) =>
      id === 'owned' ? { id, metadata: { sessionOwner: owner } }
        : id === 'foreign' ? { id, metadata: { sessionOwner: { extensionId: 'com.other', key: 'x' } } }
        : { id, metadata: {} });

    for (const [sessionId, expectedOwner] of [['owned', owner], ['foreign', null], ['plain', null]] as const) {
      requestMock.mockClear();
      await handleBackendTool('memory.search_project_knowledge', 'memory.search_project_knowledge', {}, WS, {
        sessionId,
        caller: 'agent',
      });
      expect(requestMock.mock.calls[0][0].callContext).toEqual({
        sessionId,
        workspacePath: WS,
        sessionOwner: expectedOwner,
        caller: 'agent',
      });
    }
  });

  it('keeps panel-only tools off the agent surface and rejects agent calls to them', async () => {
    requestMock.mockResolvedValue({ members: [] });
    expect(getBackendTools(WS).map((t) => t.name)).toEqual(['memory.search_project_knowledge']);
    expect(getVoiceEnabledBackendTools(WS).map((t) => t.name)).toEqual(['memory.search_project_knowledge']);
    expect(isBackendTool('memory.roster', WS)).toBe(false);
    await expect(handleBackendTool('memory.roster', 'memory.roster', {}, WS, AGENT_CALL)).rejects.toThrow(
      /Unknown tool/
    );
    expect(requestMock).not.toHaveBeenCalled();

    // The extension's own panel still reaches it.
    expect(findOwnedBackendTool(WS, 'memory.roster', EXT)?.method).toBe('roster');
    const result = await handleBackendTool('memory.roster', 'memory.roster', {}, WS, {
      sessionId: null,
      caller: 'panel',
      extensionId: EXT,
    });
    expect(result.isError).toBe(false);
    expect(requestMock.mock.calls[0][0].method).toBe('roster');
  });

  it("lists and runs an 'owned-sessions' tool only for sessions this extension owns", async () => {
    registerBackendTools(WS, EXT, 'owned-mod', [
      { name: 'wake_me', description: 'owned only', audience: 'owned-sessions', voiceAgent: true },
    ]);
    requestMock.mockResolvedValue('ok');
    getSessionMock.mockImplementation(async (id: string) =>
      id === 'owned' ? { id, metadata: { sessionOwner: { extensionId: EXT, key: 'ada' } } }
        : id === 'foreign' ? { id, metadata: { sessionOwner: { extensionId: 'com.other', key: 'x' } } }
        : { id, metadata: {} });

    const listed = async (sessionId: string | undefined) =>
      (await filterBackendToolsForSession(getBackendTools(WS), sessionId)).map((t) => t.name);
    expect(await listed('owned')).toEqual(['memory.search_project_knowledge', 'memory.wake_me']);
    for (const sessionId of ['foreign', 'plain', undefined]) {
      expect(await listed(sessionId)).toEqual(['memory.search_project_knowledge']);
    }
    expect(getVoiceEnabledBackendTools(WS).map((t) => t.name)).toEqual(['memory.search_project_knowledge']);

    for (const call of [
      { sessionId: 'plain', caller: 'agent' as const },
      { sessionId: 'foreign', caller: 'agent' as const },
      { sessionId: null, caller: 'voice' as const },
    ]) {
      await expect(handleBackendTool('memory.wake_me', 'memory.wake_me', {}, WS, call)).rejects.toThrow(
        /Unknown tool/
      );
    }
    expect(requestMock).not.toHaveBeenCalled();

    const result = await handleBackendTool('memory.wake_me', 'memory.wake_me', {}, WS, {
      sessionId: 'owned',
      caller: 'agent',
    });
    expect(result.isError).toBe(false);
    expect(requestMock.mock.calls[0][0].callContext.sessionOwner).toEqual({ extensionId: EXT, key: 'ada' });
  });
});
