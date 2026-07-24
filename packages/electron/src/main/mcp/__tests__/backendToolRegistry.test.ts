/**
 * Unit tests for the backend MCP tool registry (the catalog of tools a backend
 * module contributes via the `registerMcpTools` broker). Pure, no electron.
 *
 * Run from repo root:
 *   npx vitest --run packages/electron/src/main/mcp/__tests__/backendToolRegistry.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerBackendTools,
  clearBackendTools,
  clearBackendToolsForModule,
  getBackendTools,
  getVoiceEnabledBackendTools,
  findBackendTool,
  findOwnedBackendTool,
  setBackendToolsChangeNotifier,
  _resetBackendToolRegistry,
} from '../backendToolRegistry';

const WS = '/ws/project';
const EXT = 'com.nimbalyst.memory';
const MOD = 'memory-engine';

afterEach(() => {
  _resetBackendToolRegistry();
});

describe('backendToolRegistry', () => {
  it('registers tools namespaced by extension short-name and maps advertised name -> backend method', () => {
    const registered = registerBackendTools(WS, EXT, MOD, [
      {
        name: 'search_project_knowledge',
        description: 'search',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        voiceAgent: true,
      },
      { name: 'status', description: 'status' },
    ]);

    // Advertised names are namespaced with the extension short-name.
    expect(registered).toEqual(['memory.search_project_knowledge', 'memory.status']);

    const tools = getBackendTools(WS);
    expect(tools).toHaveLength(2);

    const search = tools.find((t) => t.name === 'memory.search_project_knowledge')!;
    expect(search.method).toBe('search_project_knowledge'); // backend RPC method = raw name
    expect(search.extensionId).toBe(EXT);
    expect(search.moduleId).toBe(MOD);
    expect(search.voiceAgent).toBe(true);
    expect(search.scope).toBe('global');
    expect(search.inputSchema).toEqual({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    });

    // status didn't opt into voice and has a normalized empty schema.
    const status = tools.find((t) => t.name === 'memory.status')!;
    expect(status.voiceAgent).toBe(false);
    expect(status.inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('filters voice-enabled tools', () => {
    registerBackendTools(WS, EXT, MOD, [
      { name: 'search', voiceAgent: true },
      { name: 'index', voiceAgent: false },
      { name: 'recall', voiceAgent: true },
    ]);
    const voice = getVoiceEnabledBackendTools(WS).map((t) => t.method).sort();
    expect(voice).toEqual(['recall', 'search']);
  });

  it('re-registration replaces the same module\'s prior tools (idempotent, no stale)', () => {
    registerBackendTools(WS, EXT, MOD, [{ name: 'a' }, { name: 'b' }]);
    registerBackendTools(WS, EXT, MOD, [{ name: 'a' }]);
    expect(getBackendTools(WS).map((t) => t.method)).toEqual(['a']);
  });

  it('keeps tools from a different module in the same workspace', () => {
    registerBackendTools(WS, EXT, MOD, [{ name: 'a' }]);
    registerBackendTools(WS, 'com.other.ext', 'mod2', [{ name: 'b' }]);
    clearBackendTools(WS, EXT, MOD);
    const remaining = getBackendTools(WS);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('ext.b');
  });

  it('findBackendTool resolves both the dotted name and its sanitized (underscore) form', () => {
    registerBackendTools(WS, EXT, MOD, [{ name: 'search_project_knowledge' }]);
    expect(findBackendTool(WS, 'memory.search_project_knowledge')?.method).toBe(
      'search_project_knowledge'
    );
    // Providers that disallow dots sanitize "memory.x" -> "memory_x".
    expect(findBackendTool(WS, 'memory_search_project_knowledge')?.method).toBe(
      'search_project_knowledge'
    );
    expect(findBackendTool(WS, 'nope')).toBeUndefined();
  });

  it('findOwnedBackendTool scopes the renderer bridge to the calling extension', () => {
    // Two extensions each register a backend tool in the same workspace.
    registerBackendTools(WS, EXT, MOD, [{ name: 'delete_fact' }]);
    registerBackendTools(WS, 'com.other.ext', 'mod2', [{ name: 'peek' }]);

    // Owner can reach its own tool (dotted and sanitized forms).
    expect(findOwnedBackendTool(WS, 'memory.delete_fact', EXT)?.method).toBe('delete_fact');
    expect(findOwnedBackendTool(WS, 'memory_delete_fact', EXT)?.method).toBe('delete_fact');

    // A different extension cannot reach memory's tool even knowing the name.
    expect(findOwnedBackendTool(WS, 'memory.delete_fact', 'com.other.ext')).toBeUndefined();

    // And memory cannot reach the other extension's tool.
    expect(findOwnedBackendTool(WS, 'ext.peek', EXT)).toBeUndefined();

    // Unknown tool is undefined regardless of caller.
    expect(findOwnedBackendTool(WS, 'memory.nope', EXT)).toBeUndefined();
  });

  it('clearBackendToolsForModule removes the module across all workspaces', () => {
    registerBackendTools('/ws/a', EXT, MOD, [{ name: 'x' }]);
    registerBackendTools('/ws/b', EXT, MOD, [{ name: 'y' }]);
    clearBackendToolsForModule(EXT, MOD);
    expect(getBackendTools('/ws/a')).toHaveLength(0);
    expect(getBackendTools('/ws/b')).toHaveLength(0);
  });

  it('fires the change notifier on register and clear', () => {
    const notifier = vi.fn();
    setBackendToolsChangeNotifier(notifier);
    registerBackendTools(WS, EXT, MOD, [{ name: 'a' }]);
    clearBackendTools(WS, EXT, MOD);
    expect(notifier).toHaveBeenCalledTimes(2);
    expect(notifier).toHaveBeenCalledWith(WS);
  });
});
