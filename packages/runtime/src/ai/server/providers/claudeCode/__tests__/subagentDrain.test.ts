import { describe, it, expect } from 'vitest';
import {
  hasRunningTasks,
  shouldDeferTeardownForSubagents,
  shouldExitDrain,
  classifyDrainOutcome,
  shouldSettleTaskFromToolResult,
  mapTaskUpdatedPatchStatus,
  shouldApplyTaskUpdatedStatus,
  isNotificationFlushResult,
  shouldContinueWithTaskResults,
  buildTaskResultContinuationMessage,
} from '../subagentDrain';

describe('shouldSettleTaskFromToolResult', () => {
  // Regression: NIM-1470. A backgrounded Bash returns its "Command running in
  // background with ID: ..." tool_result immediately, while the task is still
  // running. Settling the task on that acknowledgement made hasRunningTasks()
  // false at turn end, so the drain never engaged and the CLI subprocess (and
  // the build it was running) was killed at teardown.
  it('does not settle a local_bash task on its background-launch acknowledgement', () => {
    const task = { taskType: 'local_bash', status: 'running' };
    const ack =
      'Command running in background with ID: b0hywzbc1. Output is being written to: /tmp/tasks/b0hywzbc1.output.';
    expect(shouldSettleTaskFromToolResult(task, ack)).toBe(false);
  });

  it('never settles a local_bash task from a tool_result, whatever the content', () => {
    const task = { taskType: 'local_bash', status: 'running' };
    expect(shouldSettleTaskFromToolResult(task, 'exit code 0')).toBe(false);
  });

  it('does not settle a backgrounded sub-agent (task_updated is_backgrounded)', () => {
    const task = { taskType: 'local_agent', isBackgrounded: true, status: 'running' };
    expect(shouldSettleTaskFromToolResult(task, 'some agent output')).toBe(false);
  });

  it('does not settle any task on a "running in the background" acknowledgement', () => {
    const task = { taskType: 'local_agent', status: 'running' };
    expect(
      shouldSettleTaskFromToolResult(task, 'Task is now running in the background. Use TaskOutput to check.'),
    ).toBe(false);
  });

  it('settles a foreground sub-agent whose tool call blocked until completion', () => {
    const task = { taskType: 'local_agent', status: 'running' };
    expect(shouldSettleTaskFromToolResult(task, 'Agent finished: findings attached.')).toBe(true);
  });

  it('does not settle a task that is not running', () => {
    const task = { taskType: 'local_agent', status: 'completed' };
    expect(shouldSettleTaskFromToolResult(task, 'done')).toBe(false);
  });

  it('settles on non-string content for a foreground sub-agent', () => {
    const task = { taskType: 'local_agent', status: 'running' };
    expect(shouldSettleTaskFromToolResult(task, [{ type: 'text', text: 'done' }])).toBe(true);
  });
});

describe('mapTaskUpdatedPatchStatus', () => {
  it('maps non-terminal states to running', () => {
    expect(mapTaskUpdatedPatchStatus('pending')).toBe('running');
    expect(mapTaskUpdatedPatchStatus('running')).toBe('running');
    expect(mapTaskUpdatedPatchStatus('paused')).toBe('running');
  });

  it('maps terminal states', () => {
    expect(mapTaskUpdatedPatchStatus('completed')).toBe('completed');
    expect(mapTaskUpdatedPatchStatus('failed')).toBe('failed');
    expect(mapTaskUpdatedPatchStatus('killed')).toBe('stopped');
  });

  it('returns undefined for absent/unknown status', () => {
    expect(mapTaskUpdatedPatchStatus(undefined)).toBeUndefined();
    expect(mapTaskUpdatedPatchStatus('something_new')).toBeUndefined();
  });
});

