import { describe, it, expect } from 'vitest';
import { McpConfigService, McpConfigServiceDeps } from '../McpConfigService';
import {
  MCP_FIRST_PARTY_TOPOLOGY,
  MCP_CORE,
  MCP_HOST,
  MCP_TRACKERS,
  MCP_SITUATIONAL,
  MCP_EXTENSION_DEV,
  MCP_EAGER_CONFIG_KEYS,
  MCP_RETIRED_SERVER_CONFIG_KEYS,
  FIRST_PARTY_TOOL_TO_SERVER,
  extensionServerConfigKey,
  extensionServerEndpointPath,
  isExtensionServerConfigKey,
  isEagerServer,
} from '../mcpTopology';

/**
 * Phase 0 of the MCP server consolidation (nimbalyst-local/plans/mcp-server-consolidation.md).
 *
 * The `describe('Topology descriptor', ...)` block validates the descriptor and
 * PASSES today. The `describe('getMcpServersConfig target topology', ...)` block
 * is written RED-FIRST: it asserts the post-consolidation server set and stays
 * red until Phases 1-7 reshape `getMcpServersConfig`.
 */
describe('Topology descriptor', () => {
  it('marks only nimbalyst-core as eager (alwaysLoad)', () => {
    expect(MCP_EAGER_CONFIG_KEYS).toEqual([MCP_CORE]);
    expect(isEagerServer(MCP_CORE)).toBe(true);
    expect(isEagerServer(MCP_HOST)).toBe(false);
    expect(isEagerServer(MCP_TRACKERS)).toBe(false);
    expect(isEagerServer(MCP_SITUATIONAL)).toBe(false);
  });

  it('gives every first-party server a unique config-key and endpoint path', () => {
    const keys = MCP_FIRST_PARTY_TOPOLOGY.map((e) => e.configKey);
    const paths = MCP_FIRST_PARTY_TOPOLOGY.map((e) => e.endpointPath);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('assigns each first-party tool to exactly one server', () => {
    const seen = new Map<string, string>();
    for (const entry of MCP_FIRST_PARTY_TOPOLOGY) {
      for (const tool of entry.tools) {
        expect(seen.has(tool)).toBe(false);
        seen.set(tool, entry.configKey);
      }
    }
    // Spot-check the reverse index matches the forward declaration.
    expect(FIRST_PARTY_TOOL_TO_SERVER.get('update_session_meta')).toBe(MCP_CORE);
    expect(FIRST_PARTY_TOOL_TO_SERVER.get('display_to_user')).toBe(MCP_CORE);
    expect(FIRST_PARTY_TOOL_TO_SERVER.get('settings_get_overview')).toBe(MCP_HOST);
    expect(FIRST_PARTY_TOOL_TO_SERVER.get('spawn_session')).toBe(MCP_HOST);
    expect(FIRST_PARTY_TOOL_TO_SERVER.get('list_queued_prompts')).toBe(MCP_HOST);
    expect(FIRST_PARTY_TOOL_TO_SERVER.get('tracker_create')).toBe(MCP_TRACKERS);
    expect(FIRST_PARTY_TOOL_TO_SERVER.get('voice_agent_speak')).toBe(MCP_SITUATIONAL);
    expect(FIRST_PARTY_TOOL_TO_SERVER.get('renderer_eval')).toBe(MCP_EXTENSION_DEV);
  });

  it('moves tracker config tools onto the tracker server, not the host', () => {
    expect(FIRST_PARTY_TOOL_TO_SERVER.get('tracker_set_sync_policy')).toBe(MCP_TRACKERS);
    expect(FIRST_PARTY_TOOL_TO_SERVER.get('tracker_set_issue_key_prefix')).toBe(MCP_TRACKERS);
  });

  it('keeps workspace_open (not open_workspace) to resolve the collision', () => {
    expect(FIRST_PARTY_TOOL_TO_SERVER.get('workspace_open')).toBe(MCP_HOST);
    expect(FIRST_PARTY_TOOL_TO_SERVER.has('open_workspace')).toBe(false);
  });

  it('derives per-extension server identities', () => {
    expect(extensionServerConfigKey('excalidraw')).toBe('nimbalyst-excalidraw');
    expect(extensionServerEndpointPath('excalidraw')).toBe('/mcp/ext/excalidraw');
    expect(isExtensionServerConfigKey('nimbalyst-excalidraw')).toBe(true);
    expect(isExtensionServerConfigKey(MCP_CORE)).toBe(false);
    expect(isExtensionServerConfigKey('some-third-party')).toBe(false);
  });

  it('maps every first-party tool to a split server (no legacy monolith left)', () => {
    // The consolidation is complete: each first-party tool resolves to its split
    // server via the reverse index. `open_workspace` is retired (no mapping).
    expect(FIRST_PARTY_TOOL_TO_SERVER.get('display_to_user')).toBe(MCP_CORE);
    expect(FIRST_PARTY_TOOL_TO_SERVER.get('tracker_create')).toBe(MCP_TRACKERS);
    expect(FIRST_PARTY_TOOL_TO_SERVER.get('voice_agent_speak')).toBe(MCP_SITUATIONAL);
    expect(FIRST_PARTY_TOOL_TO_SERVER.has('open_workspace')).toBe(false);
  });

  it('lists the retired servers that this refactor removes', () => {
    expect(MCP_RETIRED_SERVER_CONFIG_KEYS).toContain('nimbalyst-mcp');
    expect(MCP_RETIRED_SERVER_CONFIG_KEYS).toContain('nimbalyst-session-naming');
    expect(MCP_RETIRED_SERVER_CONFIG_KEYS).toContain('nimbalyst-settings');
    expect(MCP_RETIRED_SERVER_CONFIG_KEYS).toContain('nimbalyst-session-context');
    expect(MCP_RETIRED_SERVER_CONFIG_KEYS).toContain('nimbalyst-meta-agent');
  });
});

describe('getMcpServersConfig consolidated topology', () => {
  function baseDeps(): McpConfigServiceDeps {
    return {
      // The unified internal HTTP server lives on the single mcpServerPort;
      // endpoints are paths, not ports.
      mcpServerPort: 3000,
      extensionDevServerPort: 3002,
      mcpConfigLoader: null,
      claudeSettingsEnvLoader: null,
      shellEnvironmentLoader: null,
    };
  }

  // ---- Landed (Phases 2-3) ----

  it('registers the core server as `nimbalyst` WITHOUT server-level alwaysLoad', async () => {
    const config = await new McpConfigService(baseDeps()).getMcpServersConfig({
      sessionId: 'session123',
      workspacePath: '/test/workspace',
    });

    expect(MCP_CORE).toBe('nimbalyst');
    expect(config[MCP_CORE]).toBeDefined();
    // Eagerness is per-tool (`_meta['anthropic/alwaysLoad']` on the core
    // ListTools subset — applyCoreAlwaysLoadMeta), not server-level. A
    // server-level flag would force display_to_user/capture_editor_screenshot
    // eager too.
    expect(config[MCP_CORE].alwaysLoad).toBeUndefined();
    expect(config[MCP_CORE].url).toContain('/mcp/core');
    // Carries the long timeout (git_commit_proposal / AskUserQuestion block on input).
    expect(config[MCP_CORE].tool_timeout_sec).toBeGreaterThan(60);
  });

  it('registers each active extension as its own deferred nimbalyst-<ext> server', async () => {
    const service = new McpConfigService({
      ...baseDeps(),
      extensionMcpServerNamesLoader: () => ['excalidraw', 'slides'],
    });
    const config = await service.getMcpServersConfig({
      sessionId: 'session123',
      workspacePath: '/test/workspace',
    });

    expect(config['nimbalyst-excalidraw']).toBeDefined();
    expect(config['nimbalyst-excalidraw'].alwaysLoad).toBeFalsy();
    expect(config['nimbalyst-excalidraw'].url).toContain('/mcp/ext/excalidraw');
    expect(config['nimbalyst-slides']).toBeDefined();
    expect(config['nimbalyst-slides'].alwaysLoad).toBeFalsy();
  });

  it('registers no extension servers when no loader is provided', async () => {
    const config = await new McpConfigService(baseDeps()).getMcpServersConfig({
      sessionId: 'session123',
      workspacePath: '/test/workspace',
    });
    expect(config['nimbalyst-excalidraw']).toBeUndefined();
  });

  it('does not register the retired legacy nimbalyst-mcp monolith', async () => {
    const config = await new McpConfigService(baseDeps()).getMcpServersConfig({
      sessionId: 'session123',
      workspacePath: '/test/workspace',
    });
    expect(config['nimbalyst-mcp']).toBeUndefined();
    // The genuine-CLI /permission URL is lifted from the eager core instead.
    expect(config['nimbalyst']).toBeDefined();
  });

  // ---- Phase 4: nimbalyst-trackers (deferred + per-project opt-out) ----

  it('registers nimbalyst-trackers (deferred) by default', async () => {
    const config = await new McpConfigService(baseDeps()).getMcpServersConfig({
      sessionId: 'session123',
      workspacePath: '/test/workspace',
    });

    expect(config[MCP_TRACKERS]).toBeDefined();
    // Deferred: never alwaysLoad (it must not touch the eager budget).
    expect(config[MCP_TRACKERS].alwaysLoad).toBeFalsy();
    expect(config[MCP_TRACKERS].url).toContain('/mcp/trackers');
  });

  it('omits nimbalyst-trackers when the per-project opt-out is set', async () => {
    const service = new McpConfigService({
      ...baseDeps(),
      trackersAgentToolsDisabledLoader: (workspacePath?: string) =>
        workspacePath === '/test/workspace',
    });
    const config = await service.getMcpServersConfig({
      sessionId: 'session123',
      workspacePath: '/test/workspace',
    });

    expect(config[MCP_TRACKERS]).toBeUndefined();
  });

  it('passes the workspace path to the tracker opt-out loader', async () => {
    const seen: Array<string | undefined> = [];
    const service = new McpConfigService({
      ...baseDeps(),
      trackersAgentToolsDisabledLoader: (workspacePath?: string) => {
        seen.push(workspacePath);
        return false;
      },
    });
    await service.getMcpServersConfig({
      sessionId: 'session123',
      workspacePath: '/test/workspace',
    });

    expect(seen).toContain('/test/workspace');
  });

  // ---- Phase 5: nimbalyst-host + fold update_session_meta into core ----

  it('registers nimbalyst-host (deferred) on /mcp/host', async () => {
    const config = await new McpConfigService(baseDeps()).getMcpServersConfig({
      sessionId: 'session123',
      workspacePath: '/test/workspace',
    });

    expect(config[MCP_HOST]).toBeDefined();
    expect(config[MCP_HOST].alwaysLoad).toBeFalsy();
    expect(config[MCP_HOST].url).toContain('/mcp/host');
    // No settings-exclusion flag for the standard, kill-switch-off profile.
    expect(config[MCP_HOST].url).not.toContain('hostExcludeSettings');
  });

  it('excludes host settings tools for the meta-agent profile', async () => {
    const config = await new McpConfigService(baseDeps()).getMcpServersConfig({
      sessionId: 'session123',
      workspacePath: '/test/workspace',
      profile: 'meta-agent',
    });

    // Host still registers (meta-agent needs session-context + orchestration),
    // but the URL flags the settings tools for exclusion.
    expect(config[MCP_HOST]).toBeDefined();
    expect(config[MCP_HOST].url).toContain('hostExcludeSettings=1');
  });

  it('excludes host settings tools when the settings kill-switch is on', async () => {
    const config = await new McpConfigService({
      ...baseDeps(),
      settingsAgentToolsDisabledLoader: () => true,
    }).getMcpServersConfig({
      sessionId: 'session123',
      workspacePath: '/test/workspace',
    });

    expect(config[MCP_HOST].url).toContain('hostExcludeSettings=1');
  });

  it('retires the ad-hoc per-feature servers (settings / session-context / meta-agent / session-naming)', async () => {
    const config = await new McpConfigService(baseDeps()).getMcpServersConfig({
      sessionId: 'session123',
      workspacePath: '/test/workspace',
    });

    // Folded onto the unified server; no longer registered as standalone configs.
    expect(config['nimbalyst-settings']).toBeUndefined();
    expect(config['nimbalyst-session-context']).toBeUndefined();
    expect(config['nimbalyst-meta-agent']).toBeUndefined();
    expect(config['nimbalyst-session-naming']).toBeUndefined();
    // The legacy `nimbalyst-mcp` monolith is fully retired.
    expect(config['nimbalyst-mcp']).toBeUndefined();
  });

  it('registers nimbalyst-situational (deferred) on /mcp/situational', async () => {
    const config = await new McpConfigService(baseDeps()).getMcpServersConfig({
      sessionId: 'session123',
      workspacePath: '/test/workspace',
    });
    expect(config[MCP_SITUATIONAL]).toBeDefined();
    expect(config[MCP_SITUATIONAL].alwaysLoad).toBeFalsy();
    expect(config[MCP_SITUATIONAL].url).toContain('/mcp/situational');
  });
});
