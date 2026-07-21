/**
 * McpConfigService - Manages MCP server configuration for AI providers
 *
 * This service handles:
 * - Loading MCP servers from user config (~/.config/claude/mcp.json)
 * - Loading workspace-specific MCP servers (.mcp.json)
 * - Merging built-in Nimbalyst MCP servers with user configs
 * - Expanding environment variables in server configurations
 * - Processing server configs for different transport types (stdio, sse)
 *
 * The service is designed to be reusable across different AI providers
 * (ClaudeCodeProvider, CodexProvider, etc.)
 */

import {
  MCP_CORE,
  MCP_HOST,
  MCP_TRACKERS,
  MCP_SITUATIONAL,
  extensionServerConfigKey,
  extensionServerEndpointPath,
} from './mcpTopology';

export interface McpConfigServiceDeps {
  /** Port for the unified internal Nimbalyst MCP HTTP server (all endpoints). */
  mcpServerPort: number | null;

  /** Port for the extension development MCP server (profile-gated, separate server). */
  extensionDevServerPort: number | null;

  /**
   * Kill-switch loader for the settings tools. Returns true to omit the settings
   * tools from `nimbalyst-host`. Read on every config build so flipping the
   * toggle in Settings takes effect on the next session start without a restart.
   */
  settingsAgentToolsDisabledLoader?: (() => boolean) | null;

  /**
   * Per-project opt-out for the tracker feature. Returns true to omit the
   * entire `nimbalyst-trackers` server (see mcpTopology). Read on every config
   * build, mirroring `settingsAgentToolsDisabledLoader`.
   *
   * Takes the workspace path because `trackers.enabled` is a per-project
   * workspace setting (unlike the global settings kill-switch). When the loader
   * is absent the tracker server registers by default (opt-out, default on).
   */
  trackersAgentToolsDisabledLoader?: ((workspacePath?: string) => boolean) | null;

  /**
   * Returns the short-names of currently-active extensions that contribute MCP
   * tools for the given workspace (e.g. `['excalidraw', 'slides']`). Each
   * becomes its own deferred `nimbalyst-<ext>` server (see mcpTopology
   * `extensionServerConfigKey`). Read on every config build so newly-loaded
   * extensions get a server on the next session start.
   */
  extensionMcpServerNamesLoader?: ((workspacePath?: string) => string[]) | null;

  /**
   * Per-launch bearer token for the internal Nimbalyst MCP HTTP servers.
   * When set, the service emits an `Authorization: Bearer <token>` header on
   * each `nimbalyst-*` server config. When null, no auth header is sent
   * (test/legacy compatibility).
   */
  mcpAuthToken?: string | null;

  /**
   * Main-process issuer for an opaque credential bound to one authenticated
   * actor session and canonical MCP workspace. Used instead of the process
   * bearer whenever a session-bearing internal config is built.
   */
  mcpSessionCredentialIssuer?: ((authority: {
    actorSessionId: string;
    workspacePath: string;
  }) => string) | null;

  /** Loader for user and workspace MCP server configs */
  mcpConfigLoader: ((workspacePath?: string) => Promise<Record<string, any>>) | null;

  /** Loader for Claude settings environment variables */
  claudeSettingsEnvLoader: (() => Promise<Record<string, string>>) | null;

  /** Loader for shell environment variables */
  shellEnvironmentLoader: (() => Record<string, string> | null) | null;
}

/**
 * Service for loading and processing MCP server configurations
 */
export class McpConfigService {
  private deps: McpConfigServiceDeps;

  constructor(deps: McpConfigServiceDeps) {
    this.deps = deps;
  }

