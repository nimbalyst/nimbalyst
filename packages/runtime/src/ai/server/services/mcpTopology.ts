/**
 * MCP Server Topology — single source of truth for the consolidated internal
 * MCP server layout.
 *
 * See nimbalyst-local/plans/mcp-server-consolidation.md. Three orthogonal axes:
 *
 *  - Axis A — server boundary (`configKey`): the unit of user-meaningful feature
 *    opt-out. The SDK namespaces tools by config-key (`mcp__<configKey>__<tool>`),
 *    so each entry below is an independent server to the agent.
 *  - Axis B — load policy: `eager` (alwaysLoad, paid every session), `deferred`
 *    (registered, surfaced by ToolSearch on intent), or `conditional` (only
 *    registered in the relevant mode). Independent of the boundary — "host, not
 *    a feature" does NOT mean "eager".
 *  - Axis C — transport: one unified internal HTTP server, one port, many
 *    endpoint paths. `endpointPath` is the path each server's connection targets;
 *    the endpoint selects which `ListTools` subset that connection serves.
 *
 * The eager budget is paid only by `alwaysLoad` tools, so the eager set is
 * kept minimal. Everything else defers (or is conditional) until ToolSearch
 * surfaces it on the user's intent.
 *
 * This descriptor is consumed by:
 *  - `McpConfigService.getMcpServersConfig` — decides which `config[name]`
 *    entries to register and with what `alwaysLoad` policy.
 *  - the unified MCP HTTP server — routes each `endpointPath` to its `ListTools`
 *    subset and keeps `CallTool` dispatch centralized.
 */

export type McpLoadPolicy = 'eager' | 'deferred' | 'conditional';

export interface McpServerTopologyEntry {
  /** SDK config-key; tools are exposed as `mcp__<configKey>__<tool>`. */
  configKey: string;
  /** Path on the unified internal HTTP server for this server's connection. */
  endpointPath: string;
  /** Eager / deferred / conditional. Only `eager` pays the always-on budget. */
  loadPolicy: McpLoadPolicy;
  /** Human-meaningful opt-out unit (what a user would say "I don't want X"). */
  optOutUnit: string;
  /**
   * First-party tool names served by this endpoint. Per-extension servers are
   * dynamic (one per extension) and are NOT listed here — see
   * `extensionServerConfigKey` / `extensionServerEndpointPath`.
   */
  tools: string[];
}

// ---------------------------------------------------------------------------
// First-party server config-keys (stable identifiers used across packages).
// ---------------------------------------------------------------------------

// The core endpoint uses the bare `nimbalyst` config-key (not
// `nimbalyst-core`). The shortest prefix (`mcp__nimbalyst__<tool>`) stays on
// the hottest tools, while per-tool metadata controls which core schemas load
// eagerly. Feature/extension servers keep `nimbalyst-<x>` so they can defer
// independently.
export const MCP_CORE = 'nimbalyst';
export const MCP_HOST = 'nimbalyst-host';
export const MCP_TRACKERS = 'nimbalyst-trackers';
export const MCP_SITUATIONAL = 'nimbalyst-situational';
export const MCP_EXTENSION_DEV = 'nimbalyst-extension-dev';

/** Prefix shared by every Nimbalyst server config-key. */
export const MCP_SERVER_CONFIG_PREFIX = 'nimbalyst-';

/** Endpoint path prefix for per-extension servers (`/mcp/ext/<extensionId>`). */
export const MCP_EXTENSION_ENDPOINT_PREFIX = '/mcp/ext/';

/**
 * Config-keys retired by this refactor. Their tools redistribute into the
 * servers above; no aliases are kept (project is pre-public).
 */
export const MCP_RETIRED_SERVER_CONFIG_KEYS: readonly string[] = [
  'nimbalyst-mcp',
  'nimbalyst-session-naming',
  'nimbalyst-settings',
  'nimbalyst-session-context',
  'nimbalyst-meta-agent',
];

// ---------------------------------------------------------------------------
// First-party topology.
// ---------------------------------------------------------------------------

/**
 * Core agent↔host glue. All tools stay registered on the core endpoint, while
 * CORE_ALWAYS_LOAD_TOOLS selects the interaction-critical eager subset.
 */
export const CORE_TOOLS: readonly string[] = [
  'AskUserQuestion',
  'PromptForUserInput',
  'display_to_user',
  'capture_editor_screenshot',
  'get_session_edited_files',
  'developer_git_commit_proposal',
  // NOTE: `developer_git_log` is NOT here — it is contributed by the built-in
  // "Developer Tools" extension (com.nimbalyst.developer, enabledByDefault) and
  // served on its own deferred `nimbalyst-developer` server
  // (`mcp__nimbalyst-developer__developer_git_log`), never on core. Only
  // `developer_git_commit_proposal` has a first-party core handler (the
  // interactive commit widget in interactiveToolHandlers).
  'update_session_meta',
];

