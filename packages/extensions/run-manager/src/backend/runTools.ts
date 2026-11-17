/**
 * The backend module's tools: the six agent tools (`run_list`, `run_start`,
 * `run_stop`, `run_restart`, `run_logs`, `run_configure`) and the panel-only
 * tools the Runs panel calls through `host.callBackendTool`.
 *
 * The host advertises a tool as `<extension short name>_<name>`; the extension
 * id ends in `run`, so `list` becomes `run_list`.
 *
 * Permissions: `run_configure` defines a command that will later execute, so
 * it goes through the session's normal tool-permission check. Starting and
 * stopping an already-configured target does not (the user wrote the command,
 * and the agent could run it with Bash anyway); those tools are on the host's
 * auto-allow list (`INTERNAL_MCP_TOOLS` in the runtime's Claude Code tool
 * policy).
 */
import { RUN_CONFIG_PATH, RUN_PANEL_TOOLS, type RunTarget, type RunView, type RunsSnapshot } from '../shared/types';
import { DEFAULT_READY_TIMEOUT_MS, type RunManager, type StartOptions, type StartResult } from './runManager';

export interface RunToolDescriptor {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  panelOnly?: boolean;
}

const idProperty = { type: 'string', description: 'Run target id from run_list.' };
const waitProperties = {
  waitForReady: {
    type: 'boolean',
    description:
      'Wait until the target is ready (its port accepts connections, or its readyPattern appears in the output) before returning. Default true.',
  },
  timeoutSeconds: {
    type: 'number',
    description: `How long to wait for readiness. Default ${DEFAULT_READY_TIMEOUT_MS / 1000}, maximum 120.`,
  },
};

