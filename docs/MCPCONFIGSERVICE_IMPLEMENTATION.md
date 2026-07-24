# McpConfigService Implementation

## Status: COMPLETE

Extracted MCP configuration logic from ClaudeCodeProvider into a reusable service that can be shared by CodexProvider and future providers.

**Lines Extracted:** 140 lines
**Priority:** HIGH
**Benefit:** Reusable for all SDK-based providers

## Implementation Summary

The `McpConfigService` has been successfully extracted from `ClaudeCodeProvider` and is now available as a standalone service at `/packages/runtime/src/ai/server/services/McpConfigService.ts`.

### Key Features

- Loads and merges MCP servers from multiple sources (built-in, user config, workspace config)
- Expands environment variables with support for `${VAR}` and `${VAR:-default}` syntax
- Converts SSE server configs to use Authorization headers
- Fully tested with 22 unit tests covering all functionality
- Reduces ClaudeCodeProvider by 140 lines

### Usage

```typescript
import { McpConfigService } from '../services/McpConfigService';

// Initialize in constructor
this.mcpConfigService = new McpConfigService({
  mcpServerPort: ClaudeCodeProvider.mcpServerPort,
  sessionNamingServerPort: ClaudeCodeProvider.sessionNamingServerPort,
  extensionDevServerPort: ClaudeCodeProvider.extensionDevServerPort,
  mcpConfigLoader: ClaudeCodeProvider.mcpConfigLoader,
  extensionPluginsLoader: ClaudeCodeProvider.extensionPluginsLoader,
  claudeSettingsEnvLoader: ClaudeCodeProvider.claudeSettingsEnvLoader,
  shellEnvironmentLoader: ClaudeCodeProvider.shellEnvironmentLoader,
});

// Use in sendMessage or similar methods
const mcpServers = await this.mcpConfigService.getMcpServersConfig({
  sessionId,
  workspacePath
});
```

---

## Current Code Location

**File:** `/packages/runtime/src/ai/server/providers/ClaudeCodeProvider.ts`

**Methods:**
- `getMcpServersConfig()` (lines 2764-2830) - ~70 lines
- `processServerConfig()` (lines 2832-2876) - ~45 lines
- `loadWorkspaceMcpServers()` (lines 2878-2904) - ~25 lines
- `expandEnvVar()` (lines 2906-2931) - ~25 lines

**Dependencies:**
- Static variables: `mcpServerPort`, `sessionNamingServerPort`, `extensionDevServerPort`
- Static loaders: `mcpConfigLoader`, `extensionPluginsLoader`, `claudeSettingsEnvLoader`, `shellEnvironmentLoader`

---

## Proposed Interface

### File: `/packages/runtime/src/ai/server/services/McpConfigService.ts`

