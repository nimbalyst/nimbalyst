/**
 * Backend-module terminal API: `ctx.services.terminals`.
 *
 * A command terminal runs one command in a PTY that Nimbalyst owns and shows
 * as a tab in the bottom terminal panel. The tab is the command's log: the
 * user can read it, scroll it and type into it like any terminal. The module
 * gets a handle to follow the output, wait for exit, signal the process group
 * and reveal the tab.
 *
 * Use it for long-running project processes (a dev server, a simulator log, a
 * watcher) where the user should be able to see and reach the process. The
 * terminals belong to the calling extension: another extension cannot read or
 * signal them, and the host stops them when the module stops (extension
 * disabled, project closed, app quit).
 *
 * Requires the `terminals` permission in the module's `permissions`.
 */

/** Signals a module may send to a command terminal's process group. */
export type BackendTerminalSignal = 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP';

/** Status dot on the terminal's tab. `null` removes it. */
export type BackendTerminalStatusTone = 'success' | 'warning' | 'error';

export interface CreateCommandTerminalOptions {
  /**
   * This extension's own stable name for the terminal (for example a run
   * target id). Starting a command under a key that already has a tab replaces
   * that tab, so each start begins with an empty log. Rejects if the previous
   * command under the key is still running.
   */
  key: string;
  /** Tab title. */
  title: string;
  /**
   * Command line, run as `$SHELL -lc '<command>'` (`cmd.exe /d /s /c` on
   * Windows) so the user's PATH, version managers and shell profile apply.
   */
  command: string;
  /** Working directory, relative to the project root. Must stay inside it. Default: the root. */
  cwd?: string;
  /** Extra environment variables for the command. */
  env?: Record<string, string>;
  /** Keep the tab with the other pinned tabs, ahead of ordinary terminals. */
  pinned?: boolean;
  /**
   * One of this extension's own panels (bare id from the manifest) that the
   * tab belongs to. The terminal panel shows a tab that returns to it.
   */
  panelId?: string;
}

export interface BackendTerminalOutputChunk {
  /** Raw PTY output, escape sequences included. */
  data: string;
  /** Absolute offset just past this chunk; usable as `read({ since })`. */
  cursor: number;
}

export interface BackendTerminalExit {
  exitCode: number;
  /** Number of the signal that ended the shell, when a signal did (15 for SIGTERM). */
  signal?: number;
}

export interface BackendTerminalReadOptions {
  /** Last N lines (default 100). Ignored when `since` is given. */
  tail?: number;
  /** Only output after this cursor, from an earlier read or output chunk. */
  since?: number;
  /** Cap on returned characters, keeping the end. Default 20000. */
  maxChars?: number;
}

export interface BackendTerminalReadResult {
  /** Output with ANSI sequences stripped and `\r` progress bars collapsed. */
  text: string;
  /** Pass as `since` to read only newer output. */
  cursor: number;
  /** `text` was cut to `maxChars`. */
  truncated: boolean;
  /** `since` pointed at output that the scrollback cap had already dropped. */
  gap: boolean;
}

export interface BackendTerminalStopResult {
  /** The process group did not exit on SIGTERM within the grace period and was sent SIGKILL. */
  escalated: boolean;
  /** No process is left in the group. `false` means something survived SIGKILL. */
  groupGone: boolean;
}

export interface BackendCommandTerminal {
  /** Terminal id; also the id of its tab. */
  readonly id: string;
  /** Pid of the shell that runs the command. It leads the command's process group. */
  readonly pid: number;
  /** Raw output as it arrives. Returns an unsubscribe function. */
  onOutput(handler: (chunk: BackendTerminalOutputChunk) => void): () => void;
  /**
   * Called once when the command's shell exits. A handler added after the exit
   * is called immediately. Returns an unsubscribe function.
   */
  onExit(handler: (exit: BackendTerminalExit) => void): () => void;
  /** Send a signal to the whole process group. Default `SIGTERM`. No-op once the group is gone. */
  kill(signal?: BackendTerminalSignal): Promise<void>;
  /**
   * Stop the command: SIGTERM to the process group, SIGKILL after `graceMs`
   * (default 5000), then confirm the group is gone.
   */
  stop(options?: { graceMs?: number }): Promise<BackendTerminalStopResult>;
  /** Read the log as plain text. Still works after the command has exited. */
  read(options?: BackendTerminalReadOptions): Promise<BackendTerminalReadResult>;
  /** Open the terminal panel on this tab in the windows showing this project. */
  reveal(): Promise<void>;
  /** Set or clear the status dot on the tab. */
  setStatus(tone: BackendTerminalStatusTone | null): Promise<void>;
  /** Stop the command if it is running and remove the tab and its saved output. */
  dispose(): Promise<void>;
}

export interface BackendTerminalsService {
  /** Start a command in a new terminal tab. Resolves once the process is spawned. */
  createCommandTerminal(options: CreateCommandTerminalOptions): Promise<BackendCommandTerminal>;
}
