/**
 * Unit test for backend tool execution routing. Confirms `handleBackendTool`
 * resolves a registered tool and routes the call to the backend module's RPC
 * method via PrivilegedExtensionHost.request (no renderer hop), serializing the
 * result. The host singleton is mocked so no real module/electron is needed.
 *
 * Run from repo root:
 *   npx vitest --run packages/electron/src/main/mcp/tools/__tests__/backendToolHandler.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();
vi.mock('../../../extensions/PrivilegedExtensionHost', () => ({
  getPrivilegedExtensionHost: () => ({ request: requestMock }),
}));

import { handleBackendTool, isBackendTool } from '../backendToolHandler';
import {
  registerBackendTools,
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
  ]);
});

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
      WS
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
      WS
    );
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'search_project_knowledge' })
    );
    expect(result.content[0].text).toBe('ok');
  });

  it('returns isError for an unknown tool name', async () => {
    await expect(handleBackendTool('memory.nope', 'memory.nope', {}, WS)).rejects.toThrow(
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
      WS
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('module not running');
  });

  it('isBackendTool reflects registry membership', () => {
    expect(isBackendTool('memory.search_project_knowledge', WS)).toBe(true);
    expect(isBackendTool('memory.search_project_knowledge', '/other')).toBe(false);
    expect(isBackendTool('nope', WS)).toBe(false);
  });
});
