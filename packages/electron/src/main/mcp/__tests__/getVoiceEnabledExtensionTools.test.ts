import { describe, expect, it, vi } from 'vitest';

// mcpWorkspaceResolver imports electron + WindowManager at the top. Mock them so
// the registry helpers can be exercised in a plain node test.
vi.mock('electron', () => ({ BrowserWindow: { fromId: vi.fn(() => null) } }));
vi.mock('../../window/WindowManager', () => ({ findWindowByWorkspace: vi.fn(() => null) }));

// The unknown-workspace path dynamically imports the database init + worktree
// store for worktree resolution. Stub them so the test does not load the whole
// (slow, native-binding) DB module graph -- otherwise it flakes on the 5s
// default timeout under parallel load.
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({}) }));
vi.mock('../../services/WorktreeStore', () => ({
  createWorktreeStore: () => ({ getByPath: async () => null }),
}));

import {
  registerExtensionTools,
  getVoiceEnabledExtensionTools,
  getAvailableExtensionTools,
  type ExtensionToolDefinition,
} from '../mcpWorkspaceResolver';

function tool(name: string, voiceAgent: boolean | undefined): ExtensionToolDefinition {
  return {
    name,
    description: `desc ${name}`,
    inputSchema: { type: 'object', properties: {} },
    extensionId: 'com.test.fixture',
    scope: 'global',
    voiceAgent,
  };
}

describe('getVoiceEnabledExtensionTools', () => {
  it('returns only the voiceAgent-flagged tools for a workspace', async () => {
    const ws = '/tmp/voice-tools-workspace';
    registerExtensionTools(
      ws,
      [tool('memory.search', true), tool('csv.get_schema', false), tool('plans.read', undefined)],
      new Map()
    );

    const voiceTools = await getVoiceEnabledExtensionTools(ws);
    expect(voiceTools.map((t) => t.name)).toEqual(['memory.search']);
  });

  it('returns an empty array for an unknown workspace or undefined path', async () => {
    expect(await getVoiceEnabledExtensionTools('/tmp/never-registered')).toEqual([]);
    expect(await getVoiceEnabledExtensionTools(undefined)).toEqual([]);
  });
});

// #1885: a required filePath on global tools made agents pass a folder as one.
describe('getAvailableExtensionTools filePath injection', () => {
  it('requires filePath only on editor-scoped tools', async () => {
    const ws = '/tmp/filepath-injection-workspace';
    const browser = { ...tool('browser_open_session', undefined), inputSchema: { type: 'object' as const, properties: { url: { type: 'string' } }, required: ['url'] } };
    const sheet = { ...tool('csv.read_range', undefined), scope: 'editor' as const };
    registerExtensionTools(ws, [browser, sheet], new Map());

    const [global, editor] = await getAvailableExtensionTools(ws, undefined);
    expect(global.inputSchema.required).toEqual(['url']);
    expect(global.inputSchema.properties.filePath).toBeDefined();
    expect(editor.inputSchema.required).toEqual(['filePath']);
  });
});
