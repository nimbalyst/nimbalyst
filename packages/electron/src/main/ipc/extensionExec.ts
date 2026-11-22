import { exec } from 'child_process';

export interface ExtensionExecOptions {
  command: string;
  cwd: string;
  timeout: number;
  maxBuffer: number;
  env?: Record<string, string>;
}

export interface ExtensionExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a shell command on behalf of an extension (`extension:exec`).
 *
 * Extensions use this for git among other things (Project Graph indexes with
 * `git rev-parse` / `rev-list` / `log`), so it must not open a console window
 * on Windows (#1839). Explicit promise rather than `promisify(exec)`: the
 * builtin's `promisify.custom` bypasses test spies.
 */
export function runExtensionCommand(options: ExtensionExecOptions): Promise<ExtensionExecResult> {
  const { command, cwd, timeout, maxBuffer, env } = options;
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd,
        timeout,
        maxBuffer,
        env: env ? { ...process.env, ...env } : process.env,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ success: true, stdout, stderr, exitCode: 0 });
          return;
        }
        const code = (error as { code?: unknown }).code;
        resolve({
          success: false,
          stdout: stdout || '',
          stderr: stderr || error.message || '',
          exitCode: typeof code === 'number' && code !== 0 ? code : 1,
        });
      },
    );
  });
}
