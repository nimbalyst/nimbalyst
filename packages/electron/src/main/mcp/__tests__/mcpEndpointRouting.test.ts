import { describe, it, expect } from 'vitest';
import {
  isMcpEndpoint,
  resolveMcpEndpoint,
  extensionShortNameFromId,
  selectFirstPartyToolsForEndpoint,
  selectExtensionToolsForEndpoint,
  applyCoreAlwaysLoadMeta,
} from '../mcpEndpointRouting';
import {
  MCP_CORE,
  MCP_TRACKERS,
  MCP_SITUATIONAL,
} from '@nimbalyst/runtime/ai/server';

describe('mcpEndpointRouting', () => {
  describe('isMcpEndpoint', () => {
    it('matches /mcp and /mcp/* but not lookalikes', () => {
      expect(isMcpEndpoint('/mcp')).toBe(true);
      expect(isMcpEndpoint('/mcp/core')).toBe(true);
      expect(isMcpEndpoint('/mcp/ext/excalidraw')).toBe(true);
      expect(isMcpEndpoint('/mcpfoo')).toBe(false);
      expect(isMcpEndpoint('/permission')).toBe(false);
      expect(isMcpEndpoint('/clip')).toBe(false);
      expect(isMcpEndpoint(null)).toBe(false);
      expect(isMcpEndpoint(undefined)).toBe(false);
    });
  });

  describe('resolveMcpEndpoint', () => {
    it('maps the legacy path to the full surface', () => {
      expect(resolveMcpEndpoint('/mcp')).toEqual({ kind: 'legacy' });
    });

    it('maps first-party endpoint paths to their config-keys', () => {
      expect(resolveMcpEndpoint('/mcp/core')).toEqual({ kind: 'firstParty', configKey: MCP_CORE });
      expect(resolveMcpEndpoint('/mcp/trackers')).toEqual({ kind: 'firstParty', configKey: MCP_TRACKERS });
      expect(resolveMcpEndpoint('/mcp/situational')).toEqual({ kind: 'firstParty', configKey: MCP_SITUATIONAL });
    });

    it('maps per-extension endpoints to their short-name', () => {
      expect(resolveMcpEndpoint('/mcp/ext/excalidraw')).toEqual({
        kind: 'extension',
        extensionShortName: 'excalidraw',
      });
    });

    it('falls back to legacy for unknown /mcp/<x> and bare /mcp/ext/', () => {
      expect(resolveMcpEndpoint('/mcp/does-not-exist')).toEqual({ kind: 'legacy' });
      expect(resolveMcpEndpoint('/mcp/ext/')).toEqual({ kind: 'legacy' });
    });

    it('returns null for non-mcp paths', () => {
      expect(resolveMcpEndpoint('/clip')).toBeNull();
      expect(resolveMcpEndpoint('/permission')).toBeNull();
    });
  });

  describe('extensionShortNameFromId', () => {
    it('takes the last dotted segment', () => {
      expect(extensionShortNameFromId('com.nimbalyst.excalidraw')).toBe('excalidraw');
      expect(extensionShortNameFromId('slides')).toBe('slides');
    });
  });

  describe('selectFirstPartyToolsForEndpoint', () => {
    const builtIn = [
      { name: 'display_to_user' },
      { name: 'capture_editor_screenshot' },
      { name: 'AskUserQuestion' },
      { name: 'tracker_create' },
      { name: 'tracker_list' },
      { name: 'voice_agent_speak' },
      { name: 'open_workspace' }, // retired — maps to no first-party server
    ];

    it('selects only the core subset for the core endpoint', () => {
      const core = selectFirstPartyToolsForEndpoint(builtIn, MCP_CORE).map((t) => t.name);
      expect(core).toContain('display_to_user');
      expect(core).toContain('capture_editor_screenshot');
      expect(core).toContain('AskUserQuestion');
      expect(core).not.toContain('tracker_create');
      expect(core).not.toContain('voice_agent_speak');
    });

    it('selects only tracker tools for the tracker endpoint', () => {
      const trackers = selectFirstPartyToolsForEndpoint(builtIn, MCP_TRACKERS).map((t) => t.name);
      expect(trackers.sort()).toEqual(['tracker_create', 'tracker_list']);
    });

    it('excludes retired tools (open_workspace) from every first-party endpoint', () => {
      for (const key of [MCP_CORE, MCP_TRACKERS, MCP_SITUATIONAL]) {
        const names = selectFirstPartyToolsForEndpoint(builtIn, key).map((t) => t.name);
        expect(names).not.toContain('open_workspace');
      }
    });
  });

  describe('selectExtensionToolsForEndpoint', () => {
    it('filters tools to a single extension by short-name', () => {
      const tools = [
        { extensionId: 'com.nimbalyst.excalidraw', name: 'excalidraw.add_rectangle' },
        { extensionId: 'com.nimbalyst.excalidraw', name: 'excalidraw.get_elements' },
        { extensionId: 'com.nimbalyst.slides', name: 'slides.add_slide' },
      ];
      const result = selectExtensionToolsForEndpoint(tools, 'excalidraw').map((t) => t.name);
      expect(result).toEqual(['excalidraw.add_rectangle', 'excalidraw.get_elements']);
    });
  });

  describe('applyCoreAlwaysLoadMeta', () => {
    const coreTools = [
      { name: 'AskUserQuestion', description: 'ask', inputSchema: {} },
      { name: 'PromptForUserInput', description: 'prompt', inputSchema: {} },
      { name: 'developer_git_commit_proposal', description: 'commit', inputSchema: {} },
      { name: 'get_session_edited_files', description: 'files', inputSchema: {} },
      { name: 'update_session_meta', description: 'meta', inputSchema: {} },
      { name: 'display_to_user', description: 'display', inputSchema: {} },
      { name: 'capture_editor_screenshot', description: 'shot', inputSchema: {} },
    ];

    it('marks the always-load subset of core tools with anthropic/alwaysLoad', () => {
      const result = applyCoreAlwaysLoadMeta(coreTools, MCP_CORE);
      const metaByName = new Map(result.map((t) => [t.name, (t as { _meta?: Record<string, unknown> })._meta]));

      // The visual-output tools are eager: the prompt tells the model to use
      // them, so their schemas must be in context (NIM-1766).
      for (const eager of [
        'AskUserQuestion',
        'PromptForUserInput',
        'developer_git_commit_proposal',
        'get_session_edited_files',
        'update_session_meta',
        'display_to_user',
        'capture_editor_screenshot',
      ]) {
        expect(metaByName.get(eager)).toEqual({ 'anthropic/alwaysLoad': true });
      }
    });

    it('leaves non-core endpoints untouched', () => {
      const trackerTools = [{ name: 'tracker_list', description: 'list', inputSchema: {} }];
      const result = applyCoreAlwaysLoadMeta(trackerTools, MCP_TRACKERS);
      expect(result).toEqual(trackerTools);
      expect((result[0] as { _meta?: unknown })._meta).toBeUndefined();
    });
  });
});