export const RUN_AGENT_TOOL_DESCRIPTORS: RunToolDescriptor[] = [
  {
    name: 'list',
    description:
      `List this project's run targets: the long-running processes (dev server, worker, watcher) defined in ${RUN_CONFIG_PATH}. ` +
      'Each has a status (stopped, starting, running, stopping, crashed, or external when its port is held by a process Nimbalyst did not start), ' +
      'and where known its pid, port, url, uptime and last exit code. Use this to answer "is the server running".',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'start',
    description:
      'Start a configured run target in a terminal tab the user can see. Returns its status. ' +
      'If it did not come up (crashed, or still starting when the wait ran out) the last log lines are included.',
    inputSchema: { type: 'object', properties: { id: idProperty, ...waitProperties }, required: ['id'] },
  },
  {
    name: 'stop',
    description:
      'Stop a run target: SIGTERM to its whole process group, SIGKILL after 5 seconds. Stopping a target that is not running is not an error. ' +
      'A target running outside Nimbalyst (status external) cannot be stopped with this tool.',
    inputSchema: { type: 'object', properties: { id: idProperty }, required: ['id'] },
  },
  {
    name: 'restart',
    description:
      'Stop a run target if it is running, then start it again with an empty log. Returns its status, with the last log lines if it did not come up.',
    inputSchema: { type: 'object', properties: { id: idProperty, ...waitProperties }, required: ['id'] },
  },
  {
    name: 'logs',
    description:
      "Read a run target's output as plain text (colors and progress-bar redraws removed). " +
      'Pass `tail` for the last N lines, or `since` with the `cursor` from a previous call to get only new output. ' +
      'The log starts empty each time the target is started. Do not repeat secrets that appear in the output.',
    inputSchema: {
      type: 'object',
      properties: {
        id: idProperty,
        tail: { type: 'number', description: 'Number of lines from the end. Default 100.' },
        since: { type: 'number', description: 'Cursor returned by a previous run_logs call.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'configure',
    description:
      `Add, edit or remove a run target in ${RUN_CONFIG_PATH}, a file committed with the project. ` +
      'A target is a command that will be executed when it is started, so this asks the user for permission. ' +
      'Never put secrets in `env`. For `edit`, pass only the fields to change.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'edit', 'remove'] },
        id: { type: 'string', description: 'Target id: lowercase letters, digits, "-" or "_".' },
        name: { type: 'string', description: 'Display name.' },
        command: { type: 'string', description: 'Command line, run through the login shell.' },
        cwd: { type: 'string', description: 'Working directory relative to the project root.' },
        port: { type: 'number', description: 'Port the process listens on; used to tell when it is ready.' },
        url: { type: 'string', description: 'Link shown for the target. Defaults to http://localhost:<port>.' },
        env: { type: 'object', description: 'Extra environment variables (strings). No secrets.' },
        readyPattern: {
          type: 'string',
          description: 'Regular expression that appears in the output once the target is ready. Used when there is no port.',
        },
      },
      required: ['action', 'id'],
    },
  },
];

export const RUN_PANEL_TOOL_DESCRIPTORS: RunToolDescriptor[] = Object.values(RUN_PANEL_TOOLS).map((name) => ({
  name,
  description: 'Used by the Runs panel.',
  inputSchema: { type: 'object', properties: {} },
  panelOnly: true,
}));

type Params = Record<string, unknown>;
export type RunToolHandler = (params: Params) => Promise<unknown>;

/** What an agent sees for one target. */
function describeRun(view: RunView, now: number): Record<string, unknown> {
  const { target } = view;
  return {
    id: target.id,
    name: target.name,
    command: target.command,
    ...(target.cwd ? { cwd: target.cwd } : {}),
    status: view.status,
    ...(view.pid !== undefined ? { pid: view.pid } : {}),
    ...(view.externalPid ? { externalPid: view.externalPid } : {}),
    ...(target.port !== undefined ? { port: target.port } : {}),
    ...(view.url ? { url: view.url } : {}),
    ...(view.startedAt !== undefined ? { uptimeSeconds: Math.max(0, Math.round((now - view.startedAt) / 1000)) } : {}),
    ...(view.exitCode !== undefined ? { lastExitCode: view.exitCode } : {}),
    ...(view.waitingFor ? { waitingFor: view.waitingFor } : {}),
    ...(view.error ? { error: view.error } : {}),
  };
}

function startOptions(params: Params): StartOptions {
  const seconds = typeof params.timeoutSeconds === 'number' && params.timeoutSeconds > 0 ? params.timeoutSeconds : undefined;
  return {
    waitForReady: params.waitForReady !== false,
    ...(seconds !== undefined ? { timeoutMs: seconds * 1000 } : {}),
  };
}

/** The result of a start, stop or restart: the transition, and enough for the transcript widget to link the log. */
function describeTransition(
  action: 'start' | 'stop' | 'restart',
  result: Pick<StartResult, 'run' | 'previousStatus'> & Partial<StartResult>,
  now: number
): Record<string, unknown> {
  return {
    action,
    previousStatus: result.previousStatus,
    ...describeRun(result.run, now),
    ...(result.run.terminalId ? { terminalId: result.run.terminalId } : {}),
    ...(result.timedOut ? { timedOut: true, note: 'Still starting when the wait ended. Check run_logs or run_list.' } : {}),
    ...(result.logs !== undefined ? { logs: result.logs } : {}),
  };
}

function requireId(params: Params): string {
  if (typeof params.id !== 'string' || params.id.trim() === '') throw new Error('id is required');
  return params.id.trim();
}

const TARGET_FIELDS = ['name', 'command', 'cwd', 'port', 'url', 'env', 'readyPattern'] as const;

/** Build the target a `configure` call asks for. `existing` is the target being edited, if any. */
export function targetFromConfigureParams(params: Params, existing?: RunTarget): RunTarget {
  const merged: Record<string, unknown> = existing ? { ...existing } : {};
  merged.id = requireId(params);
  for (const field of TARGET_FIELDS) {
    if (!(field in params) || params[field] === undefined) continue;
    // null or an empty string clears an optional field on edit.
    if (params[field] === null || params[field] === '') delete merged[field];
    else merged[field] = params[field];
  }
  return merged as unknown as RunTarget;
}

export function createRunToolHandlers(
  manager: RunManager,
  now: () => number = Date.now
): Record<string, RunToolHandler> {
  const snapshot = (): Promise<RunsSnapshot> => manager.snapshot();

  const agent: Record<string, RunToolHandler> = {
    list: async () => {
      const state = await snapshot();
      return {
        configPath: state.configPath,
        ...(state.configExists ? {} : { note: `${RUN_CONFIG_PATH} does not exist yet. Add a target with run_configure.` }),
        ...(state.configErrors.length > 0 ? { configErrors: state.configErrors } : {}),
        targets: state.runs.map((run) => describeRun(run, now())),
        ...(state.suggestions.length > 0
          ? { suggestions: state.suggestions.map(({ id, name, command }) => ({ id, name, command })) }
          : {}),
      };
    },
    start: async (params) => describeTransition('start', await manager.start(requireId(params), startOptions(params)), now()),
    stop: async (params) => describeTransition('stop', await manager.stop(requireId(params)), now()),
    restart: async (params) =>
      describeTransition('restart', await manager.restart(requireId(params), startOptions(params)), now()),
    logs: async (params) =>
      manager.logs(requireId(params), {
        ...(typeof params.since === 'number' ? { since: params.since } : {}),
        ...(typeof params.tail === 'number' ? { tail: params.tail } : {}),
      }),
    configure: async (params) => {
      const id = requireId(params);
      const existing = manager.views().find((view) => view.target.id === id)?.target;
      switch (params.action) {
        case 'add':
          if (existing) throw new Error(`A run target with id "${id}" already exists. Use action "edit".`);
          await manager.saveTarget(targetFromConfigureParams(params));
          break;
        case 'edit':
          if (!existing) throw new Error(`No run target with id "${id}". Use action "add".`);
          await manager.saveTarget(targetFromConfigureParams(params, existing));
          break;
        case 'remove':
          await manager.removeTarget(id);
          break;
        default:
          throw new Error('action must be "add", "edit" or "remove"');
      }
      const state = await snapshot();
      return {
        action: params.action,
        id,
        configPath: state.configPath,
        ...(state.configErrors.length > 0 ? { configErrors: state.configErrors } : {}),
        targets: state.runs.map((run) => describeRun(run, now())),
      };
    },
  };

  const panel: Record<string, RunToolHandler> = {
    [RUN_PANEL_TOOLS.state]: async () => snapshot(),
    [RUN_PANEL_TOOLS.start]: async (params) => {
      // The panel does not wait: it shows "starting" and follows by polling.
      await manager.start(requireId(params));
      return snapshot();
    },
    [RUN_PANEL_TOOLS.stop]: async (params) => {
      await manager.stop(requireId(params));
      return snapshot();
    },
    [RUN_PANEL_TOOLS.restart]: async (params) => {
      await manager.restart(requireId(params));
      return snapshot();
    },
    [RUN_PANEL_TOOLS.revealLogs]: async (params) => ({ revealed: await manager.revealLogs(requireId(params)) }),
    [RUN_PANEL_TOOLS.stopExternal]: async (params) => {
      await manager.stopExternal(requireId(params), Number(params.pid));
      return snapshot();
    },
    [RUN_PANEL_TOOLS.saveTarget]: async (params) => {
      const replaceId = typeof params.replaceId === 'string' && params.replaceId !== '' ? params.replaceId : undefined;
      await manager.saveTarget(params.target as RunTarget, replaceId);
      return snapshot();
    },
    [RUN_PANEL_TOOLS.removeTarget]: async (params) => {
      await manager.removeTarget(requireId(params));
      return snapshot();
    },
  };

  return { ...agent, ...panel };
}
