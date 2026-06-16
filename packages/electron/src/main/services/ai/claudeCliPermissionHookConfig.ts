/**
 * Pure builders for the genuine `claude-code-cli` PreToolUse permission hook
 * (NIM-806 Phase 4, Direction A). Kept free of Electron so the `--settings`
 * payload and hook command string are unit-testable.
 *
 * Why a hook (not `--permission-prompt-tool`): the latter is silently ignored by
 * the interactive CLI (verified live — native TUI prompt still showed). A
 * `PreToolUse` hook returning `permissionDecision` IS honored interactively, so
 * we register one via `--settings` that calls back into Nimbalyst's loopback
 * `/permission` endpoint (which renders the ToolPermission widget).
 */

/**
 * Built-in tools we intercept for a GUI permission prompt. Read-only tools
 * (Read/Glob/Grep) are intentionally omitted — the CLI auto-allows them, so
 * routing them through the hook would add needless round-trips. Bash/Edit/Write
 * and friends are the ones that otherwise show the native prompt.
 */
export const PERMISSION_HOOK_MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit|WebFetch';

/** Default hook timeout (seconds). Generous — a human may take a while to answer. */
export const PERMISSION_HOOK_TIMEOUT_SEC = 600;

export interface PermissionHookSettings {
  hooks: {
    PreToolUse: Array<{
      matcher: string;
      hooks: Array<{ type: 'command'; command: string; timeout: number }>;
    }>;
  };
}

/**
 * Build the `--settings` object registering the PreToolUse permission hook.
 * `command` is the full shell command the CLI runs (e.g. an Electron-as-Node
 * invocation of the hook script).
 */
export function buildPermissionHookSettings(args: {
  command: string;
  matcher?: string;
  timeoutSec?: number;
}): PermissionHookSettings {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: args.matcher ?? PERMISSION_HOOK_MATCHER,
          hooks: [
            {
              type: 'command',
              command: args.command,
              timeout: args.timeoutSec ?? PERMISSION_HOOK_TIMEOUT_SEC,
            },
          ],
        },
      ],
    },
  };
}

/** JSON string for `--settings` (the CLI accepts a JSON string or a file path). */
export function buildPermissionHookSettingsJson(args: {
  command: string;
  matcher?: string;
  timeoutSec?: number;
}): string {
  return JSON.stringify(buildPermissionHookSettings(args));
}

/**
 * Build the hook command that runs the `.cjs` script under Electron-as-Node so
 * we never depend on a `node` binary being on the CLI's PATH. The
 * `ELECTRON_RUN_AS_NODE=1` prefix is scoped to this command only (not the whole
 * CLI env). Both paths are quoted for spaces (e.g. "Application Support").
 */
export function buildElectronNodeHookCommand(execPath: string, scriptPath: string): string {
  return `ELECTRON_RUN_AS_NODE=1 "${execPath}" "${scriptPath}"`;
}
