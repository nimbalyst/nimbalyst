// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { CodexSandboxSetup } from '../CodexSandboxSetup';

afterEach(() => vi.useRealTimers());

function fixture() {
  const child = new EventEmitter();
  const listeners = new Set<(method: string, data: unknown) => void>();
  const request = vi.fn(async (method: string): Promise<unknown> => method === 'windowsSandbox/readiness' ? { status: 'ready' } : { started: true });
  const connection = { child, client: { request, onNotification: (fn: (method: string, data: unknown) => void) => { listeners.add(fn); return () => listeners.delete(fn); } } };
  const reset = vi.fn();
  const ready = vi.fn();
  const setup = new CodexSandboxSetup({ connect: async () => connection, reset, ready, changed: vi.fn() });
  const complete = (data = { mode: 'elevated', success: true }) => listeners.forEach(fn => fn('windowsSandbox/setupCompleted', data));
  return { setup, child, request, reset, ready, complete, listeners };
}

it('waits for completion, rejects duplicate setup, and reloads readiness after success', async () => {
  const f = fixture();
  const pending = f.setup.start('elevated', '/workspace');
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith('windowsSandbox/setupStart', { mode: 'elevated', cwd: '/workspace' }));
  expect(f.setup.state.phase).toBe('running');
  expect(f.ready).not.toHaveBeenCalled();
  await expect(f.setup.start('unelevated', '/workspace')).rejects.toThrow(/already/);
  f.complete({ mode: 'unelevated', success: true });
  expect(f.ready).not.toHaveBeenCalled();
  f.complete();
  await pending;
  expect(f.reset).toHaveBeenCalledOnce();
  expect(f.ready).toHaveBeenCalledOnce();
  expect(f.setup.state).toMatchObject({ phase: 'idle', readiness: 'ready' });
  expect(f.listeners.size).toBe(0);
});

it.each(['exit', 'close', 'error'])('retires setup on child %s and ignores late success', async event => {
  const f = fixture();
  const pending = f.setup.start('elevated', '/workspace');
  const rejected = expect(pending).rejects.toThrow(/stopped|exited/);
  await vi.waitFor(() => expect(f.listeners.size).toBe(1));
  f.child.emit(event, new Error('stopped'));
  await rejected;
  f.complete();
  expect(f.ready).not.toHaveBeenCalled();
  expect(f.setup.state.phase).toBe('error');
});

it('bounds a missing completion and does not reuse its connection', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const pending = f.setup.start('elevated', '/workspace');
  const rejected = expect(pending).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(120_000);
  await rejected;
  expect(f.reset).toHaveBeenCalledOnce();
  expect(f.listeners.size).toBe(0);
  expect(f.ready).not.toHaveBeenCalled();
});

it('accepts completion arriving before acknowledgement and honors managed setup choices', async () => {
  const f = fixture();
  f.request.mockImplementation(async method => {
    if (method === 'windowsSandbox/setupStart') {
      f.complete();
      return { started: true };
    }
    if (method === 'configRequirements/read') return { requirements: { allowedWindowsSandboxImplementations: ['elevated'] } };
    return { status: 'ready' };
  });
  await f.setup.start('elevated', '/workspace');
  expect(f.setup.state.allowedModes).toEqual(['elevated']);
  expect(f.ready).toHaveBeenCalledOnce();
});

it('surfaces cancelled setup without reporting success', async () => {
  const f = fixture();
  const pending = f.setup.start('elevated', '/workspace');
  const rejected = expect(pending).rejects.toThrow(/cancelled/);
  await vi.waitFor(() => expect(f.listeners.size).toBe(1));
  f.complete({ mode: 'elevated', success: false });
  await rejected;
  expect(f.ready).not.toHaveBeenCalled();
  expect(f.reset).toHaveBeenCalledOnce();
});
