/**
 * Temporary no-op hook for the old diff-trace call sites.
 *
 * The logging path remains callable so we can keep the existing instrumentation
 * points in place without any settings, store, or IPC plumbing.
 */
export function diffTrace(_label: string, _data?: unknown): void {}
