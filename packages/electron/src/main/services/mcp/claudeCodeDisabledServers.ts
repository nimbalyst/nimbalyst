/**
 * Project Nimbalyst's MCP on/off state into Claude Code's own config (NIM-2372).
 *
 * Nimbalyst stores its user-scope servers in the user's `~/.claude.json` and
 * marks the off ones with fields the CLI has never heard of (`disabled`,
 * `enabledForProviders`). The CLI loaded them anyway, and the old fix was to
 * make it ignore its entire ecosystem (`--strict-mcp-config`) — which killed
 * claude.ai connectors and hard-failed under an enterprise MCP config.
 *
 * The CLI already has the feature we reinvented. `/mcp disable <server>` writes:
 *
 *   user / local scope   ~/.claude.json  projects[cwd].disabledMcpServers
 *   project .mcp.json    .claude/settings.local.json  disabledMcpjsonServers
 *
 * So we write those instead. Consequence, accepted deliberately: a server turned
 * off in Nimbalyst is off for that project in the user's own `claude` too.
 *
 * These files are co-owned with the CLI and with the user, so every update is a
 * read-modify-write that only touches names Nimbalyst actually manages. A name
 * the user disabled by hand for a server we don't know about stays disabled.
 */

import {
  isMCPServerEnabledForProvider,
  MCP_PROVIDER_IDS,
  type MCPServerConfig,
} from '@nimbalyst/runtime/types/MCPServerConfig';

export interface ClaudeDisabledServersInput {
  /** Every server name Nimbalyst manages for this workspace (user + workspace scope). */
  knownNames: string[];
  /** The subset that is OFF for Claude Code. */
  disabledNames: string[];
}

/**
 * Derive the projection input from a workspace's merged server map.
 *
 * Single-sourced because two paths write these files — session start and the
 * Settings toggle — and a disagreement about what "off" means would show up as
 * a server the panel says is off that `claude` still loads.
 */
export function claudeDisabledServersInput(
  allServers: Record<string, MCPServerConfig>,
): ClaudeDisabledServersInput {
  const knownNames = Object.keys(allServers);
  return {
    knownNames,
    disabledNames: knownNames.filter(
      (name) => !isMCPServerEnabledForProvider(allServers[name], MCP_PROVIDER_IDS.CLAUDE_AGENT),
    ),
  };
}

export interface ClaudeConfigShape {
  projects?: Record<string, { disabledMcpServers?: string[]; [key: string]: any }>;
  [key: string]: any;
}

export interface ClaudeSettingsShape {
  disabledMcpjsonServers?: string[];
  [key: string]: any;
}

/** Coerce a co-owned JSON value we did not write into a string list. */
function toNameList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/**
 * Names Nimbalyst does not manage keep their existing position; the managed
 * disabled set is appended in a stable order so repeat writes are byte-stable.
 */
function reconcile(existing: unknown, knownNames: string[], disabledNames: string[]): string[] {
  const known = new Set(knownNames);
  const foreign = toNameList(existing).filter((name) => !known.has(name));
  const managed = [...new Set(disabledNames.filter((name) => known.has(name)))].sort();
  return [...new Set([...foreign, ...managed])];
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Update `projects[workspacePath].disabledMcpServers`. Returns the config to
 * write and whether anything actually changed (callers skip the write when not,
 * so we don't churn a file the CLI watches).
 */
export function applyDisabledServersToClaudeConfig(
  claudeConfig: ClaudeConfigShape,
  workspacePath: string,
  input: ClaudeDisabledServersInput,
): { config: ClaudeConfigShape; changed: boolean } {
  const config: ClaudeConfigShape = { ...claudeConfig };
  const projects = { ...(config.projects ?? {}) };
  const entry = { ...(projects[workspacePath] ?? {}) };

  const existing = toNameList(entry.disabledMcpServers);
  const next = reconcile(entry.disabledMcpServers, input.knownNames, input.disabledNames);

  const hadKey = Object.prototype.hasOwnProperty.call(entry, 'disabledMcpServers');
  const changed = next.length > 0 ? !sameList(existing, next) : hadKey;
  if (!changed) {
    return { config: claudeConfig, changed: false };
  }

  if (next.length > 0) {
    entry.disabledMcpServers = next;
  } else {
    delete entry.disabledMcpServers;
  }
  projects[workspacePath] = entry;
  config.projects = projects;
  return { config, changed: true };
}

/**
 * Update `disabledMcpjsonServers` in the workspace's `.claude/settings.local.json`.
 * Only servers that actually come from `.mcp.json` belong in this list — the CLI
 * resolves the two scopes through different keys.
 */
export function applyDisabledMcpjsonServersToSettings(
  settings: ClaudeSettingsShape,
  input: ClaudeDisabledServersInput,
  mcpJsonNames: string[],
): { settings: ClaudeSettingsShape; changed: boolean } {
  const fromMcpJson = new Set(mcpJsonNames);
  const scoped: ClaudeDisabledServersInput = {
    knownNames: input.knownNames.filter((name) => fromMcpJson.has(name)),
    disabledNames: input.disabledNames.filter((name) => fromMcpJson.has(name)),
  };

  const existing = toNameList(settings.disabledMcpjsonServers);
  const next = reconcile(settings.disabledMcpjsonServers, scoped.knownNames, scoped.disabledNames);

  const hadKey = Object.prototype.hasOwnProperty.call(settings, 'disabledMcpjsonServers');
  const changed = next.length > 0 ? !sameList(existing, next) : hadKey;
  if (!changed) {
    return { settings, changed: false };
  }

  const updated: ClaudeSettingsShape = { ...settings };
  if (next.length > 0) {
    updated.disabledMcpjsonServers = next;
  } else {
    delete updated.disabledMcpjsonServers;
  }
  return { settings: updated, changed: true };
}
