import { inspect } from 'node:util';

/** Cap per-argument output so one fat object can't flood main.log. */
const MAX_INSPECTED_ARG_LENGTH = 4000;

/**
 * Render console arguments for the file log.
 *
 * Joining the raw args was good enough for plain strings but turned every
 * object into `[object Object]` -- which is how the `render-process-gone`
 * details in issue #943 (and ~20 other diagnostics per session) were lost from
 * main.log while remaining visible on stderr. Objects go through util.inspect
 * instead, kept on a single line because main.log is line-oriented.
 *
 * Lives apart from logger.ts so it can be unit-tested without pulling in
 * electron and electron-store at module load.
 */
export function formatLogArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;

      let rendered: string;
      try {
        rendered = inspect(arg, { depth: 4, breakLength: Infinity, compact: true, colors: false });
      } catch {
        // Getters that throw, revoked proxies, etc. -- never let logging crash.
        rendered = String(arg);
      }

      return rendered.length > MAX_INSPECTED_ARG_LENGTH
        ? `${rendered.slice(0, MAX_INSPECTED_ARG_LENGTH)}... (truncated, ${rendered.length} chars)`
        : rendered;
    })
    .join(' ');
}
