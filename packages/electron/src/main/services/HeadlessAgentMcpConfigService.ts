/**
 * Writes Nimbalyst's enabled MCP servers into the config file Cursor Agent
 * reads.
 *
 * `cursor-agent` accepts no inline server list, so it must be told through
 * `.cursor/mcp.json` (workspace) or `~/.cursor/mcp.json` — a file the user also
 * owns. Every ACP provider, Grok Build included, hands `mcpServers` to
 * `session/new` instead and leaves no trace on disk.
 *
 * Grok deliberately has no target here. It used to get `~/.grok/mcp.json`, back
 * when it ran as `grok -p`. That file is written mode 0644 and holds the
 * *resolved* server map — real `DISCORD_TOKEN` and `POSTHOG_PERSONAL_API_KEY`
 * values, not placeholders — so once ACP delivery made it redundant it was pure
 * credential exposure. Do not add a target back without an inline-delivery
 * reason; there isn't one for any ACP agent.
 *
 * **Nothing is ever written inside a workspace.** The map handed to `sync` is
 * the user's resolved servers: `processServerConfigForRuntime` keeps `env`
 * verbatim and literalizes `Authorization` into `--header key:value` args, and
 * a `command`/`args` pair can carry a credential in any shape at all — an
 * `--api-key` flag, a token in a URL path, a camelCase query parameter. There
 * is no filter that can look at an arbitrary argv and prove no secret is in it,
 * so the only defensible guarantee is about the *destination*: this service
 * writes to `~/.cursor/mcp.json` and nowhere else. That file is outside every
 * repository and holds the same class of material as the `~/.claude.json` these
 * servers were copied out of, so no `git add -A` can ship it.
 *
 * The earlier workspace target is actively cleaned up: every sync strips
 * `nimbalyst:` keys out of `<workspace>/.cursor/mcp.json` if a previous build
 * left them there. See `cleanWorkspaceMcpConfig`.
 *
 * Ownership of the home file is the remaining design constraint:
 *
 * - Only the `nimbalyst:`-prefixed keys are ever written or removed. A server
 *   the user added by hand, or that another tool added, is left exactly as it
 *   was — including on a full sync that removes stale Nimbalyst entries.
 * - The file is only rewritten when the resulting content differs, so enabling
 *   a session does not churn a file the user may have open.
 * - A malformed existing file is left alone rather than replaced. Overwriting
 *   it would destroy configuration we cannot read but the user can.
 * - An empty server map writes nothing and creates no directory. It does still
 *   clear stale `nimbalyst:` entries out of a file that already exists.
 *
 * One consequence of a single global file is accepted deliberately: the
 * `nimbalyst:` set is replaced wholesale on each sync, so two Cursor turns
 * running concurrently in different workspaces both see whichever workspace
 * synced last. Per-workspace delivery is not available — `cursor-agent` reads
 * MCP servers only from `<projectRoot>/.cursor/mcp.json` and
 * `~/.cursor/mcp.json`, with no config-path flag and no env override
 * (`CURSOR_CONFIG_DIR` redirects its other config, not this), and the project
 * path is the one place we may not write.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomBytes } from 'crypto';

/** Prefix that marks a server entry as Nimbalyst's to manage. */
export const NIMBALYST_MCP_KEY_PREFIX = 'nimbalyst:';

export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  [key: string]: unknown;
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

/**
 * Merge Nimbalyst's servers into an existing config object.
 *
 * Pure so the merge rules are testable without touching a real config file --
 * this is the function that must never drop a user's own entry.
 */
export function mergeNimbalystMcpServers(
  existing: McpConfigFile | null,
  servers: Record<string, McpServerEntry>,
): McpConfigFile {
  const base: McpConfigFile = existing ? { ...existing } : {};
  const previous = base.mcpServers ?? {};

  const next: Record<string, McpServerEntry> = {};
  for (const [name, entry] of Object.entries(previous)) {
    // Drop only our own stale entries; everything else survives untouched.
    if (!name.startsWith(NIMBALYST_MCP_KEY_PREFIX)) {
      next[name] = entry;
    }
  }
  for (const [name, entry] of Object.entries(servers)) {
    next[`${NIMBALYST_MCP_KEY_PREFIX}${name}`] = entry;
  }

  base.mcpServers = next;
  return base;
}