describe('shouldApplyTaskUpdatedStatus', () => {
  // Live-verification finding (NIM-1470): the CLI emits a terminal task_updated
  // patch BEFORE the task_notification. Settling the task from the patch made
  // shouldExitDrain break the loop before the notification chunk was read, so
  // drainTerminalNotifications stayed empty and the wake continuation never
  // fired. While draining, only task_notification may settle a task.
  it('does not apply a terminal status while draining', () => {
    expect(shouldApplyTaskUpdatedStatus('completed', true)).toBe(false);
    expect(shouldApplyTaskUpdatedStatus('failed', true)).toBe(false);
    expect(shouldApplyTaskUpdatedStatus('stopped', true)).toBe(false);
  });

  it('applies terminal status when not draining', () => {
    expect(shouldApplyTaskUpdatedStatus('completed', false)).toBe(true);
    expect(shouldApplyTaskUpdatedStatus('stopped', false)).toBe(true);
  });

  it('always applies non-terminal status; never applies undefined', () => {
    expect(shouldApplyTaskUpdatedStatus('running', true)).toBe(true);
    expect(shouldApplyTaskUpdatedStatus('running', false)).toBe(true);
    expect(shouldApplyTaskUpdatedStatus(undefined, false)).toBe(false);
  });
});

describe('isNotificationFlushResult', () => {
  // Regression: NIM-1470. Resuming a session with a stale background task, the
  // CLI emitted task_notification(stopped) chunks followed by an empty success
  // result (num_turns=0, 93ms) BEFORE processing the user's prompt. Ending the
  // turn there swallowed the prompt.
  const flushResult = { type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '' };

  it('detects the flush result after task notifications with no assistant output', () => {
    expect(isNotificationFlushResult(flushResult, true, false)).toBe(true);
  });

  it('is not a flush result without a preceding task notification', () => {
    expect(isNotificationFlushResult(flushResult, false, false)).toBe(false);
  });

  it('is not a flush result once assistant output was seen', () => {
    expect(isNotificationFlushResult(flushResult, true, true)).toBe(false);
  });

  it('is not a flush result when the turn did real work or errored', () => {
    expect(
      isNotificationFlushResult({ ...flushResult, num_turns: 3, result: 'answer' }, true, false),
    ).toBe(false);
    expect(
      isNotificationFlushResult({ ...flushResult, subtype: 'error_during_execution' }, true, false),
    ).toBe(false);
    expect(isNotificationFlushResult({ ...flushResult, is_error: true }, true, false)).toBe(false);
  });
});

describe('shouldContinueWithTaskResults', () => {
  it('continues after a clean resolve with a completed or failed task', () => {
    expect(
      shouldContinueWithTaskResults('resolved', [
        { taskId: 'b1', description: 'build', status: 'completed' },
      ]),
    ).toBe(true);
    expect(
      shouldContinueWithTaskResults('resolved', [
        { taskId: 'b1', description: 'build', status: 'failed' },
      ]),
    ).toBe(true);
  });

  it('does not continue for stopped-only notifications (user stopped the task)', () => {
    expect(
      shouldContinueWithTaskResults('resolved', [
        { taskId: 'b1', description: 'build', status: 'stopped' },
      ]),
    ).toBe(false);
  });

  it('does not continue when the drain did not resolve cleanly', () => {
    expect(
      shouldContinueWithTaskResults('aborted', [
        { taskId: 'b1', description: 'build', status: 'completed' },
      ]),
    ).toBe(false);
    expect(shouldContinueWithTaskResults('resolved', [])).toBe(false);
  });
});

describe('buildTaskResultContinuationMessage', () => {
  it('includes description, status, summary and output file; skips stopped tasks', () => {
    const msg = buildTaskResultContinuationMessage([
      {
        taskId: 'b1',
        description: 'Run build:mac:local packaging',
        status: 'completed',
        summary: 'BUILD_EXIT=0',
        outputFile: '/tmp/tasks/b1.output',
      },
      { taskId: 'b2', description: 'stopped watcher', status: 'stopped' },
    ]);
    expect(msg).toContain('Run build:mac:local packaging');
    expect(msg).toContain('completed');
    expect(msg).toContain('BUILD_EXIT=0');
    expect(msg).toContain('/tmp/tasks/b1.output');
    expect(msg).not.toContain('stopped watcher');
  });
});

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