  /**
   * Get merged MCP server configuration from all sources:
   * 1. Built-in Nimbalyst MCP servers (nimbalyst core/host/trackers/situational, per-extension, extension-dev)
   * 2. User-level MCP servers (~/.config/claude/mcp.json)
   * 3. Workspace-level MCP servers (.mcp.json)
   *
   * Priority order: built-in < user < workspace
   *
   * @param options.sessionId - Session ID for session-specific servers
   * @param options.workspacePath - Workspace path for workspace-specific servers
   * @returns Merged MCP server configuration object
   */
  async getMcpServersConfig(
    options: { sessionId?: string; workspacePath?: string; profile?: 'standard' | 'meta-agent' }
  ): Promise<Record<string, any>> {
    const { sessionId, workspacePath, profile = 'standard' } = options;
    const config: any = {};
    const isMetaAgent = profile === 'meta-agent';

    // Authorization header for the internal Nimbalyst MCP HTTP servers.
    // Issue #146: localhost MCP servers require a per-launch bearer token.
    // Both the Claude Agent SDK and Codex SDK accept `headers` on remote MCP
    // server configs and forward them on every request.
    const scopedCredential = sessionId && workspacePath && this.deps.mcpSessionCredentialIssuer
      ? this.deps.mcpSessionCredentialIssuer({
          actorSessionId: sessionId,
          workspacePath,
        })
      : null;
    const effectiveAuthToken = scopedCredential ?? this.deps.mcpAuthToken;
    const authHeaders: Record<string, string> | undefined = effectiveAuthToken
      ? { Authorization: `Bearer ${effectiveAuthToken}` }
      : undefined;

    // The internal Nimbalyst MCP surface is served by the unified HTTP server on
    // `this.deps.mcpServerPort`, split across endpoint paths (one `config[name]`
    // per server below). The legacy monolithic `nimbalyst-mcp` (`/mcp`) is fully
    // retired — every tool now lives on a split server (core / host / trackers /
    // situational / per-extension). `applyDiff` and `streamContent` are NOT
    // exposed via MCP — they're chat-provider IPC only.
    if (this.deps.mcpServerPort !== null && workspacePath) {
      const port = this.deps.mcpServerPort;
      const wsParam = `workspacePath=${encodeURIComponent(workspacePath)}`;
      const sessParam = sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : '';
      const query = `?${wsParam}${sessParam}`;
      const endpointUrl = (endpointPath: string) =>
        `http://127.0.0.1:${port}${endpointPath}${query}`;

      // nimbalyst (core) — universal agent↔host glue. Eagerness is per-TOOL,
      // not server-level: /mcp/core ListTools marks CORE_ALWAYS_LOAD_TOOLS with
      // `_meta['anthropic/alwaysLoad']` (applyCoreAlwaysLoadMeta). The
      // interactive/session tools plus the visual tools (display_to_user /
      // capture_editor_screenshot, which the prompt tells the model to use)
      // stay in the prompt this way. Carries the long tool timeout because
      // developer_git_commit_proposal / AskUserQuestion / PromptForUserInput
      // block indefinitely on user input.
      config[MCP_CORE] = {
        type: 'sse',
        transport: 'sse',
        url: endpointUrl('/mcp/core'),
        tool_timeout_sec: 604800,
        ...(authHeaders ? { headers: { ...authHeaders } } : {}),
      };

      // nimbalyst-trackers (deferred) — tracker CRUD on `/mcp/trackers`. Per-
      // project opt-out: when the workspace's `trackers.enabled` is off the
      // loader returns true and the whole server (all tracker_* tools) is
      // omitted from ToolSearch. Deferred, so it never touches the eager budget;
      // legacy `/mcp` stops listing tracker tools automatically via the
      // migration-state check in mcpTopology. No long tool_timeout_sec — tracker
      // operations don't block on user input.
      const trackersKilled = (() => {
        try {
          return !!this.deps.trackersAgentToolsDisabledLoader?.(workspacePath);
        } catch {
          return false;
        }
      })();
      if (!trackersKilled) {
        config[MCP_TRACKERS] = {
          type: 'sse',
          transport: 'sse',
          url: endpointUrl('/mcp/trackers'),
          ...(authHeaders ? { headers: { ...authHeaders } } : {}),
        };
      }

      // nimbalyst-host (deferred) — app-config (settings) + session-context +
      // child-session orchestration (meta-agent) on `/mcp/host` (MCP
      // consolidation Phase 5). Never eager. The settings tools within host are
      // excluded for the meta-agent profile (so it can't twiddle user prefs
      // while orchestrating) and when the settings kill-switch is on; the
      // unified server reads `hostExcludeSettings` to drop just those tools
      // while keeping session-context + meta-agent. (`update_session_meta` folds
      // into the eager core above, not host.)
      const settingsKilled = (() => {
        try {
          return !!this.deps.settingsAgentToolsDisabledLoader?.();
        } catch {
          return false;
        }
      })();
      const excludeSettings = isMetaAgent || settingsKilled;
      config[MCP_HOST] = {
        type: 'sse',
        transport: 'sse',
        url:
          endpointUrl('/mcp/host') +
          (excludeSettings ? '&hostExcludeSettings=1' : ''),
        ...(authHeaders ? { headers: { ...authHeaders } } : {}),
      };

      // nimbalyst-situational (deferred) — voice + collab-doc + feedback tools on
      // `/mcp/situational` (MCP consolidation Phase 6). Deferred, so it never
      // touches the eager budget; the agent only reaches for these when its mode
      // calls for them (voice mode, an open collab doc, filing feedback) and
      // ToolSearch surfaces them on intent. Replaces the situational slice of the
      // retired legacy monolith.
      config[MCP_SITUATIONAL] = {
        type: 'sse',
        transport: 'sse',
        url: endpointUrl('/mcp/situational'),
        ...(authHeaders ? { headers: { ...authHeaders } } : {}),
      };

      if (this.deps.extensionMcpServerNamesLoader) {
        let extensionShortNames: string[] = [];
        try {
          extensionShortNames =
            this.deps.extensionMcpServerNamesLoader(workspacePath) ?? [];
        } catch {
          extensionShortNames = [];
        }
        for (const shortName of extensionShortNames) {
          if (!shortName) continue;
          config[extensionServerConfigKey(shortName)] = {
            type: 'sse',
            transport: 'sse',
            url: endpointUrl(extensionServerEndpointPath(shortName)),
            ...(authHeaders ? { headers: { ...authHeaders } } : {}),
          };
        }
      }
    }

    // MCP consolidation Phase 5: the standalone session-naming, session-context,
    // meta-agent, and settings HTTP servers are no longer registered as separate
    // SDK config entries — their tools fold onto the unified server's `/mcp/core`
    // (update_session_meta) and `/mcp/host` endpoints above. The standalone HTTP
    // servers keep running until Phase 7 retires their ports, but the agent only
    // connects to the unified endpoints now.

    // Include extension dev MCP server if it's started (provides build, install, reload tools)
    if (!isMetaAgent && this.deps.extensionDevServerPort !== null) {
      const params = workspacePath ? `?workspacePath=${encodeURIComponent(workspacePath)}` : '';
      config['nimbalyst-extension-dev'] = {
        type: 'sse',
        transport: 'sse',
        url: `http://127.0.0.1:${this.deps.extensionDevServerPort}/mcp${params}`,
        ...(authHeaders ? { headers: { ...authHeaders } } : {}),
      };
    }

    // Super Loop progress MCP server disabled - was leaking into non-super-loop sessions
    // TODO: Re-enable with proper gating so it only appears in super loop sessions

    // Load user and workspace MCP servers using the injected loader (if available)
    // This merges user-level (global) servers with workspace-level servers
    if (this.deps.mcpConfigLoader) {
      try {
        const mergedServers = await this.deps.mcpConfigLoader(workspacePath);

        // Process each server config
        for (const [serverName, serverConfig] of Object.entries(mergedServers)) {
          const processedConfig = await this.processServerConfig(serverName, serverConfig as any);
          config[serverName] = processedConfig;
        }
      } catch (error) {
        console.error('[MCP-CONFIG] Failed to load MCP servers from config loader:', error);
        // Fall back to workspace-only loading
        await this.loadWorkspaceMcpServers(workspacePath, config);
      }
    } else {
      // Fallback: Load from workspace .mcp.json only (legacy behavior)
      await this.loadWorkspaceMcpServers(workspacePath, config);
    }

    return config;
  }

