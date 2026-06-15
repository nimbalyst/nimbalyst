/**
 * Production wiring for `ClaudeCliSessionLauncher` (NIM-806, Phase 1).
 *
 * `ClaudeCliSessionLauncher` is dependency-injected so it unit-tests without
 * electron/node-pty/a live MCP server. This module is the main-process glue: it
 * holds the same static-injected deps the CLI providers use (MCP ports, bearer
 * token, config loaders, shell env, enhanced PATH — wired from `index.ts`),
 * builds the real `McpConfigService`, and exposes `ensureClaudeCliSession` which
 * the IPC layer calls when a `claude-code-cli` session view mounts.
 *
 * It also bridges the CLI PID-state watcher to `SessionStateManager` so a
 * terminal-driven session still drives the running / idle / waiting indicator
 * (the SDK-only `MessageStreamingHandler` never sees CLI turns).
 */

import os from 'os';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { McpConfigService } from '@nimbalyst/runtime/ai/server';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { getTerminalSessionManager } from '../TerminalSessionManager';
import { getEnhancedPath, getShellEnvironment } from '../CLIManager';
import { ClaudeCliSessionLauncher } from './ClaudeCliSessionLauncher';
import { HooklessAgentFileWatcher } from './HooklessAgentFileWatcher';
import { resolveClaudeExecutablePath } from './claudeExecutableResolver';
import { resolveClaudeCliSupportsPluginDir } from './claudeCliPluginSupport';
import { getAgentWorkflowService } from '../AgentWorkflowService';
import { workspacePathToDir } from '../AttachmentService';
import { resolveClaudePermissionHookScriptPath } from './claudeCliPermissionHookPath';
import { getPermissionService } from '../PermissionService';
import { startClaudeCliProxyObservation, fireClaudeCliTurnCompletion } from './claudeCliObservationSingleton';
import { flushNextClaudeCliQueuedPromptForSession } from './claudeCliQueueFlushSingleton';
import { maybeAutoNameClaudeCliSessionProduction } from './claudeCliSessionAutoNameSingleton';
import type { ClaudeTurnState } from './claudeCliPidState';

interface ClaudeCliLauncherConfig {
  mcpServerPort: number | null;
  sessionNamingServerPort: number | null;
  extensionDevServerPort: number | null;
  sessionContextServerPort: number | null;
  metaAgentServerPort: number | null;
  settingsServerPort: number | null;
  settingsAgentToolsDisabledLoader: (() => boolean) | null;
  mcpAuthToken: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mcpConfigLoader: ((workspacePath?: string) => Promise<Record<string, any>>) | null;
}

const config: ClaudeCliLauncherConfig = {
  mcpServerPort: null,
  sessionNamingServerPort: null,
  extensionDevServerPort: null,
  sessionContextServerPort: null,
  metaAgentServerPort: null,
  settingsServerPort: null,
  settingsAgentToolsDisabledLoader: null,
  mcpAuthToken: null,
  mcpConfigLoader: null,
};

/** Static setters, wired from `index.ts` alongside the CLI providers. */
export const ClaudeCliLauncherConfig = {
  setMcpServerPort: (port: number | null) => { config.mcpServerPort = port; },
  setSessionNamingServerPort: (port: number | null) => { config.sessionNamingServerPort = port; },
  setExtensionDevServerPort: (port: number | null) => { config.extensionDevServerPort = port; },
  setSessionContextServerPort: (port: number | null) => { config.sessionContextServerPort = port; },
  setMetaAgentServerPort: (port: number | null) => { config.metaAgentServerPort = port; },
  setSettingsServerPort: (port: number | null) => { config.settingsServerPort = port; },
  setSettingsAgentToolsDisabledLoader: (loader: (() => boolean) | null) => { config.settingsAgentToolsDisabledLoader = loader; },
  setMcpAuthToken: (token: string | null) => { config.mcpAuthToken = token; },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setMcpConfigLoader: (loader: ((workspacePath?: string) => Promise<Record<string, any>>) | null) => { config.mcpConfigLoader = loader; },
};

/**
 * Resolve the `claude` executable. We must run the same `claude` the user runs
 * in their terminal (the official ~/.claude/local install / login-shell PATH),
 * never a stale homebrew/npm global. See `claudeExecutableResolver.ts`.
 * node-pty spawns with the enhanced PATH so a bare `claude` resolves at exec
 * time; we still prefer an absolute hit so a thin GUI PATH still finds it.
 */
function resolveClaudeExecutable(): string {
  return resolveClaudeExecutablePath({
    homedir: os.homedir(),
    pathExists: existsSync,
    enhancedPath: getEnhancedPath(),
  });
}

/**
 * Resolve (and create) the workspace's chat-attachments root and return it as the
 * `--add-dir` allow-list for the CLI. Mirrors `AttachmentService`'s storage
 * layout (`<userData>/chat-attachments/<workspaceDir>`) via the shared
 * `workspacePathToDir` so the path matches where pasted images actually land.
 * Returns `undefined` on any failure so a directory-prep error never blocks the
 * CLI launch.
 */
