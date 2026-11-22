/**
 * The run status state machine. Pure: a status and an event give the next
 * status, or an error when the event makes no sense in that state.
 *
 *   stopped  --start-->  starting
 *   starting --ready-->  running
 *   starting --exit-->   crashed     (exited before it was ready, any code)
 *   running  --clean exit--> stopped   (code 0, or ended by SIGTERM / SIGINT / SIGHUP)
 *   running  --other exit--> crashed
 *   starting/running --stop--> stopping
 *   stopping --exit or gone--> stopped   (a stop the user asked for is never a crash)
 *   crashed  --start-->  starting
 *
 * `external` is not a state this machine enters: it is how a stopped or
 * crashed target is shown while another process holds its port.
 */
import type { RunStatus } from '../shared/types';

export type RunEvent =
  | { type: 'start' }
  | { type: 'ready' }
  | { type: 'exit'; exitCode: number; signal?: number }
  | { type: 'stop' }
  | { type: 'gone' };

// SIGHUP, SIGINT, SIGTERM: someone asked the process to end (closing its tab,
// Ctrl-C in its terminal, `kill`). Any other signal is the process dying.
const POLITE_SIGNALS = new Set([1, 2, 15]);

/** An exit that is not a crash: code 0 with no signal, or ended by a polite signal. */
export function isCleanExit(exitCode: number, signal?: number): boolean {
  if (signal) return POLITE_SIGNALS.has(signal);
  // A shell reports 128 + n for a child a signal ended.
  if (exitCode > 128 && POLITE_SIGNALS.has(exitCode - 128)) return true;
  return exitCode === 0;
}

/** Statuses this app owns a live process in. */
export function isLive(status: RunStatus): boolean {
  return status === 'starting' || status === 'running' || status === 'stopping';
}

export function nextStatus(status: RunStatus, event: RunEvent): RunStatus {
  switch (event.type) {
    case 'start':
      if (status === 'stopped' || status === 'crashed' || status === 'external') return 'starting';
      throw new Error(`Cannot start a target that is ${status}`);
    case 'ready':
      // A late readiness signal for a target that has moved on changes nothing.
      return status === 'starting' ? 'running' : status;
    case 'exit':
      if (status === 'starting') return 'crashed';
      if (status === 'running') return isCleanExit(event.exitCode, event.signal) ? 'stopped' : 'crashed';
      if (status === 'stopping') return 'stopped';
      return status;
    case 'stop':
      if (status === 'starting' || status === 'running') return 'stopping';
      if (status === 'stopping') return 'stopping';
      throw new Error(`Cannot stop a target that is ${status}`);
    case 'gone':
      return status === 'stopping' ? 'stopped' : status;
  }
}
