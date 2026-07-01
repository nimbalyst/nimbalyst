import { describe, it, expect } from 'vitest';
import {
  hasRunningTasks,
  shouldDeferTeardownForSubagents,
  shouldExitDrain,
  classifyDrainOutcome,
} from '../subagentDrain';

describe('hasRunningTasks', () => {
  it('is false with no running tasks', () => {
    expect(hasRunningTasks([])).toBe(false);
    expect(hasRunningTasks([{ status: 'completed' }, { status: 'stopped' }])).toBe(false);
  });

  it('is true when at least one task is running', () => {
    expect(hasRunningTasks([{ status: 'completed' }, { status: 'running' }])).toBe(true);
  });
});

describe('shouldDeferTeardownForSubagents', () => {
  it('defers only while a sub-agent is still running', () => {
    expect(shouldDeferTeardownForSubagents(true)).toBe(true);
    expect(shouldDeferTeardownForSubagents(false)).toBe(false);
  });
});

describe('shouldExitDrain', () => {
  it('exits once draining and all sub-agents have resolved', () => {
    expect(shouldExitDrain(true, true, false)).toBe(true);
  });

  it('keeps draining while a sub-agent is still running', () => {
    expect(shouldExitDrain(true, true, true)).toBe(false);
  });

  it('does not exit-via-drain before complete was emitted or when not draining', () => {
    expect(shouldExitDrain(false, true, false)).toBe(false);
    expect(shouldExitDrain(true, false, false)).toBe(false);
  });
});

describe('classifyDrainOutcome', () => {
  it('does nothing when we were not draining', () => {
    expect(
      classifyDrainOutcome({ wasDraining: false, hasRunningTasks: true, cause: 'iterator-error' }),
    ).toEqual({ markStopped: false, autoContinue: false });
  });

  it('does nothing when no tasks are left running (clean resolve)', () => {
    expect(
      classifyDrainOutcome({ wasDraining: true, hasRunningTasks: false, cause: 'resolved' }),
    ).toEqual({ markStopped: false, autoContinue: false });
  });

  it('auto-continues on unexpected iterator end with tasks still running', () => {
    expect(
      classifyDrainOutcome({ wasDraining: true, hasRunningTasks: true, cause: 'iterator-done' }),
    ).toEqual({ markStopped: true, autoContinue: true });
    expect(
      classifyDrainOutcome({ wasDraining: true, hasRunningTasks: true, cause: 'iterator-error' }),
    ).toEqual({ markStopped: true, autoContinue: true });
  });

  it('marks stopped but does NOT auto-continue on user stop / supersede', () => {
    expect(
      classifyDrainOutcome({ wasDraining: true, hasRunningTasks: true, cause: 'aborted' }),
    ).toEqual({ markStopped: true, autoContinue: false });
    expect(
      classifyDrainOutcome({ wasDraining: true, hasRunningTasks: true, cause: 'interrupted' }),
    ).toEqual({ markStopped: true, autoContinue: false });
  });
});