/**
 * Whether a `claude-code-cli` session launched right now would be able to load
 * extension Claude-plugins — i.e. the resolved `claude` accepts `--plugin-dir`
 * (≥ 2.1.142). The slash-command picker uses this to hide namespaced plugin
 * commands when the CLI can't run them (NIM-845). Resolves the same executable
 * the launcher would spawn, so the picker matches actual launch behavior.
 */
export function claudeCliSessionSupportsPlugins(): boolean {
  return resolveClaudeCliSupportsPluginDir(resolveClaudeExecutable());
}

function prepareAttachmentsAllowDir(workspacePath: string): string[] | undefined {
  try {
    const attachmentsRoot = join(
      app.getPath('userData'),
      'chat-attachments',
      workspacePathToDir(workspacePath),
    );
    // Synchronous mkdir: one-time, fast op during session spawn. Keeps the launch
    // path free of an extra async tick (the SDK/CLI launch-coalescing logic relies
    // on a tight pre-launch microtask shape).
    mkdirSync(attachmentsRoot, { recursive: true });
    return [attachmentsRoot];
  } catch (err) {
    console.warn('[ClaudeCliLauncher] failed to prepare chat-attachments --add-dir:', err);
    return undefined;
  }
}

function buildMcpConfigService(): McpConfigService {
  return new McpConfigService({
    mcpServerPort: config.mcpServerPort,
    sessionNamingServerPort: config.sessionNamingServerPort,
    extensionDevServerPort: config.extensionDevServerPort,
    superLoopProgressServerPort: null,
    sessionContextServerPort: config.sessionContextServerPort,
    metaAgentServerPort: config.metaAgentServerPort,
    settingsServerPort: config.settingsServerPort,
    settingsAgentToolsDisabledLoader: config.settingsAgentToolsDisabledLoader,
    mcpAuthToken: config.mcpAuthToken,
    mcpConfigLoader: config.mcpConfigLoader,
    claudeSettingsEnvLoader: null,
    shellEnvironmentLoader: () => getShellEnvironment(),
  });
}

function buildLauncher(): ClaudeCliSessionLauncher {
  const mcpConfigService = buildMcpConfigService();
  return new ClaudeCliSessionLauncher({
    getMcpServersConfig: ({ sessionId, workspacePath }) =>
      mcpConfigService.getMcpServersConfig({ sessionId, workspacePath }),
    resolveClaudeExecutable,
    getEnhancedPath: () => getEnhancedPath(),
    terminalManager: getTerminalSessionManager(),
    // Phase 3 (B3): start the loopback SSE-tee proxy so the rich transcript
    // renders above the terminal. Best-effort — the launcher tolerates failure.
    startObservation: startClaudeCliProxyObservation,
    // Phase 4 (Direction A): register the PreToolUse permission hook so built-in
    // tool prompts route to a Nimbalyst widget. undefined → keep the native gate.
    permissionHookScriptPath: resolveClaudePermissionHookScriptPath(),
    // Phase 4: a workspace the user trusted "allow-all"/"bypass-all" skips the gate
    // via `--dangerously-skip-permissions` (and drops the hook). Same trust signal
    // the SDK path reads. `getPermissionMode` resolves worktree paths to the parent
    // project so trust is shared.
    getPermissionMode: (workspacePath: string) =>
      getPermissionService().getPermissionMode(workspacePath),
    // NIM-845: load extension Claude-plugins so namespaced slash commands
    // (`/feedback:bug-report`, …) resolve in CLI sessions. Mirror the SDK path's
    // loader EXACTLY (`getClaudeProviderPluginPaths`, the same aggregator wired at
    // index.ts → setExtensionPluginsLoader): native + legacy + CLI-installed AND
    // GENERATED extension-workflow plugins. The raw `getClaudePluginPaths` omits
    // the generated ones, so a supported-CLI user would see generated namespaced
    // commands in the picker that the launched CLI couldn't resolve. We map to the
    // bare directory paths the CLI's `--plugin-dir` expects. Gated by the
    // `--version` probe below so old CLIs that reject the flag silently skip it.
    loadPluginDirs: async (workspacePath: string) =>
      (await getAgentWorkflowService(workspacePath).getClaudeProviderPluginPaths()).map(
        (plugin) => plugin.path,
      ),
    cliSupportsPluginDir: (executable: string) => resolveClaudeCliSupportsPluginDir(executable),
  });
}

export interface EnsureClaudeCliSessionInput {
  sessionId: string;
  workspacePath: string;
  cwd?: string;
  /** Resolved CLI model value (`--model`). Omit to let the CLI default. */
  model?: string;
  resumeSessionId?: string;
  cols?: number;
  rows?: number;
}

export interface EnsureClaudeCliSessionResult {
  success: boolean;
  alreadyActive?: boolean;
  error?: string;
}

const launchInFlight = new Map<string, Promise<EnsureClaudeCliSessionResult>>();