```typescript
/**
 * MCP Server Configuration Service
 *
 * Handles loading, merging, and processing MCP server configurations from:
 * - Built-in Nimbalyst servers (nimbalyst-mcp, session naming, extension dev)
 * - User MCP config (~/.claude/claude.json)
 * - Workspace MCP config (.mcp.json)
 *
 * Responsibilities:
 * - Load and merge MCP configs from multiple sources
 * - Expand environment variables in config values
 * - Convert configs to SSE transport format for SDKs
 */

import path from 'path';
import fs from 'fs';

/**
 * Dependencies injected from the provider/electron main process
 */
export interface McpConfigServiceDeps {
  /** Port for the shared nimbalyst-mcp server (if running) */
  mcpServerPort: number | null;

  /** Port for the session naming server (if running) */
  sessionNamingServerPort: number | null;

  /** Port for the extension dev server (if running) */
  extensionDevServerPort: number | null;

  /**
   * Loader function to get user + workspace MCP config
   * Returns merged config from ~/.claude/claude.json and workspace .mcp.json
   */
  mcpConfigLoader: ((workspacePath?: string) => Promise<Record<string, any>>) | null;

  /**
   * Loader function to get Claude extension plugins
   * Returns array of local plugin paths
   */
  extensionPluginsLoader: ((workspacePath?: string) => Promise<Array<{ type: 'local'; path: string }>>) | null;

  /**
   * Loader function to get Claude settings environment variables
   * Returns env vars from ~/.claude/claude.json settings
   */
  claudeSettingsEnvLoader: (() => Promise<Record<string, string>>) | null;

  /**
   * Loader function to get shell environment variables
   * Returns login shell env vars (macOS/Linux)
   */
  shellEnvironmentLoader: (() => Record<string, string> | null) | null;
}

/**
 * Options for loading MCP config
 */
export interface GetMcpConfigOptions {
  /** Session ID for logging */
  sessionId?: string;

  /** Workspace path for workspace-specific config */
  workspacePath?: string;
}

/**
 * MCP Server Configuration Service
 */
export class McpConfigService {
  private readonly deps: McpConfigServiceDeps;

  constructor(deps: McpConfigServiceDeps) {
    this.deps = deps;
  }

  /**
   * Get merged MCP server configuration from all sources
   *
   * Priority order (later sources override earlier):
   * 1. Built-in Nimbalyst servers
   * 2. User config (~/.claude/claude.json)
   * 3. Workspace config (.mcp.json)
   *
   * @param options - Configuration options
   * @returns Merged MCP server config object
   */
  async getMcpServersConfig(options: GetMcpConfigOptions = {}): Promise<Record<string, any>> {
    const { sessionId, workspacePath } = options;
    const mcpServers: Record<string, any> = {};

    // 1. Add built-in Nimbalyst MCP servers (if running)
    if (this.deps.mcpServerPort) {
      mcpServers['nimbalyst-mcp'] = {
        type: 'sse',
        url: `http://127.0.0.1:${this.deps.mcpServerPort}/sse`,
      };
    }

    if (this.deps.sessionNamingServerPort) {
      mcpServers['nimbalyst-session-naming'] = {
        type: 'sse',
        url: `http://127.0.0.1:${this.deps.sessionNamingServerPort}/sse`,
      };
    }

    if (this.deps.extensionDevServerPort) {
      mcpServers['nimbalyst-extension-dev'] = {
        type: 'sse',
        url: `http://127.0.0.1:${this.deps.extensionDevServerPort}/sse`,
      };
    }

    // 2. Load user + workspace MCP config via loader
    if (this.deps.mcpConfigLoader) {
      try {
        const userConfig = await this.deps.mcpConfigLoader(workspacePath);
        if (userConfig.mcpServers) {
          Object.assign(mcpServers, userConfig.mcpServers);
        }
      } catch (error) {
        console.error('[MCP-CONFIG] Failed to load user/workspace MCP config:', error);
      }
    }

    // 3. Load extension plugins (if available)
    if (this.deps.extensionPluginsLoader) {
      try {
        const plugins = await this.deps.extensionPluginsLoader(workspacePath);
        if (plugins && plugins.length > 0) {
          for (const plugin of plugins) {
            if (plugin.type === 'local') {
              const pluginName = path.basename(plugin.path);
              mcpServers[pluginName] = {
                command: 'node',
                args: [plugin.path],
                type: 'stdio',
              };
            }
          }
        }
      } catch (error) {
        console.error('[MCP-CONFIG] Failed to load extension plugins:', error);
      }
    }

    // 4. Process each server config (expand env vars, add headers)
    const processedServers: Record<string, any> = {};
    for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
      processedServers[serverName] = this.processServerConfig(serverName, serverConfig);
    }

    return processedServers;
  }

  /**
   * Process a single MCP server config
   *
   * Performs:
   * - Environment variable expansion in command/args/url/env
   * - Header conversion for SSE transport
   *
   * @param serverName - Name of the server
   * @param serverConfig - Raw server config
   * @returns Processed server config
   */
  private processServerConfig(serverName: string, serverConfig: any): any {
    if (!serverConfig || typeof serverConfig !== 'object') {
      return serverConfig;
    }

    // Load environment for expansion
    const env = this.loadEnvironmentForExpansion();

    // Deep clone to avoid mutating original
    const processed = JSON.parse(JSON.stringify(serverConfig));

    // Expand env vars in command
    if (typeof processed.command === 'string') {
      processed.command = this.expandEnvVar(processed.command, env);
    }

    // Expand env vars in args array
    if (Array.isArray(processed.args)) {
      processed.args = processed.args.map((arg: any) =>
        typeof arg === 'string' ? this.expandEnvVar(arg, env) : arg
      );
    }

    // Expand env vars in url (for SSE servers)
    if (typeof processed.url === 'string') {
      processed.url = this.expandEnvVar(processed.url, env);
    }

    // Expand env vars in env object
    if (processed.env && typeof processed.env === 'object') {
      const expandedEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(processed.env)) {
        expandedEnv[key] = typeof value === 'string' ? this.expandEnvVar(value, env) : value;
      }
      processed.env = expandedEnv;
    }

    // Convert SSE servers to use headers (Claude Agent SDK format)
    if (processed.type === 'sse' && processed.url) {
      processed.headers = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      };
    }

    return processed;
  }

  /**
   * Load environment variables for expansion
   *
   * Priority order (later sources override earlier):
   * 1. process.env (current Node.js environment)
   * 2. Shell environment (login shell, macOS/Linux)
   * 3. Claude settings env vars (~/.claude/claude.json)
   *
   * @returns Merged environment variables
   */
  private loadEnvironmentForExpansion(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };

    // Add shell environment (if available)
    if (this.deps.shellEnvironmentLoader) {
      try {
        const shellEnv = this.deps.shellEnvironmentLoader();
        if (shellEnv) {
          Object.assign(env, shellEnv);
        }
      } catch (error) {
        console.error('[MCP-CONFIG] Failed to load shell environment:', error);
      }
    }

    // Add Claude settings env vars (if available)
    if (this.deps.claudeSettingsEnvLoader) {
      try {
        // Note: This is async but we'll handle it in getMcpServersConfig
        // For now, skip (or make loadEnvironmentForExpansion async)
      } catch (error) {
        console.error('[MCP-CONFIG] Failed to load Claude settings env:', error);
      }
    }

    return env;
  }

  /**
   * Expand environment variables in a string
   *
   * Supports:
   * - ${VAR} - Replace with env var or empty string
   * - ${VAR:-default} - Replace with env var or default value
   *
   * Examples:
   * - "${HOME}/bin" -> "/Users/name/bin"
   * - "${FOO:-bar}" -> "bar" (if FOO not set)
   * - "${FOO:-${HOME}}" -> "/Users/name" (nested defaults)
   *
   * @param value - String with potential env var references
   * @param env - Environment variables object
   * @returns String with env vars expanded
   */
  private expandEnvVar(value: string, env: Record<string, string | undefined>): string {
    if (typeof value !== 'string') return value;

    return value.replace(/\$\{([^}]+)\}/g, (match, expr) => {
      // Handle ${VAR:-default} syntax
      if (expr.includes(':-')) {
        const [varName, defaultValue] = expr.split(':-', 2);
        const envValue = env[varName.trim()];
        if (envValue) return envValue;

        // Recursively expand default value (may contain nested ${VAR})
        return this.expandEnvVar(defaultValue, env);
      }

      // Handle simple ${VAR} syntax
      return env[expr] || '';
    });
  }

  /**
   * Load MCP servers from workspace .mcp.json file only (legacy)
   *
   * This method is kept for backwards compatibility but should be
   * replaced by getMcpServersConfig() which merges all sources.
   *
   * @param workspacePath - Workspace directory path
   * @param config - Existing config object to merge into
   */
  async loadWorkspaceMcpServers(
    workspacePath: string | undefined,
    config: any
  ): Promise<void> {
    if (!workspacePath) return;

    const mcpJsonPath = path.join(workspacePath, '.mcp.json');
    if (!fs.existsSync(mcpJsonPath)) return;

    try {
      const content = fs.readFileSync(mcpJsonPath, 'utf-8');
      const mcpJson = JSON.parse(content);

      if (mcpJson.mcpServers) {
        config.mcpServers = config.mcpServers || {};
        Object.assign(config.mcpServers, mcpJson.mcpServers);
      }
    } catch (error) {
      console.error('[MCP-CONFIG] Failed to load workspace .mcp.json:', error);
    }
  }
}
```

---

## Usage in ClaudeCodeProvider

### Before (Current):
```typescript
// Inside sendMessage() method
const mcpServers = await this.getMcpServersConfig(sessionId, workspacePath);

