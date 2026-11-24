/**
 * Scoped MCP synchronization for the Antigravity CLI (`agy`) harness.
 *
 * Keeps `agy`'s MCP configuration in sync with Nimbalyst across two scopes:
 * - Global user MCPs -> `~/.gemini/config/mcp_config.json`
 * - Workspace MCPs + Nimbalyst built-in/extension MCPs (e.g. `nimbalyst-browser`,
 *   `nimbalyst-playwright`, `nimbalyst-core`, `nimbalyst-trackers`, `nimbalyst-host`)
 *   -> `<workspace>/.agents/mcp_config.json`
 *
 * Manual user-authored entries in either file are preserved via managed-key
 * tracking (`.nimbalyst_synced_mcps.json`), and workspace sync files are added
 * to `.git/info/exclude` (including git worktree `commondir`) so `git status`
 * stays clean.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface AgyMcpServerInput {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
  headers?: Record<string, string>;
}

export interface AgyScopedMcpServers {
  globalServers?: Record<string, AgyMcpServerInput>;
  workspaceServers?: Record<string, AgyMcpServerInput>;
}

export type AgyMcpConfigLoader = (
  workspacePath?: string,
  sessionId?: string,
) => Promise<AgyScopedMcpServers | Record<string, AgyMcpServerInput> | null | undefined>;

interface AgyManagedEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  serverUrl?: string;
  headers?: Record<string, string>;
}

const NIMBALYST_INTERNAL_MCP_URL_RE = /^https?:\/\/127\.0\.0\.1:\d+\/mcp(?:\/|\?|$)/;

/**
 * Add local-only patterns to `.git/info/exclude` (supporting normal repos and
 * git worktrees via `commondir`) so synced workspace MCP files never dirty `git status`.
 */
export async function ensureGitExcluded(
  workspacePath: string,
  patterns: readonly string[],
): Promise<void> {
  try {
    const dotGit = path.join(workspacePath, '.git');
    if (!fs.existsSync(dotGit)) return;

    let gitDir = dotGit;
    const stat = await fs.promises.stat(dotGit);
    if (stat.isFile()) {
      const content = (await fs.promises.readFile(dotGit, 'utf8')).trim();
      const match = /^gitdir:\s*(.+)$/im.exec(content);
      if (!match) return;
      gitDir = path.resolve(workspacePath, match[1].trim());
    }

    // For git worktrees, `info/exclude` lives under `commondir`.
    const commonDirFile = path.join(gitDir, 'commondir');
    if (fs.existsSync(commonDirFile)) {
      const relCommon = (await fs.promises.readFile(commonDirFile, 'utf8')).trim();
      if (relCommon) gitDir = path.resolve(gitDir, relCommon);
    }

    const infoDir = path.join(gitDir, 'info');
    const excludePath = path.join(infoDir, 'exclude');
    await fs.promises.mkdir(infoDir, { recursive: true });

    let existing = '';
    try {
      existing = await fs.promises.readFile(excludePath, 'utf8');
    } catch {
      /* file does not exist yet */
    }
    const existingLines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
    const missing = patterns.filter((p) => !existingLines.has(p));
    if (missing.length === 0) return;

    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    const addition = `${prefix}# Nimbalyst Antigravity CLI workspace MCP sync (local only)\n${missing.join('\n')}\n`;
    await fs.promises.writeFile(excludePath, existing + addition, 'utf8');
  } catch {
    /* best effort */
  }
}

/**
 * Write a managed `mcp_config.json` file in `configDir`, preserving any
 * manually-added user entries and atomically replacing only when changed.
 * Returns a stable fingerprint map (with volatile `sessionId` query params normalized).
 */
