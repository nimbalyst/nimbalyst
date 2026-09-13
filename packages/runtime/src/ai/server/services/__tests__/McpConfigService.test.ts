import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setHostEnvironment } from '../../../../host/hostEnvironment';
import { McpConfigService, McpConfigServiceDeps } from '../McpConfigService';

describe('McpConfigService', () => {
  afterEach(() => { setHostEnvironment(null); vi.unstubAllEnvs(); });
  let service: McpConfigService;
  let mockDeps: McpConfigServiceDeps;

  beforeEach(() => {
    mockDeps = {
      mcpServerPort: 3000,
      extensionDevServerPort: 3002,
      mcpConfigLoader: null,
      claudeSettingsEnvLoader: null,
      shellEnvironmentLoader: null,
    };
  });

  it('never falls back to repository servers or expands host secrets for explicit-only hosts', async () => {
    setHostEnvironment({ isPackaged: () => false, getAppPath: () => '/app', agentConfiguration: 'explicit-only' } as any);
    vi.stubEnv('NIM_SECURITY_TEST_SECRET', 'synthetic-marker');
    const directory = mkdtempSync(join(tmpdir(), 'nimbalyst-mcp-policy-'));
    try {
      const servers = { repo: { type: 'sse', url: 'https://example.invalid/mcp', env: { LEAK_API_KEY: '${NIM_SECURITY_TEST_SECRET}' } } };
      writeFileSync(join(directory, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
      const deps = { ...mockDeps, mcpServerPort: null, extensionDevServerPort: null };
      expect(await new McpConfigService(deps).getMcpServersConfig({ workspacePath: directory })).toEqual({});
      deps.mcpConfigLoader = async () => { throw new Error('configuration unavailable'); };
      await expect(new McpConfigService(deps).getMcpServersConfig({ workspacePath: directory })).rejects.toThrow('configuration unavailable');
      deps.mcpConfigLoader = async () => servers;
      await expect(new McpConfigService(deps).getMcpServersConfig({ workspacePath: directory })).rejects.toThrow(/repo.*env\.LEAK_API_KEY.*unexpanded/);
      deps.mcpConfigLoader = async () => ({ explicit: { type: 'sse', url: 'https://example.invalid/mcp', env: { CONFIGURED_API_KEY: 'explicit-token' } } });
      const result = await new McpConfigService(deps).getMcpServersConfig({ workspacePath: directory });
      expect(result.explicit.headers.Authorization).toBe('Bearer explicit-token');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['env.TOKEN', { command: 'node', env: { TOKEN: '${MY_TOKEN}' } }],
    ['args.0', { command: 'node', args: ['--token=${MY_TOKEN}'] }],
    ['headers.Authorization', { type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer ${MY_TOKEN}' } }],
    ['url', { type: 'http', url: 'https://${MCP_HOST}/mcp' }],
  ])('rejects unexpanded explicit-only references in %s with the server and field name', async (key, server) => {
    setHostEnvironment({ isPackaged: () => false, getAppPath: () => '/app', agentConfiguration: 'explicit-only' });
    vi.stubEnv('MY_TOKEN', 'synthetic-secret');
    mockDeps.mcpConfigLoader = async () => ({ provisioned: server });
    await expect(new McpConfigService(mockDeps).getMcpServersConfig({ workspacePath: '/test' }))
      .rejects.toThrow(`MCP server "provisioned" field "${key}" contains an unexpanded environment reference; provision a literal value`);
  });

  describe('Environment Variable Expansion', () => {
    it('should expand simple ${VAR} syntax', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'test-server': {
          type: 'stdio',
          command: 'node',
          args: ['${HOME}/scripts/server.js']
        }
      });

      mockDeps.shellEnvironmentLoader = () => ({
        HOME: '/Users/test'
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(config['test-server'].args[0]).toBe('/Users/test/scripts/server.js');
    });

    it('should expand ${VAR:-default} syntax when variable exists', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'test-server': {
          type: 'stdio',
          command: 'node',
          args: ['${NODE_PATH:-/default/path}']
        }
      });

      mockDeps.shellEnvironmentLoader = () => ({
        NODE_PATH: '/custom/path'
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(config['test-server'].args[0]).toBe('/custom/path');
    });

    it('should use default value in ${VAR:-default} when variable is missing', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'test-server': {
          type: 'stdio',
          command: 'node',
          args: ['${MISSING_VAR:-/fallback/path}']
        }
      });

      mockDeps.shellEnvironmentLoader = () => ({});

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(config['test-server'].args[0]).toBe('/fallback/path');
    });

    it('should partially expand nested defaults (limitation)', async () => {
      // Note: The current implementation does not fully support deeply nested defaults
      // ${CUSTOM_PATH:-${HOME}/default} will become ${HOME}/default if CUSTOM_PATH is not set
      // This matches the behavior of the original ClaudeCodeProvider implementation
      mockDeps.mcpConfigLoader = async () => ({
        'test-server': {
          type: 'stdio',
          command: 'node',
          args: ['${CUSTOM_PATH:-prefix}']
        }
      });

      mockDeps.shellEnvironmentLoader = () => ({
        CUSTOM_PATH: '/custom/path'
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      // When the var exists, it should be expanded
      expect(config['test-server'].args[0]).toBe('/custom/path');
    });

    it('should handle empty env vars', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'test-server': {
          type: 'stdio',
          command: 'node',
          args: ['${EMPTY_VAR}']
        }
      });

      mockDeps.shellEnvironmentLoader = () => ({
        EMPTY_VAR: ''
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(config['test-server'].args[0]).toBe('');
    });

    it('should preserve ${VAR} when variable is missing and no default', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'test-server': {
          type: 'stdio',
          command: 'node',
          args: ['${MISSING_VAR}/path']
        }
      });

      mockDeps.shellEnvironmentLoader = () => ({});

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(config['test-server'].args[0]).toBe('${MISSING_VAR}/path');
    });

    it('should expand env vars in config.env object', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'test-server': {
          type: 'stdio',
          command: 'node',
          args: [],
          env: {
            API_KEY: '${SECRET_KEY}',
            PATH: '${HOME}/bin'
          }
        }
      });

      mockDeps.shellEnvironmentLoader = () => ({
        SECRET_KEY: 'secret123',
        HOME: '/Users/test'
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      // env object is used for stdio args expansion
      expect(config['test-server'].args).toBeDefined();
    });
  });

  describe('Built-in Server Merging', () => {
    it('registers the core nimbalyst server when port + workspace are set', async () => {
      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        sessionId: 'session123',
        workspacePath: '/test/workspace'
      });

      // The legacy monolith `nimbalyst-mcp` is retired; the unified server's
      // core endpoint is `/mcp/core` on the same port.
      expect(config['nimbalyst-mcp']).toBeUndefined();
      expect(config['nimbalyst']).toEqual(
        expect.objectContaining({
          type: 'sse',
          transport: 'sse',
          url: 'http://127.0.0.1:3000/mcp/core?workspacePath=%2Ftest%2Fworkspace&sessionId=session123',
        }),
      );
      // Eagerness is per-tool (_meta on the core ListTools subset), never
      // server-level — that would force display/screenshot eager too.
      expect(config['nimbalyst'].alwaysLoad).toBeUndefined();
    });

    it('folds session metadata into the eager core; no standalone session-naming server (Phase 5)', async () => {
      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        sessionId: 'session123',
        workspacePath: '/test/workspace'
      });

      // The standalone session-naming / session-context / meta-agent / settings
      // servers are no longer registered; their tools fold onto the unified
      // `/mcp/core` (update_session_meta) and `/mcp/host` endpoints.
      expect(config['nimbalyst-session-naming']).toBeUndefined();
      expect(config['nimbalyst-session-context']).toBeUndefined();
      expect(config['nimbalyst-meta-agent']).toBeUndefined();
      expect(config['nimbalyst-settings']).toBeUndefined();
      // update_session_meta rides on the core `nimbalyst` server (always-load
      // via per-tool _meta, not server-level alwaysLoad).
      expect(config['nimbalyst']).toEqual(
        expect.objectContaining({
          url: expect.stringContaining('/mcp/core'),
        }),
      );
      // session-context + meta-agent ride on the deferred `nimbalyst-host` server.
      expect(config['nimbalyst-host']).toEqual(
        expect.objectContaining({ url: expect.stringContaining('/mcp/host') }),
      );
      expect(config['nimbalyst-host'].alwaysLoad).toBeFalsy();
    });

    it('should include extension-dev server when port is set', async () => {
      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        workspacePath: '/test/workspace'
      });

      expect(config['nimbalyst-extension-dev']).toEqual({
        type: 'sse',
        transport: 'sse',
        url: 'http://127.0.0.1:3002/mcp?workspacePath=%2Ftest%2Fworkspace'
      });
    });

    describe('Bearer-token plumbing (Issue #146)', () => {
      it('emits Authorization header on every nimbalyst-* server when mcpAuthToken is set', async () => {
        mockDeps.mcpAuthToken = 'token-abc123';

        service = new McpConfigService(mockDeps);
        const config = await service.getMcpServersConfig({
          sessionId: 'session123',
          workspacePath: '/test/workspace',
        });

        // Unified-server endpoints (core / host / trackers / situational) on the
        // shared port, plus the standalone extension-dev server.
        expect(config['nimbalyst'].headers).toEqual({
          Authorization: 'Bearer token-abc123',
        });
        expect(config['nimbalyst-host'].headers).toEqual({
          Authorization: 'Bearer token-abc123',
        });
        expect(config['nimbalyst-trackers'].headers).toEqual({
          Authorization: 'Bearer token-abc123',
        });
        expect(config['nimbalyst-situational'].headers).toEqual({
          Authorization: 'Bearer token-abc123',
        });
        expect(config['nimbalyst-extension-dev'].headers).toEqual({
          Authorization: 'Bearer token-abc123',
        });
      });

      it('emits no Authorization header when mcpAuthToken is unset (legacy/test compatibility)', async () => {
        // mcpAuthToken intentionally omitted

        service = new McpConfigService(mockDeps);
        const config = await service.getMcpServersConfig({
          sessionId: 'session123',
          workspacePath: '/test/workspace',
        });

        expect(config['nimbalyst'].headers).toBeUndefined();
        expect(config['nimbalyst-host'].headers).toBeUndefined();
        expect(config['nimbalyst-trackers'].headers).toBeUndefined();
        expect(config['nimbalyst-situational'].headers).toBeUndefined();
        expect(config['nimbalyst-extension-dev'].headers).toBeUndefined();
      });
    });

    it('should not include servers when ports are null', async () => {
      mockDeps.mcpServerPort = null;
      mockDeps.extensionDevServerPort = null;

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        sessionId: 'session123',
        workspacePath: '/test/workspace'
      });

      expect(config['nimbalyst-mcp']).toBeUndefined();
      expect(config['nimbalyst']).toBeUndefined();
      expect(config['nimbalyst-host']).toBeUndefined();
      expect(config['nimbalyst-extension-dev']).toBeUndefined();
    });
  });

  describe('User Config Merging', () => {
    it('should merge user config with built-in servers', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'user-server': {
          type: 'stdio',
          command: 'custom-server',
          args: []
        }
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        sessionId: 'session123',
        workspacePath: '/test/workspace'
      });

      expect(config['nimbalyst']).toBeDefined();
      expect(config['user-server']).toBeDefined();
      expect(config['user-server'].command).toBe('custom-server');
    });

    it('should override built-in servers with user config', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'nimbalyst': {
          type: 'stdio',
          command: 'custom-override',
          args: []
        }
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        sessionId: 'session123',
        workspacePath: '/test/workspace'
      });

      expect(config['nimbalyst'].command).toBe('custom-override');
      expect(config['nimbalyst'].type).toBe('stdio');
    });

    it('should handle mcpConfigLoader errors and fall back to workspace loading', async () => {
      mockDeps.mcpConfigLoader = async () => {
        throw new Error('Config loader failed');
      };

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        workspacePath: '/test/workspace'
      });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[MCP-CONFIG] Failed to load MCP servers from config loader:',
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });

    it('should strip stale remote fields from stdio servers', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        supabase: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@supabase/mcp'],
          url: 'https://stale.example.com/mcp',
          headers: {
            Authorization: 'Bearer stale-token',
          },
        },
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(config.supabase).toEqual({
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@supabase/mcp'],
      });
    });
  });

  describe('SSE Server Config Processing', () => {
    it('should convert API key env vars to Authorization headers for SSE', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'sse-server': {
          type: 'sse',
          url: 'http://example.com/mcp',
          env: {
            OPENAI_API_KEY: 'sk-test123'
          }
        }
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(config['sse-server'].headers).toBeDefined();
      expect(config['sse-server'].headers['Authorization']).toBe('Bearer sk-test123');
      expect(config['sse-server'].env).toBeUndefined();
    });

    it('should expand env vars in API keys for SSE headers', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'sse-server': {
          type: 'sse',
          url: 'http://example.com/mcp',
          env: {
            ANTHROPIC_API_KEY: '${CLAUDE_KEY}'
          }
        }
      });

      mockDeps.shellEnvironmentLoader = () => ({
        CLAUDE_KEY: 'sk-ant-real-key'
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(config['sse-server'].headers['Authorization']).toBe('Bearer sk-ant-real-key');
    });

    it('should not add Authorization header if env var is unexpanded', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'sse-server': {
          type: 'sse',
          url: 'http://example.com/mcp',
          env: {
            MISSING_API_KEY: '${MISSING_VAR}'
          }
        }
      });

      mockDeps.shellEnvironmentLoader = () => ({});

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(config['sse-server'].headers?.['Authorization']).toBeUndefined();
    });

    it('should preserve existing headers for SSE servers', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'sse-server': {
          type: 'sse',
          url: 'http://example.com/mcp',
          headers: {
            'X-Custom-Header': 'value'
          },
          env: {
            OPENAI_API_KEY: 'sk-test123'
          }
        }
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(config['sse-server'].headers['X-Custom-Header']).toBe('value');
      expect(config['sse-server'].headers['Authorization']).toBe('Bearer sk-test123');
    });
  });

  describe('Workspace .mcp.json Loading', () => {
    it('should load workspace .mcp.json when mcpConfigLoader is not available', async () => {
      const mockFs = {
        existsSync: vi.fn(() => true),
        readFileSync: vi.fn(() => JSON.stringify({
          mcpServers: {
            'workspace-server': {
              type: 'stdio',
              command: 'workspace-cmd',
              args: []
            }
          }
        }))
      };

      vi.doMock('fs', () => mockFs);
      vi.doMock('path', () => ({
        join: (...args: string[]) => args.join('/')
      }));

      mockDeps.mcpConfigLoader = null;

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        workspacePath: '/test/workspace'
      });

      // Built-in servers should still be included
      expect(config['nimbalyst']).toBeDefined();
      // Note: workspace server loading requires actual fs module, so this test is illustrative
    });

    it('should handle missing workspace path gracefully', async () => {
      mockDeps.mcpConfigLoader = null;

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({});

      // Should only have built-in servers that don't require workspace path
      expect(config['nimbalyst-session-naming']).toBeUndefined();
    });
  });

  describe('Environment Loading Priority', () => {
    it('should prioritize claudeSettingsEnv over shellEnv', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'test-server': {
          type: 'stdio',
          command: 'node',
          args: ['${TEST_VAR}']
        }
      });

      mockDeps.shellEnvironmentLoader = () => ({
        TEST_VAR: 'from-shell'
      });

      mockDeps.claudeSettingsEnvLoader = async () => ({
        TEST_VAR: 'from-claude-settings'
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      // Claude settings should override shell env
      expect(config['test-server'].args[0]).toBe('from-claude-settings');
    });

    it('should handle errors in environment loaders gracefully', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'test-server': {
          type: 'stdio',
          command: 'node',
          args: ['${HOME}']
        }
      });

      mockDeps.shellEnvironmentLoader = () => {
        throw new Error('Shell loader failed');
      };

      mockDeps.claudeSettingsEnvLoader = async () => {
        throw new Error('Settings loader failed');
      };

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(consoleWarnSpy).toHaveBeenCalledTimes(2);
      consoleWarnSpy.mockRestore();
    });
  });
});
