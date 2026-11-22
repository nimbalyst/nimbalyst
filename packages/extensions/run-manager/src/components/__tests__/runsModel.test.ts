// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { actionsFor, formatUptime, linkLabel, loadFailureNotice, statusLabel, targetFromDraft, targetIdFromName } from '../runsModel';

describe('actionsFor', () => {
  it('offers stop for a live target and start for one that is not', () => {
    expect(actionsFor({ status: 'running', hasLogs: true })).toMatchObject({ primary: 'stop', primaryEnabled: true, restartEnabled: true, logsEnabled: true });
    expect(actionsFor({ status: 'starting', hasLogs: true }).primary).toBe('stop');
    expect(actionsFor({ status: 'crashed', hasLogs: true })).toMatchObject({ primary: 'start', restartEnabled: true, logsEnabled: true });
    expect(actionsFor({ status: 'stopped', hasLogs: false })).toMatchObject({ primary: 'start', logsEnabled: false });
  });

  it('locks the buttons while a stop is in flight', () => {
    expect(actionsFor({ status: 'stopping', hasLogs: true })).toMatchObject({ primaryEnabled: false, restartEnabled: false });
  });

  it('asks for confirmation before stopping an external process and offers it neither restart nor logs', () => {
    expect(actionsFor({ status: 'external', hasLogs: false, externalPid: 48213 })).toEqual({
      primary: 'stop',
      primaryEnabled: true,
      stopNeedsConfirmation: true,
      restartEnabled: false,
      logsEnabled: false,
      logsHint: 'No logs: not started by Nimbalyst',
    });
    // The port is bound but the owner could not be named: nothing to signal.
    expect(actionsFor({ status: 'external', hasLogs: false, externalPid: 0 }).primaryEnabled).toBe(false);
  });
});

describe('formatUptime', () => {
  const start = 1_000_000;
  it('reads as m:ss, then hours and minutes, then days and hours', () => {
    expect(formatUptime(start, start + 4_000)).toBe('0:04');
    expect(formatUptime(start, start + (12 * 60 + 30) * 1000)).toBe('12:30');
    expect(formatUptime(start, start + (72 * 60 + 5) * 1000)).toBe('1h 12m');
    expect(formatUptime(start, start + (51 * 3600) * 1000)).toBe('2d 3h');
  });

  it('is empty for a target that is not up, and never negative', () => {
    expect(formatUptime(undefined, start)).toBe('');
    expect(formatUptime(start, start - 5000)).toBe('0:00');
  });
});

describe('labels', () => {
  it('names the exit code of a crash and the pid of an external process', () => {
    expect(statusLabel({ status: 'crashed', exitCode: 1 })).toBe('crashed (exit 1)');
    expect(statusLabel({ status: 'external', externalPid: 48213 })).toBe('external (pid 48213)');
    expect(statusLabel({ status: 'external', externalPid: 0 })).toBe('external');
    expect(statusLabel({ status: 'running' })).toBe('running');
  });

  it('shows a URL without its scheme', () => {
    expect(linkLabel('http://localhost:5173/')).toBe('localhost:5173');
    expect(linkLabel('https://app.local/admin')).toBe('app.local/admin');
  });
});

describe('new targets', () => {
  it('derives a unique id from the name', () => {
    expect(targetIdFromName('Web dev server', new Set())).toBe('web-dev-server');
    expect(targetIdFromName('Web dev server', new Set(['web-dev-server', 'web-dev-server-2']))).toBe('web-dev-server-3');
    expect(targetIdFromName('  !!!  ', new Set())).toBe('target');
  });

  it('builds a target from the form and rejects a missing command or a bad port', () => {
    expect(targetFromDraft({ name: ' API ', command: 'node api.js', port: '8787', cwd: 'packages/api' }, new Set())).toEqual({
      target: { id: 'api', name: 'API', command: 'node api.js', port: 8787, cwd: 'packages/api' },
    });
    expect(targetFromDraft({ name: 'API', command: '', port: '', cwd: '' }, new Set())).toEqual({ error: 'Enter the command to run.' });
    expect(targetFromDraft({ name: 'API', command: 'x', port: '99999', cwd: '' }, new Set())).toMatchObject({ error: expect.stringMatching(/Port/) });
  });
});

describe('loadFailureNotice', () => {
  it('treats a failed first read as the backend still starting, then as an error', () => {
    expect(loadFailureNotice(false, 'Backend tool not available', 2_000)).toEqual({ kind: 'starting' });
    expect(loadFailureNotice(false, 'Backend tool not available', 20_000)).toEqual({ kind: 'error', message: 'Backend tool not available' });
  });

  it('reports a failure after the panel has loaded as an error at once, and nothing when reads succeed', () => {
    expect(loadFailureNotice(true, 'boom', 100)).toEqual({ kind: 'error', message: 'boom' });
    expect(loadFailureNotice(false, null, 100)).toBeNull();
  });
});
