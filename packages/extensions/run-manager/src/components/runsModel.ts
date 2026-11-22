/**
 * What the Runs panel shows for a target, kept apart from the components so
 * the rules (which actions a status allows, how uptime reads) are testable.
 */
import type { RunTarget, RunView } from '../shared/types';

/** Status text in the Status column. */
export function statusLabel(run: Pick<RunView, 'status' | 'exitCode' | 'externalPid'>): string {
  if (run.status === 'crashed') return run.exitCode !== undefined ? `crashed (exit ${run.exitCode})` : 'crashed';
  if (run.status === 'external') return run.externalPid ? `external (pid ${run.externalPid})` : 'external';
  return run.status;
}

export interface RunActions {
  /** The first button: start, or stop. */
  primary: 'start' | 'stop';
  primaryEnabled: boolean;
  /** Stopping it needs the user to confirm: Nimbalyst did not start it. */
  stopNeedsConfirmation: boolean;
  restartEnabled: boolean;
  logsEnabled: boolean;
  /** Why the Logs button is off. */
  logsHint: string;
}

export function actionsFor(run: Pick<RunView, 'status' | 'hasLogs' | 'externalPid'>): RunActions {
  const logsHint = run.hasLogs
    ? 'Logs'
    : run.status === 'external'
      ? 'No logs: not started by Nimbalyst'
      : 'No logs yet: start the target first';
  switch (run.status) {
    case 'starting':
    case 'running':
      return { primary: 'stop', primaryEnabled: true, stopNeedsConfirmation: false, restartEnabled: true, logsEnabled: run.hasLogs, logsHint };
    case 'stopping':
      return { primary: 'stop', primaryEnabled: false, stopNeedsConfirmation: false, restartEnabled: false, logsEnabled: run.hasLogs, logsHint };
    case 'external':
      // Without a pid there is nothing this app can safely signal.
      return { primary: 'stop', primaryEnabled: !!run.externalPid, stopNeedsConfirmation: true, restartEnabled: false, logsEnabled: false, logsHint };
    case 'stopped':
    case 'crashed':
      return { primary: 'start', primaryEnabled: true, stopNeedsConfirmation: false, restartEnabled: true, logsEnabled: run.hasLogs, logsHint };
  }
}

/** `0:04` under a minute, `12:30` under an hour, then `1h 12m`, then `2d 3h`. */
export function formatUptime(startedAt: number | undefined, now: number): string {
  if (startedAt === undefined) return '';
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600) % 24;
  const days = Math.floor(total / 86400);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** A URL as link text: no scheme, no trailing slash. */
export function linkLabel(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

/** A target id from a display name, unique among `existingIds`. */
export function targetIdFromName(name: string, existingIds: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'target';
  if (!existingIds.has(base)) return base;
  for (let n = 2; ; n += 1) {
    if (!existingIds.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

export interface TargetDraft {
  name: string;
  command: string;
  port: string;
  cwd: string;
}

export const EMPTY_DRAFT: TargetDraft = { name: '', command: '', port: '', cwd: '' };

export function draftFromSuggestion(target: RunTarget): TargetDraft {
  return {
    name: target.name,
    command: target.command,
    port: target.port !== undefined ? String(target.port) : '',
    cwd: target.cwd ?? '',
  };
}

/** The target a filled-in form describes, or the reason it cannot be saved. */
export function targetFromDraft(
  draft: TargetDraft,
  existingIds: ReadonlySet<string>
): { target: RunTarget } | { error: string } {
  const name = draft.name.trim();
  const command = draft.command.trim();
  if (!name) return { error: 'Give the target a name.' };
  if (!command) return { error: 'Enter the command to run.' };
  const target: RunTarget = { id: targetIdFromName(name, existingIds), name, command };
  const port = draft.port.trim();
  if (port) {
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1 || value > 65535) return { error: 'Port must be a whole number from 1 to 65535.' };
    target.port = value;
  }
  const cwd = draft.cwd.trim();
  if (cwd) target.cwd = cwd;
  return { target };
}

/** How long a panel that has never loaded waits before calling a failed load an error. */
export const BACKEND_STARTUP_GRACE_MS = 15000;

/**
 * What to say when the runs could not be read. The backend module starts a
 * moment after the window, so a panel that is open at launch fails its first
 * reads; that is "starting", not an error, until the grace period runs out.
 */
export function loadFailureNotice(
  hasRows: boolean,
  loadError: string | null,
  elapsedMs: number
): { kind: 'starting' } | { kind: 'error'; message: string } | null {
  if (!loadError) return null;
  if (!hasRows && elapsedMs < BACKEND_STARTUP_GRACE_MS) return { kind: 'starting' };
  return { kind: 'error', message: loadError };
}