  /**
   * Process a single MCP server config, expanding env vars and converting to headers where needed
   *
   * For stdio transport:
   * - Expands environment variables in args array
   * - Expands env object values
   *
   * For SSE transport:
   * - Converts API key env vars to Authorization headers
   * - Removes env object (not used for SSE)
   *
   * @param serverName - Name of the MCP server
   * @param serverConfig - Raw server configuration
   * @returns Processed server configuration
   */
  private async processServerConfig(serverName: string, serverConfig: any): Promise<any> {
    const processedConfig = { ...serverConfig };
    const transportType = processedConfig.type === 'sse' || processedConfig.type === 'http'
      ? processedConfig.type
      : 'stdio';

    // Normalize transport-specific fields so stale config data does not leak
    // into downstream providers. Codex flattens config overrides into
    // repeated `--config a.b.c=value` flags and rejects mixed stdio/remote
    // fields like `command` + `url` on the same server.
    processedConfig.type = transportType;
    if (transportType === 'stdio') {
      delete processedConfig.url;
      delete processedConfig.headers;
    } else {
      delete processedConfig.command;
      delete processedConfig.args;
    }

    // Load environment for variable expansion
    const env = await this.loadEnvironmentForExpansion();

    // Build combined env: loaded env + config.env (config.env takes precedence)
    const combinedEnv: Record<string, string | undefined> = { ...env };
    if (processedConfig.env) {
      for (const [key, value] of Object.entries(processedConfig.env)) {
        combinedEnv[key] = this.expandEnvVar(value as string, combinedEnv);
      }
    }

    // For stdio transport, expand env vars in args
    // This is critical for Windows where shell doesn't expand ${VAR} syntax
    if (transportType === 'stdio' && processedConfig.args && Array.isArray(processedConfig.args)) {
      processedConfig.args = processedConfig.args.map((arg: string) =>
        typeof arg === 'string' ? this.expandEnvVar(arg, combinedEnv) : arg
      );
    }

    // For SSE transport, convert env vars to headers (SDK requirement)
    if (transportType === 'sse' && processedConfig.env) {
      processedConfig.headers = processedConfig.headers || {};

      // Convert API keys from env to Authorization headers
      for (const [key, value] of Object.entries(processedConfig.env)) {
        if (key.endsWith('_API_KEY')) {
          // Expand environment variable if needed
          const expandedValue = this.expandEnvVar(value as string, env);
          if (expandedValue && !expandedValue.startsWith('${')) {
            processedConfig.headers['Authorization'] = `Bearer ${expandedValue}`;
          }
        }
      }

      // Remove env from SSE config (not used for SSE transport)
      delete processedConfig.env;
    }

    return processedConfig;
  }

