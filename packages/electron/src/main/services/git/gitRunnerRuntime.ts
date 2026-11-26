/**
 * The git runner's work loop, inside the utility process: run each requested
 * git command with `execFile` and post the result or the serialized error back.
 *
 * Calls run concurrently, as they did in main. Nothing is logged here: the
 * callers handle expected git failures (non-zero exits) themselves, and they
 * repeat on every call in a non-git or unborn workspace.
 *
 * Kept apart from the entry file so tests can run it behind a fake port.
 */
import { execFile } from 'child_process';
import type { ChildConnection } from '../../utilityProcess/childConnection';
import {
  GIT_RUNNER_PROTOCOL_VERSION,
  gitExecOptions,
  serializeGitError,
  type GitRunReply,
  type GitRunRequest,
} from './gitRunnerProtocol';

export function startGitRunner(connection: ChildConnection): void {
  const reply = (message: GitRunReply) => connection.postMessage(message);
  connection.onMessage((raw) => {
    const message = raw as Partial<GitRunRequest> | null;
    if (message?.type !== 'run' || typeof message.id !== 'number' || !Array.isArray(message.args)) return;
    const { id, args } = message;
    try {
      execFile('git', args, { windowsHide: true, encoding: 'utf8', ...gitExecOptions(message.options ?? {}) }, (error, stdout, stderr) => {
        if (error) reply({ type: 'failure', id, error: serializeGitError(error, stdout, stderr) });
        else reply({ type: 'result', id, stdout, stderr });
      });
    } catch (error) {
      // execFile throws synchronously on invalid arguments, as it would in main.
      reply({ type: 'failure', id, error: serializeGitError(error, undefined, undefined) });
    }
  });
  connection.ready(GIT_RUNNER_PROTOCOL_VERSION);
}
