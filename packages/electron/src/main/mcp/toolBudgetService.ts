/**
 * Live MCP tool-budget report for the Tools & MCP visibility UI.
 *
 * Enumerates the same tool schemas the unified MCP HTTP server serves per
 * endpoint (first-party topology servers plus one server per active extension)
 * and measures each group's serialized ListTools size with the runtime's
 * mcpTokenBudget estimator, so the settings panel and the context-usage
 * breakdown can show "what would this group cost if surfaced".
 *
 * User-configured .mcp.json servers are included as rows WITHOUT a token
 * estimate: their schemas live in external server processes we don't connect
 * to from here, so we only report presence/enablement for them.
 */

import {
  MCP_FIRST_PARTY_TOPOLOGY,
  FIRST_PARTY_TOOL_TO_SERVER,
  MCP_CORE,
  MCP_TRACKERS,
  MCP_HOST,
  CORE_ALWAYS_LOAD_TOOLS,
  extensionServerConfigKey,
  measureToolList,
  type McpLoadPolicy,
  type MeasurableToolSchema,
} from '@nimbalyst/runtime/ai/server';
import {
  getAvailableExtensionTools,
  getAvailableBackendTools,
} from './mcpWorkspaceResolver';
import { extensionShortNameFromId } from './mcpEndpointRouting';
import { getEditorToolSchemas } from './tools/editorToolHandlers';
import { displayToolSchemas } from './tools/displayToolHandler';
import { voiceToolSchemas } from './tools/voiceToolHandlers';
import { getInteractiveToolSchemas } from './tools/interactiveToolHandlers';
import { trackerToolSchemas } from './tools/trackerToolHandlers';
import { feedbackToolSchemas } from './tools/feedbackToolHandlers';
import { settingsToolSchemas } from './settingsServer';
import { SESSION_CONTEXT_TOOL_SCHEMAS } from './sessionContextServer';
import { META_AGENT_TOOL_DEFS } from './metaAgentServer';
import { buildSessionMetaToolSchemas } from './sessionNamingServer';
import { isSettingsAgentToolsDisabled, isTrackersAgentToolsEnabled } from '../utils/store';
import { MCPConfigService } from '../services/MCPConfigService';

export type ToolGroupSource = 'core' | 'first-party' | 'extension' | 'user';

export interface ToolGroupBudget {
  /** Server config-key (`mcp__<configKey>__<tool>`), or the user server name. */
  configKey: string;
  /** Human label for the row ("Core", "Trackers", extension display name, …). */
  displayName: string;
  source: ToolGroupSource;
  /** Eager pays the always-on budget; deferred/conditional cost nothing until surfaced. */
  loadPolicy: McpLoadPolicy | 'external';
  toolCount: number;
  /** Estimated tokens when this group's ListTools is surfaced; null when unknown (user servers). */
  estTokens: number | null;
  /**
   * For groups with per-tool eagerness (core): the tokens actually charged to
   * every session — only the `_meta['anthropic/alwaysLoad']` subset. Absent
   * when the whole group shares one load policy.
   */
  alwaysLoadEstTokens?: number;
  /** Current enablement per the same loaders the session config uses. */
  enabled: boolean;
  /** True for groups the app requires (core); the UI must not offer a toggle. */
  lockedOn: boolean;
}

export interface ToolBudgetSnapshot {
  groups: ToolGroupBudget[];
  /**
   * The fixed tool floor of a new session: for eager+enabled groups, the
   * always-load subset cost when the group has one (core), else the whole
   * group's estTokens.
   */
  eagerEstTokens: number;
}

const FIRST_PARTY_DISPLAY_NAMES: Record<string, string> = {
  [MCP_CORE]: 'Core',
  [MCP_HOST]: 'Host & sessions',
  [MCP_TRACKERS]: 'Trackers',
  'nimbalyst-situational': 'Voice, collab docs & feedback',
  'nimbalyst-extension-dev': 'Extension development',
};

// The interactive/editor schema builders gate their session-scoped tools
// (AskUserQuestion, PromptForUserInput, developer_git_commit_proposal,
// get_session_edited_files) behind a truthy sessionId. A live agent session
// always has one, so measure with a placeholder — passing undefined undercounts
// the eager core by those tools' entire schema weight.
const MEASUREMENT_SESSION_ID = 'tool-budget-measurement';

function collectFirstPartySchemas(sessionMetaSchemas: MeasurableToolSchema[]): MeasurableToolSchema[] {
  // Mirrors the unified HTTP server's ListTools collection (httpServer.ts).
  return [
    ...getEditorToolSchemas(MEASUREMENT_SESSION_ID),
    ...displayToolSchemas,
    ...voiceToolSchemas,
    ...getInteractiveToolSchemas(MEASUREMENT_SESSION_ID),
    ...trackerToolSchemas,
    ...feedbackToolSchemas,
    ...settingsToolSchemas,
    ...SESSION_CONTEXT_TOOL_SCHEMAS,
    ...META_AGENT_TOOL_DEFS,
    ...sessionMetaSchemas,
  ] as MeasurableToolSchema[];
}

