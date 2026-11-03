/**
 * ClaudeCliSessionLauncher — main-process orchestrator that launches the genuine
 * interactive `claude` CLI on the user's subscription as a Nimbalyst session
 * (NIM-806, Phase 1).
 *
 * The single load-bearing step is **allocating the Nimbalyst session id BEFORE
 * launch** and injecting the same `sessionId`-bearing MCP URL the in-process
 * Agent-SDK path uses. The CLI then calls `mcp__nimbalyst__*` tools that hit
 * the identical handlers — so commit-proposal / AskUserQuestion widgets render in
 * the correct transcript with no new mechanism (see the plan doc, "How a rich
 * widget reaches the right transcript").
 *
 * Flow:
 *   1. Build the sessionId-bearing MCP server map via `McpConfigService`
 *      (already emits `&sessionId=` URLs + bearer headers).
 *   2. Write it to a temp `--mcp-config` file, shape `{ "mcpServers": { ... } }`.
 *   3. Resolve the `claude` executable + enhanced PATH; build the spawn config
 *      (`buildClaudeCliSpawnConfig` — strips ANTHROPIC_API_KEY, never `-p`).
 *   4. Spawn it in the ghostty-web terminal strip via
 *      `TerminalSessionManager.createClaudeCliTerminal`.
 *
 * Dependencies are injected so the orchestration is unit-testable without
 * node-pty / electron / a live MCP server.
 */