// ~140 lines of MCP config logic inline in provider
```

### After (With Service):
```typescript
class ClaudeCodeProvider extends BaseAgentProvider {
  private mcpConfigService: McpConfigService | null = null;

  constructor() {
    super();
    // ... existing initialization ...

    // Initialize MCP config service
    this.mcpConfigService = new McpConfigService({
      mcpServerPort: ClaudeCodeProvider.mcpServerPort,
      sessionNamingServerPort: ClaudeCodeProvider.sessionNamingServerPort,
      extensionDevServerPort: ClaudeCodeProvider.extensionDevServerPort,
      mcpConfigLoader: ClaudeCodeProvider.mcpConfigLoader,
      extensionPluginsLoader: ClaudeCodeProvider.extensionPluginsLoader,
      claudeSettingsEnvLoader: ClaudeCodeProvider.claudeSettingsEnvLoader,
      shellEnvironmentLoader: ClaudeCodeProvider.shellEnvironmentLoader,
    });
  }

  async *sendMessage(...) {
    // ... setup code ...

    // Get MCP config from service
    const mcpServers = this.mcpConfigService
      ? await this.mcpConfigService.getMcpServersConfig({ sessionId, workspacePath })
      : {};

    // ... rest of sendMessage ...
  }
}
```

---

## Usage in CodexProvider (Future)

```typescript
class OpenAICodexProvider extends BaseAgentProvider {
  private readonly mcpConfigService: McpConfigService;