  /**
   * Load MCP servers from workspace .mcp.json only (legacy fallback)
   *
   * This method is called when the mcpConfigLoader is not available
   * or when it fails to load configs.
   *
   * @param workspacePath - Path to the workspace
   * @param config - Existing config object to merge into
   */
  private async loadWorkspaceMcpServers(workspacePath: string | undefined, config: any): Promise<void> {
    if (!workspacePath) return;

    try {
      const fs = require('fs');
      const path = require('path');
      const mcpJsonPath = path.join(workspacePath, '.mcp.json');

      if (fs.existsSync(mcpJsonPath)) {
        const mcpJsonContent = fs.readFileSync(mcpJsonPath, 'utf8');
        const mcpConfig = JSON.parse(mcpJsonContent);

        if (mcpConfig.mcpServers && typeof mcpConfig.mcpServers === 'object') {
          // Process and merge workspace MCP servers with built-in servers
          for (const [serverName, serverConfig] of Object.entries(mcpConfig.mcpServers)) {
            const processedConfig = await this.processServerConfig(serverName, serverConfig as any);
            config[serverName] = processedConfig;
          }
        }
      }
    } catch (error) {
      console.error('[MCP-CONFIG] Failed to load .mcp.json:', error);
    }
  }

  /**
   * Expand environment variable syntax: ${VAR} and ${VAR:-default}
   *
   * Supports:
   * - Simple replacement: ${HOME} -> /Users/username
   * - Default values: ${MISSING:-fallback} -> fallback
   *
   * Note: Nested defaults like ${FOO:-${HOME}} are not fully supported.
   * The outer variable will be replaced with the literal default value,
   * which may still contain unexpanded variables.
   *
   * @param value - String potentially containing env var references
   * @param env - Environment variable map
   * @returns String with env vars expanded
   */
  private expandEnvVar(value: string, env: Record<string, string | undefined>): string {
    return value.replace(/\$\{([^}:]+)(:-([^}]+))?\}/g, (_, varName, __, defaultValue) => {
      const envValue = env[varName];
      if (envValue !== undefined) {
        return envValue;
      }
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      // Variable not set and no default - return original
      return `\${${varName}}`;
    });
  }

  /**
   * Load environment variables for expansion from all available sources
   *
   * Priority order:
   * 1. process.env (always available)
   * 2. Shell environment (from login shell, includes AWS_*, etc.)
   * 3. Claude settings env (from ~/.claude/settings.json)
   *
   * @returns Merged environment variable map
   */
  private async loadEnvironmentForExpansion(): Promise<Record<string, string | undefined>> {
    const env: Record<string, string | undefined> = {
      ...(process.env as Record<string, string | undefined>)
    };

    // Load shell environment if available
    if (this.deps.shellEnvironmentLoader) {
      try {
        const shellEnv = this.deps.shellEnvironmentLoader();
        if (shellEnv) {
          Object.assign(env, shellEnv);
        }
      } catch (error) {
        console.warn('[MCP-CONFIG] Failed to load shell environment:', error);
      }
    }

    // Load Claude settings env if available
    if (this.deps.claudeSettingsEnvLoader) {
      try {
        const settingsEnv = await this.deps.claudeSettingsEnvLoader();
        if (settingsEnv) {
          Object.assign(env, settingsEnv);
        }
      } catch (error) {
        console.warn('[MCP-CONFIG] Failed to load Claude settings environment:', error);
      }
    }

    return env;
  }
}