/**
 * Agents that can only be told about MCP servers through a file on disk.
 *
 * Narrow by construction: adding a member is how a credential-bearing file gets
 * written for an agent that did not need one.
 */
export type HeadlessAgentMcpTarget = 'cursor-agent';

/**
 * Resolve the config file to write for a target.
 *
 * Always the home file, whatever the workspace. This function taking no
 * workspace is the mechanism: a path inside a repository cannot be returned, so
 * no later change to the caller can put resolved credentials back into one.
 */
export function resolveHeadlessAgentMcpConfigPath(
  _target: HeadlessAgentMcpTarget,
  homedir = os.homedir(),
): string {
  return path.join(homedir, '.cursor', 'mcp.json');
}

/**
 * The workspace file earlier builds wrote, which now exists only to be cleaned
 * up. Never a write target.
 */
export function resolveLegacyWorkspaceMcpConfigPath(workspacePath: string): string {
  return path.join(workspacePath, '.cursor', 'mcp.json');
}

/**
 * Strip Nimbalyst's entries out of a workspace file a previous build wrote.
 *
 * Builds before the home-file move copied the user's resolved servers into
 * `<workspace>/.cursor/mcp.json`, where nothing gitignores them. Those files are
 * still sitting in people's repositories, so every sync clears one if it finds
 * it. The rules mirror the ones for the home file: a file we did not write into
 * is not ours to touch, and a file we cannot parse is not ours to rewrite.
 *
 * Returns the path cleaned, or `null` when there was nothing to do.
 */
export async function cleanWorkspaceMcpConfig(workspacePath: string): Promise<string | null> {
  const configPath = resolveLegacyWorkspaceMcpConfigPath(workspacePath);

  let parsed: McpConfigFile;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as McpConfigFile;
  } catch {
    // Missing, unreadable, or malformed. A file we cannot read is the user's
    // configuration; deleting keys out of it blind would destroy settings.
    return null;
  }

  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== 'object') return null;
  const ours = Object.keys(servers).filter((name) => name.startsWith(NIMBALYST_MCP_KEY_PREFIX));
  if (ours.length === 0) {
    // Someone else's `.cursor/mcp.json`. Leave it exactly as it is.
    return null;
  }

  const remaining: Record<string, McpServerEntry> = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (!name.startsWith(NIMBALYST_MCP_KEY_PREFIX)) remaining[name] = entry;
  }

  const otherTopLevelKeys = Object.keys(parsed).filter((key) => key !== 'mcpServers');
  if (Object.keys(remaining).length === 0 && otherTopLevelKeys.length === 0) {
    // The whole file was ours. Remove it, and the directory too if we were the
    // only reason it existed -- `rmdir` fails on a non-empty one, which is
    // exactly the check we want.
    await fs.rm(configPath, { force: true });
    await fs.rmdir(path.dirname(configPath)).catch(() => {});
    return configPath;
  }

  parsed.mcpServers = remaining;
  await fs.writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return configPath;
}

/**
 * Serializes every sync in this process.
 *
 * `~/.cursor/mcp.json` is one file shared by every workspace, and a sync is a
 * read-merge-write. Two turns starting at once in different workspaces
 * interleaved those steps and left the shorter document's trailing bytes after
 * the longer one, which is not last-write-wins — it is a config file the user's
 * Cursor can no longer parse.
 */
let syncQueue: Promise<unknown> = Promise.resolve();

function enqueueSync<T>(task: () => Promise<T>): Promise<T> {
  // Run after whatever is queued, whether it succeeded or not; a failed sync
  // must not wedge every later one.
  const result = syncQueue.then(task, task);
  syncQueue = result.catch(() => undefined);
  return result;
}

