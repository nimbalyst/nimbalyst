/**
 * Detect Claude Code's enterprise MCP lockdown (NIM-2372).
 *
 * When IT deploys a `managed-mcp.json`, the `claude` binary takes exclusive
 * control of MCP and runs two guards before anything else:
 *
 *   if (strictMcpConfig)
 *     fail("You cannot use --strict-mcp-config when an enterprise MCP config is present")
 *   if (mcpConfig && !every(s => s.type === 'sdk' && s.name === 'claude-vscode'))
 *     fail("You cannot dynamically configure MCP servers when an enterprise MCP config is present")
 *
 * Nimbalyst dropped strict mode outright, which clears the first guard. The
 * second still rejects ANY server we pass — the Agent SDK serializes its
 * `mcpServers` option into `--mcp-config`, so both provider paths are affected,
 * and the only name the allowlist admits is the VS Code extension's own. We do
 * not impersonate it. So on these machines Nimbalyst launches with no MCP config
 * at all: the session runs on the enterprise's servers, and the UI says which
 * Nimbalyst tools are unavailable.
 *
 * Managed-settings roots are hardcoded in the binary with no env override:
 *
 *   macOS   /Library/Application Support/ClaudeCode
 *   Windows C:\Program Files\ClaudeCode
 *   other   /etc/claude-code
 *
 * The binary's own predicate is "the file parses to a non-null config", not mere
 * existence — so a stray unparseable file must NOT strip our tools. Cached for
 * the process lifetime: an admin push that lands mid-session needs a restart to
 * take effect on the CLI side anyway.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const MANAGED_SETTINGS_DIRS: Record<string, string> = {
  darwin: '/Library/Application Support/ClaudeCode',
  win32: 'C:\\Program Files\\ClaudeCode',
};

const DEFAULT_MANAGED_SETTINGS_DIR = '/etc/claude-code';
const MANAGED_MCP_FILE_NAME = 'managed-mcp.json';

/** Absolute path the binary reads its enterprise MCP config from. */
export function resolveEnterpriseManagedMcpConfigPath(
  platform: NodeJS.Platform = process.platform,
): string {
  const dir = MANAGED_SETTINGS_DIRS[platform] ?? DEFAULT_MANAGED_SETTINGS_DIR;
  // Windows paths must stay backslashed even when this runs from a posix host in
  // tests, so join per-platform rather than through the ambient path module.
  return platform === 'win32'
    ? path.win32.join(dir, MANAGED_MCP_FILE_NAME)
    : path.posix.join(dir, MANAGED_MCP_FILE_NAME);
}

export interface EnterpriseMcpConfigDeps {
  platform?: NodeJS.Platform;
  /** Read the managed file; return null when it does not exist / cannot be read. */
  readFile?: (filePath: string) => string | null;
}

const defaultReadFile = (filePath: string): string | null => {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
};

let cached: boolean | undefined;

/**
 * True when this machine has an enterprise MCP config, i.e. Nimbalyst must not
 * pass any MCP servers to Claude Code.
 */
export function hasEnterpriseManagedMcpConfig(deps: EnterpriseMcpConfigDeps = {}): boolean {
  if (cached !== undefined) return cached;

  const platform = deps.platform ?? process.platform;
  const read = deps.readFile ?? defaultReadFile;
  const contents = read(resolveEnterpriseManagedMcpConfigPath(platform));

  let present = false;
  if (contents !== null) {
    try {
      present = JSON.parse(contents) !== null;
    } catch {
      present = false;
    }
  }

  cached = present;
  return present;
}

/** Test-only: clear the cached probe. */
export function __resetEnterpriseManagedMcpConfigCache(): void {
  cached = undefined;
}