const mcpConfigService = new MCPConfigService();

export async function getToolBudgetSnapshot(workspacePath?: string): Promise<ToolBudgetSnapshot> {
  const groups: ToolGroupBudget[] = [];

  // ---- First-party topology servers ----
  const sessionMetaSchemas = (await buildSessionMetaToolSchemas('')) as MeasurableToolSchema[];
  const allFirstParty = collectFirstPartySchemas(sessionMetaSchemas);
  const byServer = new Map<string, MeasurableToolSchema[]>();
  for (const tool of allFirstParty) {
    const server = FIRST_PARTY_TOOL_TO_SERVER.get(tool.name);
    if (!server) continue; // retired/unmapped tools are not served anywhere
    const list = byServer.get(server) ?? [];
    list.push(tool);
    byServer.set(server, list);
  }

  const settingsToolNames = new Set(settingsToolSchemas.map((t) => t.name));
  const settingsKilled = isSettingsAgentToolsDisabled();
  const trackersEnabled = workspacePath ? isTrackersAgentToolsEnabled(workspacePath) : true;

  for (const entry of MCP_FIRST_PARTY_TOPOLOGY) {
    let tools = byServer.get(entry.configKey) ?? [];
    // The host endpoint drops the settings tools when the kill-switch is on;
    // reflect that in the measured surface rather than reporting a cost the
    // agent can never be charged.
    if (entry.configKey === MCP_HOST && settingsKilled) {
      tools = tools.filter((t) => !settingsToolNames.has(t.name));
    }
    const { estTokens } = measureToolList(tools);
    const enabled = entry.configKey === MCP_TRACKERS ? trackersEnabled : true;
    // Core eagerness is per-tool: only the always-load subset hits every
    // session's prompt; the rest of core defers behind tool search.
    const alwaysLoadEstTokens =
      entry.configKey === MCP_CORE
        ? measureToolList(tools.filter((t) => CORE_ALWAYS_LOAD_TOOLS.includes(t.name))).estTokens
        : undefined;
    groups.push({
      configKey: entry.configKey,
      displayName: FIRST_PARTY_DISPLAY_NAMES[entry.configKey] ?? entry.configKey,
      source: entry.configKey === MCP_CORE ? 'core' : 'first-party',
      loadPolicy: entry.loadPolicy,
      toolCount: tools.length,
      estTokens,
      ...(alwaysLoadEstTokens !== undefined && { alwaysLoadEstTokens }),
      enabled,
      lockedOn: entry.configKey === MCP_CORE,
    });
  }

  // ---- Per-extension servers (active extensions only) ----
  const extensionTools = await getAvailableExtensionTools(workspacePath, undefined);
  const backendTools = await getAvailableBackendTools(workspacePath, undefined);
  const byExtension = new Map<string, { displayName: string; tools: MeasurableToolSchema[] }>();
  for (const tool of [...extensionTools, ...backendTools]) {
    const shortName = extensionShortNameFromId(tool.extensionId);
    const entry = byExtension.get(shortName) ?? { displayName: shortName, tools: [] };
    entry.tools.push({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
    byExtension.set(shortName, entry);
  }
  for (const [shortName, { displayName, tools }] of [...byExtension.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const { estTokens } = measureToolList(tools);
    groups.push({
      configKey: extensionServerConfigKey(shortName),
      displayName,
      source: 'extension',
      loadPolicy: 'deferred',
      toolCount: tools.length,
      estTokens,
      enabled: true, // disabled extensions contribute no tools, so they never appear here
      lockedOn: false,
    });
  }

  // ---- User .mcp.json servers (schemas unknown from here) ----
  try {
    const merged = await mcpConfigService.getMergedConfig(workspacePath);
    for (const [name, config] of Object.entries(merged?.mcpServers ?? {})) {
      const serverConfig = config as { disabled?: boolean };
      groups.push({
        configKey: name,
        displayName: name,
        source: 'user',
        loadPolicy: 'external',
        toolCount: 0,
        estTokens: null,
        enabled: serverConfig.disabled !== true,
        lockedOn: false,
      });
    }
  } catch {
    // No user config / unreadable — the report is still useful without it.
  }

  const eagerEstTokens = groups
    .filter((g) => g.loadPolicy === 'eager' && g.enabled)
    .reduce((sum, g) => sum + (g.alwaysLoadEstTokens ?? g.estTokens ?? 0), 0);

  return { groups, eagerEstTokens };
}