import { promises as fs, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';
import { buildClaudeCliSpawnConfig } from './claudeCliSpawnConfig';
import {
  buildPermissionHookSettingsJson,
  buildElectronNodeHookCommand,
} from './claudeCliPermissionHookConfig';
import { resolveClaudeCliJsonlPath, shouldResumeClaudeCliSession } from './claudeCliJsonlPath';
import { resolveClaudeConfigDir } from '@nimbalyst/runtime/ai/server/providers/claudeCode/claudeConfigDir';
import { hasEnterpriseManagedMcpConfig } from '@nimbalyst/runtime/ai/server/providers/claudeCode/enterpriseMcpConfig';
import type { TerminalSessionManager } from '../TerminalSessionManager';
import type { ClaudeTurnState, ParsedClaudePidFile } from './claudeCliPidState';

export interface ClaudeCliSessionLauncherDeps {
  /**
   * Build the merged, sessionId-bearing MCP server map for this session. In
   * production this is `McpConfigService.getMcpServersConfig` bound to the
   * main-process ports + bearer token.
   */
  getMcpServersConfig: (opts: {
    sessionId: string;
    workspacePath: string;
  }) => Promise<Record<string, unknown>>;
  /**
   * Resolve the `claude` executable path for this workspace. Falls back to the
   * bare `claude`. Takes the workspace so the user's "Custom Claude executable
   * path" setting resolves with its project-level override (#1296).
   */
  resolveClaudeExecutable: (workspacePath: string) => string;
  /** Login-shell-enhanced PATH so a GUI-launched Electron can find `claude`. */
  getEnhancedPath: () => string;
  /** Terminal manager that spawns the PTY-backed terminal strip. */
  terminalManager: Pick<TerminalSessionManager, 'createClaudeCliTerminal'>;
  /** Base env to derive the CLI env from. Defaults to `process.env`. */
  baseEnv?: Record<string, string | undefined>;
  /**
   * Start the proxy observation backend for this session (NIM-806, Phase 3).
   * Returns the `ANTHROPIC_BASE_URL` the CLI is pointed at, any extra env the
   * proxy needs the CLI spawned with (see `proxyPassthroughEnv.ts`), and a
   * `stop` to tear the proxy down on PTY exit. Returns null (or is omitted) when
   * observation is disabled. The CLI then talks to the real API directly
   * (terminal-only).
   */
  startObservation?: (opts: {
    sessionId: string;
    workspacePath: string;
  }) => Promise<{ baseUrl: string; env?: Record<string, string>; stop: () => void } | null>;
  /** Directory for temp MCP config files. Defaults to `os.tmpdir()/nimbalyst-claude-cli`. */
  tempDir?: string;
  /** fs overrides (tests). */
  mkdir?: (dir: string, opts: { recursive: true }) => Promise<unknown>;
  writeFile?: (file: string, data: string) => Promise<void>;
  /** Removes the per-launch `--settings` file on exit. Defaults to `fs.rm({ force: true })`. */
  removeFile?: (file: string) => Promise<void>;
  /** fs overrides for the stale settings-file sweep (tests). */
  readDir?: (dir: string) => Promise<string[]>;
  statFile?: (file: string) => Promise<{ mtimeMs: number }>;
  now?: () => number;
  /** User home dir for the CLI jsonl resume check (NIM-806 BUG 3). Defaults to os.homedir. */
  homedir?: () => string;
  /** Existence predicate for the CLI jsonl resume check. Defaults to fs.existsSync. */
  pathExists?: (p: string) => boolean;
  /**
   * Absolute path to the PreToolUse permission hook script (NIM-806 Phase 4).
   * When set (and the nimbalyst core server is configured), the launcher registers
   * the hook via `--settings` and injects the endpoint URL/token into the CLI env,
   * so built-in tool prompts route to a Nimbalyst widget. Omit → native gate.
   */
  permissionHookScriptPath?: string;
  /** Node-capable executable to run the hook under (Electron-as-Node). Defaults to process.execPath. */
  electronExecPath?: string;
  /**
   * Resolve the workspace's Nimbalyst permission mode (NIM-806 Phase 4). In
   * production this is `PermissionService.getPermissionMode`. When it returns
   * `allow-all` or `bypass-all`, the user has explicitly trusted the workspace, so
   * we skip the gate entirely (`--dangerously-skip-permissions`) and DROP the
   * PreToolUse hook — the hook would otherwise still prompt for Bash/Edit/Write.
   * `ask` / `null` (untrusted) keep the hook + native gate. Omit to keep the gate.
   */
  getPermissionMode?: (workspacePath: string) => 'ask' | 'allow-all' | 'bypass-all' | null;
  /**
   * Load the extension Claude-plugin directories for this workspace (NIM-845).
   * In production this is `getClaudePluginPaths(wp)` mapped to `.path` — the same
   * single source of truth the SDK path uses. Each returned dir is a bare plugin
   * directory passed to the CLI via `--plugin-dir`, which is what makes namespaced
   * slash commands resolve. Omit → no extension plugins (namespaced commands won't
   * resolve, as before NIM-845).
   */
  loadPluginDirs?: (workspacePath: string) => Promise<string[]>;
  /**
   * Report whether the resolved `claude` executable accepts `--plugin-dir`
   * (NIM-845). In production this is the cached `--version` probe
   * (`resolveClaudeCliSupportsPluginDir`). Old CLIs (< 2.1.142) reject the flag as
   * an unknown option and the launch would crash, so when this returns false we
   * skip loading/passing plugin dirs entirely. Omitted → assume supported (the
   * loader is the only gate); paired with `loadPluginDirs` in production.
   */
  cliSupportsPluginDir?: (executable: string) => boolean;
  /**
   * Report whether this machine has an enterprise `managed-mcp.json` (NIM-2372).
   * The binary then rejects any `--mcp-config` we pass — with `You cannot
   * dynamically configure MCP servers when an enterprise MCP config is present`
   * and exit 1 — so we launch with no snapshot at all and the session runs on the
   * enterprise's own servers. Injectable for tests; defaults to the real probe.
   */
  hasEnterpriseMcpLockdown?: () => boolean;
}

export interface LaunchClaudeCliSessionInput {
  /** Nimbalyst session id — must be allocated before this call. */
  sessionId: string;
  workspacePath: string;
  /** Working directory for the CLI. Defaults to `workspacePath`. */
  cwd?: string;
  /** Resolved CLI model value (`--model`), e.g. `opus`. Omit to let the CLI default. */
  model?: string;
  /** Resume an existing CLI session id (`--resume <id>`). */
  resumeSessionId?: string;
  /**
   * Resolved effort level for this session, forwarded to the CLI as
   * `CLAUDE_CODE_EFFORT_LEVEL` (parity with the Agent SDK path). Omit to leave
   * the CLI on its own default.
   */
  effortLevel?: string;
  cols?: number;
  rows?: number;
  /**
   * Directories to pre-authorize for the CLI's file tools via `--add-dir`
   * (NIM-806). Production passes the workspace's chat-attachments root so pasted
   * images (stored outside the workspace cwd) read without the native permission
   * prompt. Forwarded verbatim to `buildClaudeCliSpawnConfig`.
   */
  additionalDirectories?: string[];
  /**
   * Turn-state callback from the CLI PID file, forwarded to the terminal so the
   * watcher can drive `SessionStateManager`. Provided by the production caller.
   */
  onTurnState?: (state: ClaudeTurnState, parsed: ParsedClaudePidFile | null) => void;
  /**
   * Called when the PTY exits. Production uses this to settle the AI session out
   * of "running" even if the CLI dies before the PID watcher reports idle.
   */
  onExit?: (exitCode: number) => void;
}

export interface LaunchClaudeCliSessionResult {
  /**
   * Path to the temp MCP config file handed to the CLI via `--mcp-config`.
   * Absent under an enterprise MCP lockdown, where no snapshot is passed.
   */
  mcpConfigPath?: string;
}

/** Settings files older than this are leftovers from a crash and get swept. */
const STALE_SETTINGS_FILE_MS = 24 * 60 * 60 * 1000;

export class ClaudeCliSessionLauncher {
  private staleSweepStarted = false;

  constructor(private readonly deps: ClaudeCliSessionLauncherDeps) {}

  async launch(input: LaunchClaudeCliSessionInput): Promise<LaunchClaudeCliSessionResult> {
    const { sessionId, workspacePath } = input;
    if (!sessionId) {
      throw new Error('ClaudeCliSessionLauncher.launch: sessionId is required');
    }
    if (!workspacePath) {
      throw new Error('ClaudeCliSessionLauncher.launch: workspacePath is required');
    }
    if (!this.staleSweepStarted) {
      this.staleSweepStarted = true;
      void this.sweepStaleSettingsFiles();
    }
    const cwd = input.cwd || workspacePath;

    // BUG 3 (NIM-806): `--session-id <uuid>` is rejected once that id already
    // exists on disk (`Error: Session ID <uuid> is already in use.` → exit 1). On
    // a relaunch of the same Nimbalyst session (restart / re-mount / PID gone) the
    // CLI's prior jsonl is still there, so switch to `--resume <uuid>` — which also
    // restores prior context. Honor an explicit caller-provided resumeSessionId
    // first; otherwise resume iff the deterministic jsonl already exists.
    let resumeSessionId = input.resumeSessionId;
    if (!resumeSessionId) {
      // An injected homedir (tests) pins the config dir under it for isolation;
      // otherwise follow the CLI's own CLAUDE_CONFIG_DIR resolution.
      const configDir = this.deps.homedir
        ? path.join(this.deps.homedir(), '.claude')
        : resolveClaudeConfigDir();
      const pathExists = this.deps.pathExists ?? existsSync;
      const jsonlPath = resolveClaudeCliJsonlPath({ configDir, cwd, sessionId });
      if (shouldResumeClaudeCliSession({ jsonlExists: pathExists(jsonlPath) })) {
        resumeSessionId = sessionId;
      }
    }

    // 1 + 2. Build the sessionId-bearing MCP config and persist it to a temp file.
    // Under an enterprise MCP lockdown the binary rejects any dynamically-passed
    // server, so we skip the snapshot entirely and run degraded (NIM-2372) — the
    // renderer surfaces which Nimbalyst tools are unavailable.
    const mcpToolsUnavailable = (this.deps.hasEnterpriseMcpLockdown ?? hasEnterpriseManagedMcpConfig)();
    let mcpConfigPath: string | undefined;
    let allowedMcpServerNames: string[] = [];
    let mcpServers: Record<string, unknown> = {};
    if (mcpToolsUnavailable) {
      console.log(
        '[ClaudeCliSessionLauncher] enterprise managed-mcp.json detected; launching without Nimbalyst MCP servers',
      );
    } else {
      mcpServers = await this.deps.getMcpServersConfig({ sessionId, workspacePath });
      mcpConfigPath = await this.writeMcpConfig(sessionId, mcpServers);
      // The map's keys are the trusted Nimbalyst MCP server names — pre-allow them so
      // the genuine CLI doesn't double-prompt on top of our widgets (NIM-806 BUG 2).
      allowedMcpServerNames = Object.keys(mcpServers);
    }

    // NIM-806 Phase 4: a workspace the user has explicitly trusted "allow-all" /
    // "bypass-all" skips the gate entirely — spawn the genuine CLI with
    // `--dangerously-skip-permissions` and DROP the PreToolUse hook (it would
    // otherwise still prompt for Bash/Edit/Write on top of the skip). `ask` / null
    // (untrusted) keep the hook + native gate.
    const permissionMode = this.deps.getPermissionMode?.(workspacePath) ?? null;
    const dangerouslySkipPermissions =
      permissionMode === 'allow-all' || permissionMode === 'bypass-all';

    // NIM-806 Phase 4 (Direction A): register a PreToolUse permission hook (via
    // --settings) that routes built-in tool prompts to a Nimbalyst widget. The
    // hook POSTs to the loopback `/permission` endpoint — same host + bearer as the
    // unified internal MCP server, so we lift both straight out of the eager core
    // `nimbalyst` config (the monolithic `nimbalyst-mcp` is retired). Only when
    // the hook script path is provided AND the core server is configured — and
    // never when we're skipping the gate (the two are mutually exclusive).
    let settingsPath: string | undefined;
    const permissionHookEnv: Record<string, string> = {};
    const nimbalystMcp = mcpServers['nimbalyst'] as
      | { url?: string; headers?: Record<string, string> }
      | undefined;
    if (!dangerouslySkipPermissions && this.deps.permissionHookScriptPath && nimbalystMcp?.url) {
      try {
        const mcpUrl = new URL(nimbalystMcp.url);
        const permissionUrl = `${mcpUrl.protocol}//${mcpUrl.host}/permission`;
        const token = (nimbalystMcp.headers?.Authorization ?? '').replace(/^Bearer\s+/i, '');
        const command = buildElectronNodeHookCommand(
          this.deps.electronExecPath ?? process.execPath,
          this.deps.permissionHookScriptPath,
        );
        // Written to a file, never passed inline: on Windows `claude` is the npm
        // shim `claude.cmd`, which node-pty runs through cmd.exe, and the `|` in
        // the hook matcher split the command line there (#1905).
        settingsPath = await this.writeSettingsFile(sessionId, buildPermissionHookSettingsJson({ command }));
        permissionHookEnv.NIMBALYST_PERMISSION_URL = permissionUrl;
        if (token) permissionHookEnv.NIMBALYST_PERMISSION_TOKEN = token;
      } catch (err) {
        // Never block the CLI launch over the permission hook; fall back to native.
        console.warn('[ClaudeCliSessionLauncher] failed to build permission hook settings:', err);
        settingsPath = undefined;
      }
    }
    const removeSettingsFile = () => {
      if (!settingsPath) return;
      const removeFile = this.deps.removeFile ?? ((f: string) => fs.rm(f, { force: true }));
      removeFile(settingsPath).catch((err) => {
        console.warn('[ClaudeCliSessionLauncher] failed to remove settings file:', err);
      });
    };

    let observation: Awaited<
      ReturnType<NonNullable<ClaudeCliSessionLauncherDeps['startObservation']>>
    > = null;
    // Everything after the settings file is written runs under one cleanup, so a
    // throw anywhere before the PTY owns the file (executable resolution, plugin
    // discovery, spawn) doesn't leak it or the proxy.
    try {
      // 2.5. Start the proxy observation backend (Phase 3) BEFORE spawn, so we can
      // point the CLI's ANTHROPIC_BASE_URL at it. Tear down on PTY exit.
      if (this.deps.startObservation) {
        try {
          observation = await this.deps.startObservation({ sessionId, workspacePath });
        } catch (err) {
          // Observation is best-effort: never block the genuine CLI from launching.
          console.warn('[ClaudeCliSessionLauncher] startObservation failed; launching without proxy:', err);
          observation = null;
        }
      }
      const extraEnv: Record<string, string> | undefined =
        observation || Object.keys(permissionHookEnv).length > 0
          ? {
              ...(observation
                ? { ANTHROPIC_BASE_URL: observation.baseUrl, ...observation.env }
                : {}),
              ...permissionHookEnv,
            }
          : undefined;

      // 2.6. Resolve the `claude` executable once (reused for the plugin-support
      // probe and the spawn config below).
      const claudeExecutable = this.deps.resolveClaudeExecutable(workspacePath);

      // NIM-845: load extension Claude-plugin directories so namespaced slash
      // commands (`/feedback:bug-report`, …) resolve in this CLI session. Gate on
      // `--plugin-dir` support FIRST — on an old CLI (< 2.1.142) the flag is an
      // unknown option and would crash the launch, so we skip loading entirely and
      // log once (silent to the user; commands stay unresolved as before the fix).
      let pluginDirs: string[] | undefined;
      if (this.deps.loadPluginDirs) {
        const supportsPluginDir = this.deps.cliSupportsPluginDir?.(claudeExecutable) ?? true;
        if (supportsPluginDir) {
          try {
            pluginDirs = (await this.deps.loadPluginDirs(workspacePath)).filter(
              (dir) => typeof dir === 'string' && dir.trim().length > 0,
            );
          } catch (err) {
            // Best-effort: never block the launch over plugin discovery.
            console.warn('[ClaudeCliSessionLauncher] failed to load plugin dirs; launching without extension plugins:', err);
            pluginDirs = undefined;
          }
        } else {
          console.log(
            `[ClaudeCliSessionLauncher] resolved claude (${claudeExecutable}) lacks --plugin-dir support; ` +
              'skipping extension plugins (namespaced slash commands will not resolve)',
          );
        }
      }

      // 3. Build the spawn config (resolves exec, sets enhanced PATH, strips API key).
      const spawnConfig = buildClaudeCliSpawnConfig({
        claudeExecutable,
        cwd,
        mcpConfigPath,
        model: input.model,
        sessionId,
        resumeSessionId,
        baseEnv: this.deps.baseEnv ?? process.env,
        enhancedPath: this.deps.getEnhancedPath(),
        extraEnv,
        effortLevel: input.effortLevel,
        allowedMcpServerNames,
        settingsPath,
        dangerouslySkipPermissions,
        additionalDirectories: input.additionalDirectories,
        pluginDirs,
        mcpToolsUnavailable,
      });

      // 4. Spawn the genuine interactive CLI in the terminal strip. Tear the proxy
      // down and delete the settings file when the PTY exits (composed with the
      // PID-watcher cleanup downstream).
      await this.deps.terminalManager.createClaudeCliTerminal(sessionId, {
        cwd,
        spawnConfig,
        workspacePath,
        cols: input.cols,
        rows: input.rows,
        onTurnState: input.onTurnState,
        onExit: observation || settingsPath || input.onExit
          ? (exitCode) => {
              observation?.stop();
              removeSettingsFile();
              input.onExit?.(exitCode);
            }
          : undefined,
      });
    } catch (err) {
      observation?.stop();
      removeSettingsFile();
      throw err;
    }

    return { mcpConfigPath };
  }

  private async writeMcpConfig(
    sessionId: string,
    mcpServers: Record<string, unknown>
  ): Promise<string> {
    const dir = this.deps.tempDir ?? path.join(os.tmpdir(), 'nimbalyst-claude-cli');
    const mkdir = this.deps.mkdir ?? ((d: string, o: { recursive: true }) => fs.mkdir(d, o));
    const writeFile = this.deps.writeFile ?? ((f: string, d: string) => fs.writeFile(f, d, 'utf8'));

    await mkdir(dir, { recursive: true });
    // Sanitize the session id for use as a filename (ULIDs are safe; be defensive).
    const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
    const filePath = path.join(dir, `${safeId}.mcp.json`);
    await writeFile(filePath, JSON.stringify({ mcpServers }, null, 2));
    return filePath;
  }

  /**
   * Remove `*.settings.json` files older than a day from the temp folder: those
   * a crash left behind (a clean exit deletes its own). Best-effort. The
   * `*.mcp.json` files there are overwritten per session, so they are left alone.
   */
  async sweepStaleSettingsFiles(): Promise<void> {
    const dir = this.deps.tempDir ?? path.join(os.tmpdir(), 'nimbalyst-claude-cli');
    const readDir = this.deps.readDir ?? ((d: string) => fs.readdir(d));
    const statFile = this.deps.statFile ?? ((f: string) => fs.stat(f));
    const removeFile = this.deps.removeFile ?? ((f: string) => fs.rm(f, { force: true }));
    const cutoff = (this.deps.now ?? Date.now)() - STALE_SETTINGS_FILE_MS;
    let names: string[];
    try {
      names = await readDir(dir);
    } catch {
      return; // Folder not created yet.
    }
    for (const name of names) {
      if (!name.endsWith('.settings.json')) continue;
      const file = path.join(dir, name);
      try {
        if ((await statFile(file)).mtimeMs < cutoff) await removeFile(file);
      } catch (err) {
        console.warn('[ClaudeCliSessionLauncher] failed to sweep stale settings file:', err);
      }
    }
  }

  /**
   * Write the `--settings` JSON to its own file per launch. The random suffix
   * keeps a relaunch of the same session from sharing a file that the previous
   * PTY's exit cleanup is about to delete.
   */
  private async writeSettingsFile(sessionId: string, settingsJson: string): Promise<string> {
    const dir = this.deps.tempDir ?? path.join(os.tmpdir(), 'nimbalyst-claude-cli');
    const mkdir = this.deps.mkdir ?? ((d: string, o: { recursive: true }) => fs.mkdir(d, o));
    const writeFile = this.deps.writeFile ?? ((f: string, d: string) => fs.writeFile(f, d, 'utf8'));

    await mkdir(dir, { recursive: true });
    const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
    const filePath = path.join(dir, `${safeId}.${randomUUID().slice(0, 8)}.settings.json`);
    await writeFile(filePath, settingsJson);
    return filePath;
  }
}
