/**
 * Types shared by the Run Manager backend module and its panel.
 *
 * A run target is a named command from the project's committed
 * `.nimbalyst/run.json`. The backend starts it in a terminal tab Nimbalyst
 * owns; that tab is the target's log.
 */

/** Path of the config file, relative to the project root. */
export const RUN_CONFIG_PATH = '.nimbalyst/run.json';

/** Bare id of the panel in the manifest. */
export const RUNS_PANEL_ID = 'runs';

/** Last segment of the extension id: the namespace of every backend tool. */
export const RUN_TOOL_NAMESPACE = 'run';

export interface RunTarget {
  /** Stable id: lowercase letters, digits, `-` and `_`. */
  id: string;
  name: string;
  command: string;
  /** Working directory, relative to the project root. */
  cwd?: string;
  /** Port the process listens on. Used for readiness and for spotting a copy started elsewhere. */
  port?: number;
  /** Link shown for the target. Defaults to `http://localhost:<port>` when a port is set. */
  url?: string;
  /** Extra environment variables. For flags, never secrets: the file is committed. */
  env?: Record<string, string>;
  /** Regular expression matched against the output to decide the target is ready, when it has no port. */
  readyPattern?: string;
}

/**
 * - `stopped`: not running, last exit was clean or it never ran.
 * - `starting`: spawned, not ready yet.
 * - `running`: ready.
 * - `stopping`: asked to stop, process group not gone yet.
 * - `crashed`: exited before it was ready, or exited non-zero.
 * - `external`: not started here, but its port is bound by another process.
 */
export type RunStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed' | 'external';

export interface RunView {
  target: RunTarget;
  status: RunStatus;
  /** Pid of the shell running the command, while this app owns the run. */
  pid?: number;
  /** For `external`: the process holding the port. */
  externalPid?: number;
  /** Epoch ms of the current start; set while starting or running. */
  startedAt?: number;
  /** Exit code of the last run that ended. */
  exitCode?: number;
  /** What a starting target is waiting for, in words. */
  waitingFor?: string;
  /** Whether this session has a log tab for the target. */
  hasLogs: boolean;
  /** Id of the target's log tab, when it has one. */
  terminalId?: string;
  /** Link for the target, resolved from `url` or `port`. */
  url?: string;
  /** Last failure to report (a stop that did not take, a start that was refused). */
  error?: string;
}

export interface RunsSnapshot {
  configPath: string;
  configExists: boolean;
  /** Problems in the config file. Valid targets still load. */
  configErrors: string[];
  runs: RunView[];
  /** Targets offered from `package.json` scripts. Nothing is written until one is accepted. */
  suggestions: RunTarget[];
}

/** Gutter badge for the panel button. `value: null` means no badge. */
export interface RunsBadge {
  value: 0 | null;
  tone: 'default' | 'warning' | 'success' | 'error';
}

// ─── Panel-only tools ──────────────────────────────────────────────────────

/** Bare tool names; the panel calls them as `${RUN_TOOL_NAMESPACE}.${name}`. */
export const RUN_PANEL_TOOLS = {
  state: 'panel_state',
  start: 'panel_start',
  stop: 'panel_stop',
  restart: 'panel_restart',
  revealLogs: 'panel_reveal_logs',
  stopExternal: 'panel_stop_external',
  saveTarget: 'panel_save_target',
  removeTarget: 'panel_remove_target',
} as const;

export type RunPanelToolKey = keyof typeof RUN_PANEL_TOOLS;

export function runPanelToolName(key: RunPanelToolKey): string {
  return `${RUN_TOOL_NAMESPACE}.${RUN_PANEL_TOOLS[key]}`;
}

export interface RunPanelToolMap {
  state: [Record<string, never>, RunsSnapshot];
  start: [{ id: string }, RunsSnapshot];
  stop: [{ id: string }, RunsSnapshot];
  restart: [{ id: string }, RunsSnapshot];
  revealLogs: [{ id: string }, { revealed: boolean }];
  stopExternal: [{ id: string; pid: number }, RunsSnapshot];
  saveTarget: [{ target: RunTarget; replaceId?: string }, RunsSnapshot];
  removeTarget: [{ id: string }, RunsSnapshot];
}

/** Aggregate badge: red if anything crashed, amber while anything is in motion, green if something is up. */
export function runsBadge(runs: ReadonlyArray<Pick<RunView, 'status'>>): RunsBadge {
  const has = (status: RunStatus) => runs.some((run) => run.status === status);
  if (has('crashed')) return { value: 0, tone: 'error' };
  if (has('starting') || has('stopping')) return { value: 0, tone: 'warning' };
  if (has('running')) return { value: 0, tone: 'success' };
  return { value: null, tone: 'default' };
}

/** The link for a target: its `url`, else `http://localhost:<port>`. */
export function targetUrl(target: Pick<RunTarget, 'url' | 'port'>): string | undefined {
  if (target.url) return target.url;
  return target.port ? `http://localhost:${target.port}` : undefined;
}