/**
 * Replace a file's contents in one step, so a concurrent reader sees either the
 * whole old document or the whole new one and never a half-written mix.
 *
 * `preserveMode` carries the target's existing permissions across the rename:
 * without it every write would reset the user's file to the temp file's 0600.
 */
async function writeFileAtomic(
  filePath: string,
  contents: string,
  preserveMode: number | null,
): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, contents, { encoding: 'utf8', mode: 0o600 });
    if (preserveMode !== null) {
      await fs.chmod(tempPath, preserveMode);
    }
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Structural comparison, so an unchanged config is never rewritten. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** Whether a parsed config holds any entry this service manages. */
function hasNimbalystEntries(config: McpConfigFile | null): boolean {
  return Object.keys(config?.mcpServers ?? {}).some((name) =>
    name.startsWith(NIMBALYST_MCP_KEY_PREFIX),
  );
}

export class HeadlessAgentMcpConfigService {
  /**
   * Write the enabled servers for `target` to the user's home config, and clear
   * anything an earlier build left inside the workspace.
   *
   * `path` is the home file written, or `null` when nothing needed to change,
   * the existing file could not be parsed, or there was nothing to create it
   * for. `cleanedWorkspacePath` is the in-repository file this sync cleaned up,
   * so the caller can say so once rather than silently.
   */
  async sync(
    target: HeadlessAgentMcpTarget,
    servers: Record<string, McpServerEntry>,
    workspacePath?: string,
  ): Promise<{ path: string | null; cleanedWorkspacePath: string | null }> {
    // The whole read-merge-write runs under the queue, not just the write: two
    // syncs that interleave their reads would each merge against a stale file.
    return enqueueSync(() => this.syncExclusive(target, servers, workspacePath));
  }

  private async syncExclusive(
    target: HeadlessAgentMcpTarget,
    servers: Record<string, McpServerEntry>,
    workspacePath?: string,
  ): Promise<{ path: string | null; cleanedWorkspacePath: string | null }> {
    const configPath = resolveHeadlessAgentMcpConfigPath(target);
    const cleanedWorkspacePath = workspacePath ? await cleanWorkspaceMcpConfig(workspacePath) : null;

    let existing: McpConfigFile | null = null;
    let existingRaw: string | null = null;
    let existingMode: number | null = null;
    try {
      existingRaw = await fs.readFile(configPath, 'utf8');
      existing = JSON.parse(existingRaw) as McpConfigFile;
      existingMode = (await fs.stat(configPath)).mode & 0o777;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        // A file we cannot parse is a file we must not overwrite: it is the
        // user's configuration, and replacing it would destroy settings we
        // simply failed to read.
        return { path: null, cleanedWorkspacePath };
      }
    }

    // With nothing to say, the only reason to touch the file is to take our own
    // stale entries back out of it. Otherwise: no file created, and no
    // reformatting of a config that has nothing to do with us.
    if (Object.keys(servers).length === 0 && !hasNimbalystEntries(existing)) {
      return { path: null, cleanedWorkspacePath };
    }

    const merged = mergeNimbalystMcpServers(existing, servers);
    if (existing !== null && deepEqual(existing, merged)) {
      // Structural, not textual: comparing serialized forms rewrote every
      // compact file the user had just to reindent it.
      return { path: null, cleanedWorkspacePath };
    }

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    // An existing `~/.cursor/mcp.json` keeps whatever mode the user (or the
    // Cursor app) gave it, 0644 included: it is their file and their other
    // tools read it, so tightening it out from under them is not ours to do.
    // Only a file we create ourselves starts at 0600.
    await writeFileAtomic(configPath, `${JSON.stringify(merged, null, 2)}\n`, existingMode);
    return { path: configPath, cleanedWorkspacePath };
  }
}

export const headlessAgentMcpConfigService = new HeadlessAgentMcpConfigService();