/**
 * The subset of CORE_TOOLS that is always loaded into the prompt. Eagerness is
 * now per-TOOL, not per-server: the core server config no longer sets
 * `alwaysLoad: true`; instead the `/mcp/core` ListTools marks these tools with
 * `_meta['anthropic/alwaysLoad']`, which the Claude CLI honors per tool.
 *
 * `display_to_user` stays always-loaded because deferring it made the model
 * guess its argument shape and broke chart rendering (NIM-1766). The two user
 * input tools and first-turn `update_session_meta` are likewise required in
 * every session. Lower-frequency core tools remain registered but defer until
 * ToolSearch surfaces them.
 */
export const CORE_ALWAYS_LOAD_TOOLS: readonly string[] = [
  'AskUserQuestion',
  'PromptForUserInput',
  'display_to_user',
  'update_session_meta',
];

/**
 * Deferred host bucket: app-config + session-context + child-session
 * orchestration + file/content. Host, but rarely needed → never eager.
 */
export const HOST_TOOLS: readonly string[] = [
  // App config (was nimbalyst-settings)
  'settings_get_overview',
  'appearance_set_theme',
  'appearance_set_completion_sound',
  'appearance_set_spellcheck',
  'ai_set_default_model',
  'ai_set_preferred_language',
  'analytics_set_enabled',
  'features_toggle',
  'extension_set_enabled',
  'sync_set_for_project',
  'workspace_create',
  // Keeps `workspace_open` (consistent with workspace_create / workspace_set_trust);
  // resolves the editor `open_workspace` / settings `workspace_open` collision.
  'workspace_open',
  'workspace_set_trust',
  // Session-context (was nimbalyst-session-context)
  'get_session_summary',
  'get_workstream_overview',
  'get_workstream_edited_files',
  'list_recent_sessions',
  'schedule_wakeup',
  'update_session_board',
  // Child-session orchestration (was nimbalyst-meta-agent)
  'create_session',
  'spawn_session',
  'send_prompt',
  'list_queued_prompts',
  'notify_user',
  'respond_to_prompt',
  'get_session_status',
  'get_session_result',
  'list_spawned_sessions',
  'list_worktrees',
  // NOTE: `applyDiff` / `streamContent` are intentionally NOT declared here.
  // They have live CallTool handlers (httpServer switch) + renderer IPC
  // listeners, but no ListTools schema — they are deliberately unadvertised so
  // agents reach for Edit/Write instead. Declaring them in the topology made
  // them phantom entries that no endpoint could ever surface.
];

/**
 * Tracker feature: CRUD + tracker config. Deferred, plus a per-project opt-out
 * that removes the entire server (all tools) from ToolSearch.
 */
export const TRACKER_TOOLS: readonly string[] = [
  'tracker_list',
  'tracker_get',
  'tracker_get_by_urn',
  'tracker_create',
  'tracker_update',
  'tracker_list_types',
  'tracker_define_type',
  'tracker_delete_type',
  'tracker_link_session',
  'tracker_unlink_session',
  'tracker_link_file',
  'tracker_add_comment',
  'tracker_import',
  'tracker_importer_list',
  'tracker_importer_search',
  'tracker_resnapshot',
  // Tracker config — feature owns its config (moved off nimbalyst-settings).
  'tracker_set_sync_policy',
  'tracker_set_issue_key_prefix',
];

/**
 * Situational: voice + collab-doc + feedback. Registered as a DEFERRED server
 * (not conditional) — config-time mode gating was dropped as over-engineering
 * for a deferred server (Phase 6). Because it never loads eagerly it costs
 * nothing until ToolSearch surfaces a tool on intent (voice mode, an open
 * collab doc, filing feedback).
 */
export const SITUATIONAL_TOOLS: readonly string[] = [
  // voice mode only
  'voice_agent_speak',
  'voice_agent_stop',
  // collab doc in context only
  'readCollabDoc',
  'applyCollabDocEdit',
  // shared-index (first-class shared folders + documents) management
  'createSharedDoc',
  'createSharedFolder',
  'moveSharedItem',
  'renameSharedItem',
  'deleteSharedItem',
  // feedback (deferred)
  'feedback_anonymize_text',
  'feedback_get_environment',
  'feedback_open_github_issue',
];

/** Developer-mode tooling. Profile-gated exactly as today (unchanged surface). */
export const EXTENSION_DEV_TOOLS: readonly string[] = [
  'database_query',
  'extension_build',
  'extension_get_status',
  'extension_install',
  'extension_reload',
  'extension_uninstall',
  'extension_test_ai_tool',
  'extension_test_open_file',
  'extension_test_run',
  'get_environment_info',
  'get_main_process_logs',
  'get_renderer_debug_logs',
  'renderer_eval',
  'restart_nimbalyst',
];

