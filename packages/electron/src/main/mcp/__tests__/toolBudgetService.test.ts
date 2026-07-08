import { describe, it, expect, vi } from 'vitest';
import { MCP_CORE, MCP_TRACKERS } from '@nimbalyst/runtime/ai/server';

vi.mock('../../utils/store', () => ({
  isSettingsAgentToolsDisabled: vi.fn(() => false),
  isTrackersAgentToolsEnabled: vi.fn((workspacePath: string) => workspacePath !== '/trackers-off'),
}));

vi.mock('../mcpWorkspaceResolver', () => ({
  getAvailableExtensionTools: vi.fn(async () => [
    {
      name: 'excalidraw_add_rectangle',
      description: 'Add a rectangle to the canvas',
      inputSchema: { type: 'object', properties: {} },
      extensionId: 'com.nimbalyst.excalidraw',
      scope: 'global',
    },
  ]),
  getAvailableBackendTools: vi.fn(async () => []),
}));

vi.mock('../../services/MCPConfigService', () => ({
  MCPConfigService: class {
    async getMergedConfig() {
      return {
        mcpServers: {
          'my-remote': { url: 'https://example.com/mcp' },
          'my-disabled': { url: 'https://example.com/mcp2', disabled: true },
        },
      };
    }
  },
}));

// The host-surface server modules pull heavy main-process import chains that
// don't load under vitest; their real schemas are covered by
// mcpToolBudget.characterization.test.ts. Static stand-ins keep this test on
// the grouping/measurement logic.
vi.mock('../settingsServer', () => ({
  settingsToolSchemas: [
    { name: 'settings_get_overview', description: 'Get settings', inputSchema: { type: 'object', properties: {} } },
  ],
}));
vi.mock('../sessionContextServer', () => ({
  SESSION_CONTEXT_TOOL_SCHEMAS: [
    { name: 'get_session_summary', description: 'Summarize session', inputSchema: { type: 'object', properties: {} } },
  ],
}));
vi.mock('../metaAgentServer', () => ({
  META_AGENT_TOOL_DEFS: [
    { name: 'create_session', description: 'Create a child session', inputSchema: { type: 'object', properties: {} } },
  ],
}));

vi.mock('../sessionNamingServer', () => ({
  buildSessionMetaToolSchemas: vi.fn(async () => [
    {
      name: 'update_session_meta',
      description: 'Update session metadata',
      inputSchema: { type: 'object', properties: {} },
    },
  ]),
}));

import { getToolBudgetSnapshot } from '../toolBudgetService';

describe('getToolBudgetSnapshot', () => {
  it('reports first-party, extension, and user groups with cost estimates', async () => {
    const snapshot = await getToolBudgetSnapshot('/some/workspace');
    const byKey = new Map(snapshot.groups.map((g) => [g.configKey, g]));

    // Core: eager, locked-on, has a positive measured cost.
    const core = byKey.get(MCP_CORE);
    expect(core).toBeDefined();
    expect(core!.loadPolicy).toBe('eager');
    expect(core!.lockedOn).toBe(true);
    expect(core!.estTokens).toBeGreaterThan(0);
    expect(core!.toolCount).toBeGreaterThan(0);

    // Trackers: deferred, enabled for this workspace.
    const trackers = byKey.get(MCP_TRACKERS);
    expect(trackers).toBeDefined();
    expect(trackers!.loadPolicy).toBe('deferred');
    expect(trackers!.enabled).toBe(true);
    expect(trackers!.estTokens).toBeGreaterThan(0);

    // Extension server appears with a measured cost.
    const excalidraw = byKey.get('nimbalyst-excalidraw');
    expect(excalidraw).toBeDefined();
    expect(excalidraw!.source).toBe('extension');
    expect(excalidraw!.toolCount).toBe(1);
    expect(excalidraw!.estTokens).toBeGreaterThan(0);

    // User servers appear without an estimate, honoring the disabled flag.
    expect(byKey.get('my-remote')!.enabled).toBe(true);
    expect(byKey.get('my-remote')!.estTokens).toBeNull();
    expect(byKey.get('my-disabled')!.enabled).toBe(false);

    // Eager floor is core's ALWAYS-LOAD subset only — display_to_user and
    // capture_editor_screenshot stay on core but defer, so the floor must be
    // strictly below the full core cost.
    expect(core!.alwaysLoadEstTokens).toBeGreaterThan(0);
    expect(core!.alwaysLoadEstTokens!).toBeLessThan(core!.estTokens!);
    expect(snapshot.eagerEstTokens).toBe(core!.alwaysLoadEstTokens);
  });

  it('counts the session-gated core tools (interactive prompts, commit proposal, edited files)', async () => {
    // getInteractiveToolSchemas / getEditorToolSchemas return their session-
    // gated tools only when given a sessionId. The budget service must pass a
    // measurement sessionId or the core row undercounts by ~4.4K tokens
    // (AskUserQuestion, PromptForUserInput, developer_git_commit_proposal,
    // get_session_edited_files) versus what a live session actually loads.
    const snapshot = await getToolBudgetSnapshot('/some/workspace');
    const core = snapshot.groups.find((g) => g.configKey === MCP_CORE);
    // 3 interactive + display_to_user + capture_editor_screenshot +
    // get_session_edited_files + update_session_meta (mocked) = 7.
    expect(core!.toolCount).toBeGreaterThanOrEqual(7);
  });

  it('reflects the per-workspace trackers opt-out', async () => {
    const snapshot = await getToolBudgetSnapshot('/trackers-off');
    const trackers = snapshot.groups.find((g) => g.configKey === MCP_TRACKERS);
    expect(trackers!.enabled).toBe(false);
  });
});
