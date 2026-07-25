/**
 * Regression tests for NIM-2019 / issue #943.
 *
 * The console overrides in logger.ts used `args.join(' ')`, so every object
 * argument reached main.log as `[object Object]`. The reporter's
 * `render-process-gone` details -- the whole diagnosis -- were among the
 * casualties, along with ~20 other diagnostics in a single session's log.
 */

import { describe, expect, it } from 'vitest';
import { formatLogArgs } from '../formatLogArgs';

describe('formatLogArgs', () => {
  it('renders object arguments instead of [object Object]', () => {
    const output = formatLogArgs([
      '[MAIN] Renderer process gone:',
      { reason: 'crashed', exitCode: 5, crashCountThisRun: 1 },
    ]);

    expect(output).not.toContain('[object Object]');
    expect(output).toContain('reason');
    expect(output).toContain('crashed');
    expect(output).toContain('exitCode');
    expect(output).toContain('5');
  });

  it('renders arrays of objects element by element', () => {
    const output = formatLogArgs(['models:', [{ id: 'opus' }, { id: 'sonnet' }]]);

    expect(output).not.toContain('[object Object]');
    expect(output).toContain('opus');
    expect(output).toContain('sonnet');
  });

  it('passes strings through untouched', () => {
    expect(formatLogArgs(['[MAIN]', 'workspace opened', '/tmp/x'])).toBe(
      '[MAIN] workspace opened /tmp/x'
    );
  });

  it('prefers an error stack over its inspected shape', () => {
    const error = new Error('boom');
    const output = formatLogArgs(['failed:', error]);

    expect(output).toContain('failed:');
    expect(output).toContain('Error: boom');
    expect(output).toContain('formatLogArgs.test');
  });

  it('stays on a single line so main.log remains line-oriented', () => {
    const output = formatLogArgs([{ a: 1, b: { c: 2, d: [3, 4, 5] }, e: 'six' }]);

    expect(output).not.toContain('\n');
  });

  it('truncates oversized arguments rather than flooding the log', () => {
    const huge = { blob: 'x'.repeat(20_000) };
    const output = formatLogArgs([huge]);

    expect(output).toContain('(truncated,');
    expect(output.length).toBeLessThan(4200);
  });

  it('does not throw when inspection fails', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('nope');
        },
      }
    );

    expect(() => formatLogArgs(['x', hostile])).not.toThrow();
  });

  it('renders null and undefined distinguishably', () => {
    expect(formatLogArgs([null, undefined])).toBe('null undefined');
  });
});