/**
 * First-party server topology. Per-extension servers are dynamic and not listed
 * here (one `nimbalyst-<ext>` per active extension; all `deferred`).
 */
export const MCP_FIRST_PARTY_TOPOLOGY: readonly McpServerTopologyEntry[] = [
  {
    configKey: MCP_CORE,
    endpointPath: '/mcp/core',
    loadPolicy: 'eager',
    optOutUnit: 'host (always present)',
    tools: [...CORE_TOOLS],
  },
  {
    configKey: MCP_HOST,
    endpointPath: '/mcp/host',
    loadPolicy: 'deferred',
    optOutUnit: 'host (always present)',
    tools: [...HOST_TOOLS],
  },
  {
    configKey: MCP_TRACKERS,
    endpointPath: '/mcp/trackers',
    loadPolicy: 'deferred',
    optOutUnit: 'tracker feature (per-project trackers.enabled)',
    tools: [...TRACKER_TOOLS],
  },
  {
    configKey: MCP_SITUATIONAL,
    endpointPath: '/mcp/situational',
    loadPolicy: 'conditional',
    optOutUnit: 'per-mode (voice / collab-doc / feedback)',
    tools: [...SITUATIONAL_TOOLS],
  },
  {
    configKey: MCP_EXTENSION_DEV,
    endpointPath: '/mcp/extension-dev',
    loadPolicy: 'deferred',
    optOutUnit: 'developer mode (profile-gated)',
    tools: [...EXTENSION_DEV_TOOLS],
  },
];

// ---------------------------------------------------------------------------
// Per-extension server helpers.
// ---------------------------------------------------------------------------

/**
 * Config-key for an extension's own deferred MCP server, e.g.
 * `nimbalyst-excalidraw`. `extensionShortName` is the extension id's last
 * dotted segment (`com.nimbalyst.excalidraw` → `excalidraw`).
 */
export function extensionServerConfigKey(extensionShortName: string): string {
  return `${MCP_SERVER_CONFIG_PREFIX}${extensionShortName}`;
}

/** Endpoint path for an extension's server, e.g. `/mcp/ext/excalidraw`. */
export function extensionServerEndpointPath(extensionShortName: string): string {
  return `${MCP_EXTENSION_ENDPOINT_PREFIX}${extensionShortName}`;
}

/** True if a config-key is a per-extension server (`nimbalyst-<ext>`). */
export function isExtensionServerConfigKey(configKey: string): boolean {
  if (!configKey.startsWith(MCP_SERVER_CONFIG_PREFIX)) return false;
  const firstParty = new Set(MCP_FIRST_PARTY_TOPOLOGY.map((e) => e.configKey));
  return !firstParty.has(configKey);
}

// ---------------------------------------------------------------------------
// Derived lookups.
// ---------------------------------------------------------------------------

/** The only `alwaysLoad` (eager) server config-key(s). */
export const MCP_EAGER_CONFIG_KEYS: readonly string[] = MCP_FIRST_PARTY_TOPOLOGY
  .filter((e) => e.loadPolicy === 'eager')
  .map((e) => e.configKey);

/** True if a server is eager (`alwaysLoad`). */
export function isEagerServer(configKey: string): boolean {
  return MCP_EAGER_CONFIG_KEYS.includes(configKey);
}

/** Topology entry for a first-party config-key, or undefined. */
export function getFirstPartyServer(configKey: string): McpServerTopologyEntry | undefined {
  return MCP_FIRST_PARTY_TOPOLOGY.find((e) => e.configKey === configKey);
}

/**
 * Reverse index: first-party tool name → owning server config-key. Used by the
 * unified HTTP server to route a tool to the endpoint that should list it.
 */
export const FIRST_PARTY_TOOL_TO_SERVER: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const entry of MCP_FIRST_PARTY_TOPOLOGY) {
    for (const tool of entry.tools) {
      map.set(tool, entry.configKey);
    }
  }
  return map;
})();

// The staged-migration scaffolding (a `MCP_MIGRATED_FIRST_PARTY_KEYS` set, an
// `isFirstPartyToolMigratedOffLegacy` filter, and a `MCP_EXTENSIONS_MIGRATED_*`
// flag that kept the legacy monolith and the split servers running in parallel)
// is gone: the consolidation is complete. Every first-party tool now lives on
// its split server (core / host / trackers / situational), every extension on
// its own `nimbalyst-<ext>` server, and the legacy `nimbalyst-mcp` (`/mcp`)
// monolith is retired.
