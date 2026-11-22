/**
 * `nim mcp --plugin-root <dir>` and `nim mcp --plugin-agent codex`: the
 * `nimbalyst-local` server as the nimbalyst-wiki plugin starts it, through a
 * pinned `npx @nimbalyst/cli@<version>`. Claude Code passes
 * `${CLAUDE_PLUGIN_ROOT}` and starts it in the project. Codex expands no
 * variables in a plugin's MCP args and npx replaces `PWD` with its own working
 * directory, so Codex starts it in the project with no plugin root, and the
 * install is found in Codex's plugin cache under this CLI's version, which the
 * plugin pins to its own. The install decides the update notice.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { codexHome, type MachineEnv } from '../update/installs.js';
import { resolvePluginWorkspace } from './pluginWorkspace.js';
import { detectPluginInstall, MANIFEST_URLS, PLUGIN_NAME, type PluginInstall, type UnmanagedReason } from './updateCheck.js';

export interface PluginServerSetup {
  workspace: string;
  install: PluginInstall | { kind: 'unmanaged'; reason: UnmanagedReason };
}

export interface PluginServerFlags {
  /** `--plugin-root`, from Claude Code. */
  root?: string;
  /** `--plugin-agent codex`. */
  agent?: string;
}

/** The Codex install of this version of the plugin, from one of our marketplaces, or null. */
function codexPluginRoot(machine: MachineEnv, version: string): string | null {
  for (const marketplace of Object.keys(MANIFEST_URLS)) {
    const root = path.join(codexHome(machine), 'plugins', 'cache', marketplace, PLUGIN_NAME, version);
    if (existsSync(root)) return root;
  }
  return null;
}

export function pluginServerSetup(machine: MachineEnv, cwd: string, flags: PluginServerFlags, version: string): PluginServerSetup {
  // Only an install from one of our marketplaces has anything to update; the
  // plugin directory and `--plugin-dir` update some other way.
  const unmanaged = { kind: 'unmanaged' as const, reason: 'checkout' as const };
  if (flags.agent === 'codex') {
    const root = codexPluginRoot(machine, version);
    return { workspace: cwd, install: (root && detectPluginInstall(machine.env, cwd, root, 'codex')) || unmanaged };
  }
  const pluginRoot = path.resolve(cwd, flags.root ?? cwd);
  return {
    workspace: resolvePluginWorkspace(machine.env, cwd, pluginRoot),
    install: detectPluginInstall(machine.env, cwd, pluginRoot, 'claude') ?? unmanaged,
  };
}