export async function writeManagedMcpFile(
  configDir: string,
  servers: Record<string, AgyMcpServerInput>,
  localNodePath: string,
  hasLocalNode: boolean,
): Promise<Record<string, AgyManagedEntry>> {
  const mcpConfigPath = path.join(configDir, 'mcp_config.json');
  const statePath = path.join(configDir, '.nimbalyst_synced_mcps.json');

  await fs.promises.mkdir(configDir, { recursive: true });

  let existing: Record<string, unknown> & { mcpServers: Record<string, unknown> } = { mcpServers: {} };
  try {
    const raw = (await fs.promises.readFile(mcpConfigPath, 'utf8')).trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = {
          ...(parsed as Record<string, unknown>),
          mcpServers:
            parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
              ? { ...(parsed.mcpServers as Record<string, unknown>) }
              : {},
        };
      }
    }
  } catch {
    /* start fresh if missing or malformed */
  }

  let prevManaged = new Set<string>();
  try {
    const prev = JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
    if (Array.isArray(prev)) {
      prevManaged = new Set(prev.filter((k): k is string => typeof k === 'string'));
    }
  } catch {
    /* no previous sync state */
  }

  const nextServers: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(existing.mcpServers)) {
    if (!prevManaged.has(name)) {
      nextServers[name] = cfg;
    }
  }

  const newManaged: string[] = [];
  const stableEntries: Record<string, AgyManagedEntry> = {};

  for (const [name, cfg] of Object.entries(servers ?? {})) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (cfg.command) {
      let cmd = cfg.command;
      const cleanEnv = cfg.env && typeof cfg.env === 'object' ? { ...cfg.env } : undefined;
      if (cleanEnv && cleanEnv.ELECTRON_RUN_AS_NODE === '1' && hasLocalNode) {
        cmd = localNodePath;
        delete cleanEnv.ELECTRON_RUN_AS_NODE;
      }
      const entry: AgyManagedEntry = {
        command: cmd,
        args: Array.isArray(cfg.args) ? cfg.args : [],
      };
      if (cleanEnv && Object.keys(cleanEnv).length > 0) entry.env = cleanEnv;
      nextServers[name] = entry;
      stableEntries[name] = entry;
      newManaged.push(name);
    } else if (cfg.url) {
      // Nimbalyst's internal 127.0.0.1:<port>/mcp/* endpoints speak native Streamable HTTP
      // even when declared with `type: "sse"`, so pass them as `serverUrl` + `headers`.
      const isNimbalystInternal = NIMBALYST_INTERNAL_MCP_URL_RE.test(cfg.url);
      if (isNimbalystInternal || cfg.type !== 'sse') {
        const entry: AgyManagedEntry = { serverUrl: cfg.url };
        if (cfg.headers && typeof cfg.headers === 'object' && Object.keys(cfg.headers).length > 0) {
          entry.headers = cfg.headers;
        }
        nextServers[name] = entry;
        stableEntries[name] = {
          ...entry,
          serverUrl: cfg.url.replace(/([?&])sessionId=[^&]*/g, '$1sessionId=_'),
        };
        newManaged.push(name);
      }
    }
  }

  const nextJson = `${JSON.stringify({ ...existing, mcpServers: nextServers }, null, 2)}\n`;
  let currentRaw = '';
  try {
    currentRaw = await fs.promises.readFile(mcpConfigPath, 'utf8');
  } catch {
    /* file does not exist yet */
  }
  if (currentRaw !== nextJson) {
    const tmp = `${mcpConfigPath}.tmp.${process.pid}`;
    await fs.promises.writeFile(tmp, nextJson, 'utf8');
    await fs.promises.rename(tmp, mcpConfigPath);
  }
  await fs.promises.writeFile(statePath, JSON.stringify(newManaged), 'utf8').catch(() => {});
  return stableEntries;
}

/**
 * Synchronize global and workspace/built-in MCP servers to `agy`'s config files
 * and return a stable JSON fingerprint for warm-session invalidation.
 */
export async function syncMcpServersToAgy(
  workspacePath: string | undefined,
  sessionId: string | undefined,
  configLoader?: AgyMcpConfigLoader | null,
  options?: { homeDir?: string; localNodePath?: string },
): Promise<string> {
  if (!configLoader) return '';
  try {
    const loaded = (await configLoader(workspacePath, sessionId)) ?? {};
    const isScoped =
      loaded &&
      typeof loaded === 'object' &&
      ('globalServers' in loaded || 'workspaceServers' in loaded);
    const scoped = loaded as AgyScopedMcpServers;
    const globalServers: Record<string, AgyMcpServerInput> = isScoped
      ? (scoped.globalServers ?? {})
      : (loaded as Record<string, AgyMcpServerInput>);
    const workspaceServers: Record<string, AgyMcpServerInput> = isScoped
      ? (scoped.workspaceServers ?? {})
      : {};

    const homeDir = options?.homeDir ?? os.homedir();
    const localNode = options?.localNodePath ?? path.join(homeDir, '.local', 'bin', 'node');
    const hasLocalNode = (() => {
      try {
        fs.accessSync(localNode, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    })();

    const globalConfigDir = path.join(homeDir, '.gemini', 'config');
    const hasWorkspace = Boolean(workspacePath && fs.existsSync(workspacePath));

    // When no workspace is open, merge workspace/built-in servers into global as fallback.
    const effectiveGlobal = hasWorkspace ? globalServers : { ...globalServers, ...workspaceServers };
    const globalStable = await writeManagedMcpFile(globalConfigDir, effectiveGlobal, localNode, hasLocalNode);

    let wsStable: Record<string, AgyManagedEntry> = {};
    if (hasWorkspace && workspacePath) {
      const wsAgentsDir = path.join(workspacePath, '.agents');
      wsStable = await writeManagedMcpFile(wsAgentsDir, workspaceServers, localNode, hasLocalNode);
      await ensureGitExcluded(workspacePath, [
        '.agents/mcp_config.json',
        '.agents/.nimbalyst_synced_mcps.json',
      ]);
    }

    return JSON.stringify({ global: globalStable, workspace: wsStable });
  } catch (err) {
    console.warn(
      '[AgyCliHarness] Failed to sync scoped MCP servers for agy:',
      err instanceof Error ? err.message : err,
    );
    return '';
  }
}
