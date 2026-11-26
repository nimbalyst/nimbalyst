/**
 * `runGit`: run one git command for main.
 *
 * Starting a child process forks main on the calling thread, which costs tens
 * of milliseconds per git call in a large main process. When the app has
 * configured a transport (the git runner utility process, see
 * `gitRunnerService.ts`), the call goes there and main pays only a message
 * send. Otherwise, or whenever the runner is not available, it runs `execFile`
 * here, exactly as the call sites did before.
 *
 * Either way it resolves `{ stdout, stderr }` (utf8) and rejects with the
 * Error `execFile` gives, plus its `stdout` and `stderr`, so callers keep
 * branching on `code`, `killed`, `signal` and `message`.
 *
 * Imports only `child_process` and the protocol, so the call sites stay
 * loadable without Electron (unit tests, the runner itself).
 */
import { execFile } from 'child_process';
import { gitExecOptions, type GitRunOptions, type GitRunResult } from './gitRunnerProtocol';

export type { GitRunOptions, GitRunResult } from './gitRunnerProtocol';

export interface GitRunTransport {
  /** The call's result, or null when the transport cannot take it now (run it here instead). */
  run(args: string[], options: GitRunOptions): Promise<GitRunResult> | null;
}

let transport: GitRunTransport | null = null;

/** Route `runGit` through `next`; null restores the in-process path. */
export function setGitRunTransport(next: GitRunTransport | null): void {
  transport = next;
}

export function runGit(args: string[], options: GitRunOptions = {}): Promise<GitRunResult> {
  return transport?.run(args, options) ?? runGitInProcess(args, options);
}

/** `execFile` in this process. Starts git before returning, as the call sites always have. */
export function runGitInProcess(args: string[], options: GitRunOptions = {}): Promise<GitRunResult> {
  return new Promise<GitRunResult>((resolve, reject) => {
    execFile('git', args, { windowsHide: true, encoding: 'utf8', ...gitExecOptions(options) }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout, stderr });
        return;
      }
      // What the promisified execFile adds; a test double may pass neither.
      if (stdout !== undefined) Object.assign(error, { stdout });
      if (stderr !== undefined) Object.assign(error, { stderr });
      reject(error);
    });
  });
}