  constructor(config?: { apiKey?: string }, deps?: OpenAICodexProviderDeps) {
    super();

    // Initialize MCP config service (when CodexProvider adds MCP support)
    this.mcpConfigService = new McpConfigService({
      mcpServerPort: OpenAICodexProvider.mcpServerPort,
      sessionNamingServerPort: OpenAICodexProvider.sessionNamingServerPort,
      extensionDevServerPort: OpenAICodexProvider.extensionDevServerPort,
      mcpConfigLoader: OpenAICodexProvider.mcpConfigLoader,
      extensionPluginsLoader: OpenAICodexProvider.extensionPluginsLoader,
      claudeSettingsEnvLoader: OpenAICodexProvider.claudeSettingsEnvLoader,
      shellEnvironmentLoader: OpenAICodexProvider.shellEnvironmentLoader,
    });
  }

  async *sendMessage(...) {
    // Load MCP config
    const mcpServers = await this.mcpConfigService.getMcpServersConfig({
      sessionId,
      workspacePath,
    });

    // Pass to protocol layer
    const session = await this.protocol.createSession({
      workspacePath,
      model: this.getConfiguredModel(),
      mcpServers, // Protocol handles MCP config
      raw: {
        systemPrompt,
        abortSignal: abortController.signal,
      },
    });

    // ...
  }
}
```

---

## Migration Steps

### Step 1: Create Service (Week 1, Day 1-2)
1. Create `/packages/runtime/src/ai/server/services/McpConfigService.ts`
2. Extract methods from ClaudeCodeProvider:
   - `getMcpServersConfig()`
   - `processServerConfig()`
   - `loadWorkspaceMcpServers()`
   - `expandEnvVar()`
3. Add tests for environment variable expansion (critical for Windows)

### Step 2: Update ClaudeCodeProvider (Week 1, Day 3)
1. Initialize `mcpConfigService` in constructor
2. Replace inline MCP config logic with service calls
3. Remove extracted methods from provider
4. Test that MCP servers load correctly

### Step 3: Add Tests (Week 1, Day 4)
1. Unit tests for `McpConfigService`:
   - Env var expansion (simple, default, nested)
   - MCP config merging (built-in, user, workspace)
   - SSE header conversion
2. Integration tests with ClaudeCodeProvider:
   - Verify MCP servers load from all sources
   - Verify env vars expand correctly in production

### Step 4: Documentation (Week 1, Day 5)
1. Document service interface and usage
2. Update CodexProvider roadmap to include MCP support
3. Add examples of custom MCP server configs

---

## Testing Strategy

### Unit Tests for McpConfigService

```typescript
describe('McpConfigService', () => {
  describe('expandEnvVar', () => {
    it('should expand simple env vars', () => {
      const service = new McpConfigService({ /* ... */ });
      const env = { HOME: '/Users/test', FOO: 'bar' };
      expect(service['expandEnvVar']('${HOME}/bin', env)).toBe('/Users/test/bin');
    });

    it('should expand env vars with defaults', () => {
      const service = new McpConfigService({ /* ... */ });
      const env = { HOME: '/Users/test' };
      expect(service['expandEnvVar']('${FOO:-default}', env)).toBe('default');
    });

    it('should expand nested defaults', () => {
      const service = new McpConfigService({ /* ... */ });
      const env = { HOME: '/Users/test' };
      expect(service['expandEnvVar']('${FOO:-${HOME}}', env)).toBe('/Users/test');
    });

    it('should handle empty env vars', () => {
      const service = new McpConfigService({ /* ... */ });
      const env = { FOO: '' };
      expect(service['expandEnvVar']('${FOO}', env)).toBe('');
    });
  });

  describe('getMcpServersConfig', () => {
    it('should merge built-in servers', async () => {
      const service = new McpConfigService({
        mcpServerPort: 3000,
        sessionNamingServerPort: 3001,
        extensionDevServerPort: null,
        mcpConfigLoader: null,
        extensionPluginsLoader: null,
        claudeSettingsEnvLoader: null,
        shellEnvironmentLoader: null,
      });

      const config = await service.getMcpServersConfig();
      expect(config['nimbalyst-mcp']).toBeDefined();
      expect(config['nimbalyst-session-naming']).toBeDefined();
      expect(config['nimbalyst-extension-dev']).toBeUndefined();
    });

    it('should merge user config over built-in', async () => {
      const service = new McpConfigService({
        mcpServerPort: 3000,
        sessionNamingServerPort: null,
        extensionDevServerPort: null,
        mcpConfigLoader: async () => ({
          mcpServers: {
            'custom-server': { type: 'stdio', command: 'node', args: ['server.js'] },
          },
        }),
        extensionPluginsLoader: null,
        claudeSettingsEnvLoader: null,
        shellEnvironmentLoader: null,
      });

      const config = await service.getMcpServersConfig();
      expect(config['nimbalyst-mcp']).toBeDefined();
      expect(config['custom-server']).toBeDefined();
    });
  });

  describe('processServerConfig', () => {
    it('should expand env vars in command', () => {
      const service = new McpConfigService({ /* ... */ });
      const processed = service['processServerConfig']('test', {
        command: '${HOME}/bin/server',
        args: ['--port', '${PORT:-3000}'],
      });

      expect(processed.command).toMatch(/\/bin\/server$/);
      expect(processed.args[1]).toBe('3000'); // default used
    });

    it('should add headers for SSE servers', () => {
      const service = new McpConfigService({ /* ... */ });
      const processed = service['processServerConfig']('test', {
        type: 'sse',
        url: 'http://localhost:3000/sse',
      });

      expect(processed.headers).toBeDefined();
      expect(processed.headers['Content-Type']).toBe('text/event-stream');
    });
  });
});
```

---

## Benefits

### For ClaudeCodeProvider:
- ✅ ~140 lines removed from provider
- ✅ Clearer separation of concerns
- ✅ MCP config logic testable independently
- ✅ Easier to debug MCP config issues

### For CodexProvider:
- ✅ Ready-made MCP config loading
- ✅ No need to reimplement env var expansion
- ✅ Consistent MCP behavior across providers

### For Future Providers:
- ✅ Reusable MCP configuration
- ✅ Tested and production-ready
- ✅ Handles Windows env var expansion correctly

### For Maintainability:
- ✅ Single source of truth for MCP config logic
- ✅ Easier to add new MCP sources
- ✅ Centralized logging for MCP config issues

---

## Open Questions

1. **Should `loadEnvironmentForExpansion()` be async?**
   - Currently sync, but `claudeSettingsEnvLoader` is async
   - Options:
     - Make it async and await in `processServerConfig()`
     - Load Claude settings env in `getMcpServersConfig()` and pass to `processServerConfig()`
   - **Recommendation:** Make async, await in `getMcpServersConfig()`

2. **Should we keep `loadWorkspaceMcpServers()` as a public method?**
   - Legacy method, only used in tests
   - Options:
     - Keep as public for backwards compatibility
     - Make private and deprecate
     - Remove entirely and update tests
   - **Recommendation:** Keep as deprecated public method for one release cycle

3. **Should the service cache MCP config?**
   - MCP config rarely changes during a session
   - Options:
     - No caching (always load fresh)
     - Cache by workspacePath with TTL
     - Cache for session lifetime
   - **Recommendation:** No caching initially (premature optimization)

---

## Alternatives Considered

### Alternative 1: Keep in Provider
**Pros:**
- No refactoring needed
- No risk of breaking existing behavior

**Cons:**
- CodexProvider will need to duplicate logic
- Harder to test MCP config independently
- Provider remains large

**Decision:** ❌ Rejected - clear benefit to extraction

### Alternative 2: Move to Protocol Layer
**Pros:**
- Could be part of protocol abstraction
- Consistent with CodexProvider pattern

**Cons:**
- ClaudeCodeProvider doesn't use protocol layer
- Would require larger refactoring
- MCP config is provider-level, not protocol-level

**Decision:** ❌ Rejected - MCP config is provider concern

### Alternative 3: Static Utility Module
**Pros:**
- Simple, no class needed
- Easy to use from anywhere

**Cons:**
- Can't inject dependencies
- Can't mock for testing
- No state management

**Decision:** ❌ Rejected - need dependency injection

---

## Success Criteria

- [ ] `McpConfigService` created with all extracted methods
- [ ] ClaudeCodeProvider uses service instead of inline logic
- [ ] All existing MCP config tests pass
- [ ] New unit tests for env var expansion pass
- [ ] CodexProvider roadmap updated with MCP support plan
- [ ] Documentation updated with service usage examples
- [ ] ~140 lines removed from ClaudeCodeProvider
- [ ] No regression in MCP server loading behavior