/**
 * Dedicated hookless file watcher for the CLI path. The SDK path runs its own
 * instance from AIService during the streaming loop the CLI bypasses; sessions
 * are provider-exclusive, so a separate instance keyed by sessionId is safe and
 * avoids any coupling/refactor of the SDK watcher. Started on a turn's `running`
 * transition and stopped (delayed, to drain events) on `idle`, mirroring the SDK
 * lifecycle. This attributes Bash/shell + external on-disk edits that the
 * proxy's tool_use attribution can't see.
 */
const cliFileWatcher = new HooklessAgentFileWatcher();

/**
 * Idempotently ensure the genuine `claude` CLI is running for this session. If
 * the terminal is already live, returns `alreadyActive`. Otherwise marks the
 * session running, launches the CLI, and wires the PID-state watcher to
 * `SessionStateManager`.
 */
export async function ensureClaudeCliSession(
  input: EnsureClaudeCliSessionInput
): Promise<EnsureClaudeCliSessionResult> {
  const manager = getTerminalSessionManager();
  if (manager.isTerminalActive(input.sessionId)) {
    return { success: true, alreadyActive: true };
  }

  const existingLaunch = launchInFlight.get(input.sessionId);
  if (existingLaunch) {
    return existingLaunch;
  }

  const stateManager = getSessionStateManager();

  const launchPromise = (async (): Promise<EnsureClaudeCliSessionResult> => {
    try {
      // Track the session so the PID watcher's updateActivity has in-memory state.
      await stateManager.startSession({
        sessionId: input.sessionId,
        workspacePath: input.workspacePath,
        initialStatus: 'running',
      });

      const launcher = buildLauncher();
      // Pre-authorize the workspace's chat-attachments root so pasted images
      // (stored OUTSIDE the workspace cwd) read without the native CLI permission
      // prompt. Best-effort: `--add-dir` rejects a non-existent path, so ensure the
      // root exists; on any failure, launch without it (the prompt reappears but
      // the CLI still works).
      const additionalDirectories = prepareAttachmentsAllowDir(input.workspacePath);

      await launcher.launch({
        sessionId: input.sessionId,
        workspacePath: input.workspacePath,
        cwd: input.cwd,
        model: input.model,
        resumeSessionId: input.resumeSessionId,
        cols: input.cols,
        rows: input.rows,
        additionalDirectories,
        onTurnState: (state: ClaudeTurnState) => {
          // idle is the terminal turn boundary; running/waiting are mid-turn.
          // Root the file watcher at the spawn cwd (the worktree for worktree
          // sessions), where edits actually land.
          const watchRoot = input.cwd ?? input.workspacePath;
          if (state === 'idle') {
            void stateManager.updateActivity({ sessionId: input.sessionId, status: 'idle', isStreaming: false });
            // Delay the watcher stop so post-turn fs events still attribute.
            cliFileWatcher.scheduleStop(input.sessionId, 500);
            // PID idle is the authoritative whole-turn boundary (covers in-process
            // Task sub-agents) — fire completion notification/sound/analytics here,
            // not per proxy message, so sub-agent end_turns don't spuriously notify.
            fireClaudeCliTurnCompletion(input.sessionId, input.workspacePath);
            // NIM-822: deterministic host-driven naming — if the agent's
            // opportunistic update_session_meta call didn't name the session by
            // its first completed turn, derive a title from the first prompt.
            void maybeAutoNameClaudeCliSessionProduction(input.sessionId);
            // Flush the next queued prompt (if any) into the now-idle CLI. The
            // write restarts the CLI, so the following idle drains the next one.
            void flushNextClaudeCliQueuedPromptForSession(input.sessionId, input.workspacePath);
          } else if (state === 'running') {
            void stateManager.updateActivity({ sessionId: input.sessionId, status: 'running', isStreaming: true });
            // Idempotent; cancels any pending scheduled-stop from a prior turn.
            void cliFileWatcher
              .ensureForSession(input.sessionId, watchRoot)
              .catch((err) => console.warn('[ClaudeCliLauncher] file watcher start failed:', err));
          } else if (state === 'waiting_for_input') {
            void stateManager.updateActivity({ sessionId: input.sessionId, status: 'waiting_for_input', isStreaming: false });
          }
        },
        onExit: (exitCode) => {
          console.log(`[ClaudeCliLauncher] Claude CLI exited for ${input.sessionId} with code ${exitCode}; ending AI session state`);
          void cliFileWatcher.stopForSession(input.sessionId).catch(() => {});
          void stateManager.endSession(input.sessionId).catch((err) => {
            console.warn('[ClaudeCliLauncher] Failed to end session after CLI exit:', err);
          });
        },
      });

      return { success: true };
    } catch (error) {
      console.error('[ClaudeCliLauncher] Failed to ensure session:', error);
      // Roll the session back out of "running" so the UI doesn't spin forever.
      void stateManager.endSession(input.sessionId).catch(() => {});
      return { success: false, error: String(error) };
    } finally {
      launchInFlight.delete(input.sessionId);
    }
  })();

  launchInFlight.set(input.sessionId, launchPromise);
  return launchPromise;
}
