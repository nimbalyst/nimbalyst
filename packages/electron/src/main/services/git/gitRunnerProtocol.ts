/**
 * Messages between main and the git runner utility process, and the error
 * (de)serialization that lets a runner failure reach the caller with the same
 * shape `execFile` gives in process.
 *
 * Shared by both sides, so it imports nothing: the runner's import closure must
 * stay free of `electron`, the logger and the store (see the build guard in
 * `electron.vite.config.ts`).
 */

/** Bumped when either side's messages change incompatibly. */
export const GIT_RUNNER_PROTOCOL_VERSION = 1;

/** The `execFile` options a git call may set. Each one is optional, as in `execFile`. */
export interface GitRunOptions {
  cwd?: string;
  /** Milliseconds; 0 or absent means no timeout. */
  timeout?: number;
  /** Bytes; absent or undefined means Node's default (1 MiB). */
  maxBuffer?: number;
  /** Absent means main's `process.env` at call time. */
  env?: NodeJS.ProcessEnv;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
}

/** main -> runner. `id` is unique across restarts of the runner process. */
export interface GitRunRequest {
  type: 'run';
  id: number;
  args: string[];
  options: GitRunOptions;
}

/** runner -> main */
export type GitRunReply =
  | { type: 'result'; id: number; stdout: string; stderr: string }
  | { type: 'failure'; id: number; error: SerializedGitError };

/**
 * An Error flattened for `postMessage`. Structured clone keeps only `message`
 * and `stack` of an Error, which would lose `code`, `killed` and `signal`.
 */
export interface SerializedGitError {
  name: string;
  message: string;
  stack?: string;
  /** Own enumerable properties (`code`, `killed`, `signal`, `cmd`, `errno`, ...). */
  props: Record<string, unknown>;
  stdout?: string;
  stderr?: string;
  /** For an EBADF: the runner's open fd count when it failed (null when unknown). */
  openFdCount?: number | null;
}

/** On a rebuilt runner error that carried `openFdCount`. Not an own string key, so the shape stays `execFile`'s. */
const RUNNER_OPEN_FD_COUNT = Symbol.for('nimbalyst.gitRunner.openFdCount');

/**
 * Give a git error the `stdout` and `stderr` the promisified `execFile` adds.
 * They are not enumerable, so logging the error does not print git's output
 * (up to 10,000 characters of it).
 */
export function attachGitOutput<T extends object>(error: T, stdout: string | undefined, stderr: string | undefined): T {
  if (stdout !== undefined) Object.defineProperty(error, 'stdout', { value: stdout, writable: true, configurable: true, enumerable: false });
  if (stderr !== undefined) Object.defineProperty(error, 'stderr', { value: stderr, writable: true, configurable: true, enumerable: false });
  return error;
}

/**
 * For an error from a spawn in the runner, the runner's open fd count at the
 * failure (null when it could not count); undefined for any other error.
 */
export function gitRunnerOpenFdCount(error: unknown): number | null | undefined {
  if (typeof error !== 'object' || error === null || !(RUNNER_OPEN_FD_COUNT in error)) return undefined;
  return (error as { [RUNNER_OPEN_FD_COUNT]: number | null })[RUNNER_OPEN_FD_COUNT];
}

/**
 * The options to hand `execFile`, with absent ones left out rather than set to
 * undefined: an explicit `maxBuffer: undefined` disables the limit.
 */
export function gitExecOptions(options: GitRunOptions): GitRunOptions {
  const result: GitRunOptions = {};
  if (options.cwd !== undefined) result.cwd = options.cwd;
  if (options.timeout !== undefined) result.timeout = options.timeout;
  if (options.maxBuffer !== undefined) result.maxBuffer = options.maxBuffer;
  if (options.env !== undefined) result.env = options.env;
  return result;
}

function cloneable(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return true;
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function serializeGitError(error: unknown, stdout: string | undefined, stderr: string | undefined): SerializedGitError {
  if (!(error instanceof Error)) {
    return { name: 'Error', message: String(error), props: {}, stdout, stderr };
  }
  const props: Record<string, unknown> = {};
  for (const key of Object.keys(error)) {
    if (key === 'stdout' || key === 'stderr') continue;
    const value = (error as unknown as Record<string, unknown>)[key];
    if (cloneable(value)) props[key] = value;
  }
  return { name: error.name, message: error.message, stack: error.stack, props, stdout, stderr };
}

const nodeErrorPrototypes = new Map<ErrorConstructor, object>();

/**
 * Node's own errors (`code` `ERR_*`) print as `RangeError [ERR_X]: message`,
 * from a `toString` on a prototype between the error and its class's.
 */
function nodeErrorPrototype(Ctor: ErrorConstructor): object {
  let prototype = nodeErrorPrototypes.get(Ctor);
  if (!prototype) {
    prototype = Object.create(Ctor.prototype, {
      constructor: { value: Ctor, writable: true, configurable: true },
      toString: {
        value(this: Error & { code?: unknown }) { return `${this.name} [${String(this.code)}]: ${this.message}`; },
        writable: true,
        configurable: true,
      },
    }) as object;
    nodeErrorPrototypes.set(Ctor, prototype);
  }
  return prototype;
}

/** Rebuild the Error a runner failure stands for, with the properties in `execFile`'s order. */
export function deserializeGitError(serialized: SerializedGitError): Error {
  const Ctor = serialized.name === 'RangeError' ? RangeError : serialized.name === 'TypeError' ? TypeError : Error;
  const error = new Ctor(serialized.message);
  const { code } = serialized.props;
  if (typeof code === 'string' && code.startsWith('ERR_')) Object.setPrototypeOf(error, nodeErrorPrototype(Ctor));
  if (serialized.stack !== undefined) error.stack = serialized.stack;
  Object.assign(error, serialized.props);
  attachGitOutput(error, serialized.stdout, serialized.stderr);
  if (serialized.openFdCount !== undefined) {
    Object.defineProperty(error, RUNNER_OPEN_FD_COUNT, { value: serialized.openFdCount, configurable: true });
  }
  return error;
}

/** The error `execFile` gives when it kills git at `timeout`, for a call that never got an answer. */
export function gitTimeoutError(args: readonly string[]): Error {
  const cmd = ['git', ...args].join(' ');
  const error = Object.assign(new Error(`Command failed: ${cmd}\n`), { code: null, killed: true, signal: 'SIGTERM', cmd });
  return attachGitOutput(error, '', '');
}
