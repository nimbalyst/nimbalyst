// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { SessionIndicatorState } from '@nimbalyst/runtime';
import { mergeSuperLoopIndicatorState } from '../SuperLoopGroup';

const idle: SessionIndicatorState = { kind: 'idle' };

describe('Super Loop operational fallback', () => {
  it('shows loop-level running state before iteration sessions hydrate', () => {
    expect(mergeSuperLoopIndicatorState(idle, 'running')).toEqual({
      kind: 'working-self',
      hasBackground: false,
      backgroundCount: 0,
    });
  });

  it('lets canonical higher-priority attention beat loop-level running', () => {
    const error: SessionIndicatorState = { kind: 'error', message: 'Session error' };
    expect(mergeSuperLoopIndicatorState(error, 'running')).toBe(error);
  });

  it('lets loop-level lead work beat child-only activity', () => {
    expect(
      mergeSuperLoopIndicatorState({ kind: 'working-child', childCount: 2 }, 'running'),
    ).toMatchObject({ kind: 'working-self' });
  });

  it('maps blocked and failed loop states into canonical attention states', () => {
    expect(mergeSuperLoopIndicatorState({ kind: 'error', message: 'Child error' }, 'blocked')).toEqual({
      kind: 'needs-input',
      promptCount: 1,
      promptTypes: ['super_loop_feedback_request'],
    });
    expect(mergeSuperLoopIndicatorState({ kind: 'ready' }, 'failed')).toEqual({
      kind: 'error',
      message: 'Super Loop failed',
    });
  });

  it('preserves canonical state when the loop itself is quiescent', () => {
    const ready: SessionIndicatorState = { kind: 'ready' };
    expect(mergeSuperLoopIndicatorState(ready, 'completed')).toBe(ready);
  });
});
