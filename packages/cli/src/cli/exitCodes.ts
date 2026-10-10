/**
 * Stable process exit codes — part of the agent contract. Scripts and agents
 * branch on these, so they must not change meaning.
 */
export const ExitCode = {
  OK: 0,
  NOT_FOUND: 1,
  USAGE: 2,
  CONNECTION: 3,
  SCHEMA_INCOMPATIBLE: 4,
  WRITE_NOT_PERMITTED: 5,
  /**
   * Retired with the first `nim wiki` commands (fields written, page text failed); nothing
   * returns it now. Kept so the number is never given another meaning.
   */
  PARTIAL_WRITE: 6,
  /** A write based on a version that is no longer current (`nim wiki write --expected-version`). */
  CONFLICT: 7,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** A CLI error that carries a specific exit code. */
export class CliError extends Error {
  readonly code: ExitCodeValue;
  constructor(code: ExitCodeValue, message: string) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

export const usageError = (m: string) => new CliError(ExitCode.USAGE, m);
export const notFoundError = (m: string) => new CliError(ExitCode.NOT_FOUND, m);
export const connectionError = (m: string) => new CliError(ExitCode.CONNECTION, m);
export const schemaError = (m: string) => new CliError(ExitCode.SCHEMA_INCOMPATIBLE, m);
export const writeNotPermittedError = (m: string) => new CliError(ExitCode.WRITE_NOT_PERMITTED, m);
