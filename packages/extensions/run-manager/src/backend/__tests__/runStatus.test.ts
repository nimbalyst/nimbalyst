// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isCleanExit, nextStatus } from '../runStatus';
import { runsBadge } from '../../shared/types';

describe('nextStatus', () => {
  it('follows the happy path: stopped, starting, running, stopping, stopped', () => {
    let status = nextStatus('stopped', { type: 'start' });
    expect(status).toBe('starting');
    status = nextStatus(status, { type: 'ready' });
    expect(status).toBe('running');
    status = nextStatus(status, { type: 'stop' });
    expect(status).toBe('stopping');
    expect(nextStatus(status, { type: 'exit', exitCode: 143 })).toBe('stopped');
    expect(nextStatus(status, { type: 'gone' })).toBe('stopped');
  });

  it('counts any exit before ready as a crash, even exit code 0', () => {
    expect(nextStatus('starting', { type: 'exit', exitCode: 0 })).toBe('crashed');
    expect(nextStatus('starting', { type: 'exit', exitCode: 1 })).toBe('crashed');
  });

  it('separates a clean exit from a crash once running', () => {
    expect(nextStatus('running', { type: 'exit', exitCode: 0 })).toBe('stopped');
    expect(nextStatus('running', { type: 'exit', exitCode: 1 })).toBe('crashed');
    // Ended from outside by SIGTERM (closing the tab, `kill`): not a crash.
    expect(nextStatus('running', { type: 'exit', exitCode: 0, signal: 15 })).toBe('stopped');
    // SIGKILL or a segfault is.
    expect(nextStatus('running', { type: 'exit', exitCode: 0, signal: 9 })).toBe('crashed');
    expect(nextStatus('running', { type: 'exit', exitCode: 139 })).toBe('crashed');
  });

  it('can be started again after a crash, and can be stopped while still starting', () => {
    expect(nextStatus('crashed', { type: 'start' })).toBe('starting');
    expect(nextStatus('starting', { type: 'stop' })).toBe('stopping');
  });

  it('rejects starting a live target and stopping one that is not running', () => {
    for (const status of ['starting', 'running', 'stopping'] as const) {
      expect(() => nextStatus(status, { type: 'start' })).toThrow(/Cannot start/);
    }
    for (const status of ['stopped', 'crashed'] as const) {
      expect(() => nextStatus(status, { type: 'stop' })).toThrow(/Cannot stop/);
    }
  });

  it('ignores a readiness signal or exit that arrives after the target moved on', () => {
    expect(nextStatus('stopping', { type: 'ready' })).toBe('stopping');
    expect(nextStatus('crashed', { type: 'ready' })).toBe('crashed');
    expect(nextStatus('stopped', { type: 'exit', exitCode: 1 })).toBe('stopped');
  });
});

describe('isCleanExit', () => {
  it('reads the shell convention of 128 + signal', () => {
    expect(isCleanExit(143)).toBe(true); // SIGTERM
    expect(isCleanExit(130)).toBe(true); // SIGINT
    expect(isCleanExit(137)).toBe(false); // SIGKILL
    expect(isCleanExit(1)).toBe(false);
  });
});

describe('runsBadge', () => {
  const badge = (...statuses: string[]) => runsBadge(statuses.map((status) => ({ status })) as never);

  it('shows nothing when nothing is running', () => {
    expect(badge()).toEqual({ value: null, tone: 'default' });
    expect(badge('stopped', 'external')).toEqual({ value: null, tone: 'default' });
  });

  it('puts a crash ahead of a start in progress, and that ahead of running', () => {
    expect(badge('running', 'stopped').tone).toBe('success');
    expect(badge('running', 'starting').tone).toBe('warning');
    expect(badge('running', 'stopping').tone).toBe('warning');
    expect(badge('running', 'starting', 'crashed').tone).toBe('error');
  });
});
