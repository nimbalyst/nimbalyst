// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  hasRunningTasks,
  shouldDeferTeardownForSubagents,
  resolvePromptEndDelay,
  resolveShellDrainMs,
  DEFAULT_SHELL_DRAIN_MS,
  shouldExitDrain,
  classifyDrainOutcome,
  shouldSettleTaskFromToolResult,
  shouldRecordTerminalNotification,
  mapTaskUpdatedPatchStatus,
  shouldApplyTaskUpdatedStatus,
  isNotificationFlushResult,
  shouldArmGraceTimerForResult,
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

  // Updated for GitHub #1493: task TYPE is not evidence of backgroundness. The
  // CLI tracks foreground Bash calls as local_bash too, so with no flag the
  // acknowledgement text is what decides -- real output settles the task.
  it('settles a local_bash with no flag when the result is real output', () => {
    const task = { taskType: 'local_bash', status: 'running' };
    expect(shouldSettleTaskFromToolResult(task, 'exit code 0')).toBe(true);
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

  // Regression: NIM-1556. The sub-agent background-launch acknowledgement no
  // longer says "running in the background" — it now reads "Async agent
  // launched successfully. ... The agent is working in the background." and
  // arrives as an array of content blocks. Both differences made the guard
  // settle the task at launch, so the drain never engaged and teardown killed
  // the sub-agent 5s after the lead turn ended.
  it('does not settle a backgrounded sub-agent on the "Async agent launched" acknowledgement', () => {
    const task = { taskType: 'local_agent', status: 'running' };
    const ack =
      'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\n'
      + "agentId: a031abbe9a4b13f54 (internal ID - do not mention to user. Use SendMessage with to: 'a031abbe9a4b13f54', summary: '<5-10 word recap>' to continue this agent.)\n"
      + 'The agent is working in the background. You will be notified automatically when it completes.';
    expect(shouldSettleTaskFromToolResult(task, ack)).toBe(false);
  });

  it('does not settle on a launch acknowledgement delivered as content blocks', () => {
    const task = { taskType: 'local_agent', status: 'running' };
    expect(
      shouldSettleTaskFromToolResult(task, [
        { type: 'text', text: 'Async agent launched successfully.\nThe agent is working in the background.' },
      ]),
    ).toBe(false);
    expect(
      shouldSettleTaskFromToolResult(task, [
        { type: 'text', text: 'Task is now running in the background. Use TaskOutput to check.' },
      ]),
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

  // Regression: GitHub #1493. The SDK tracks EVERY Bash call as a local_bash
  // task, not just backgrounded ones, and reports foregroundness on
  // task_started as is_backgrounded:false. Refusing to settle on taskType
  // alone left a foreground shell "running" and then had the provider stamp
  // isBackgrounded on it, so its terminal notification produced a bogus
  // "background task(s) you launched have settled" continuation turn.
  it('settles a foreground local_bash whose tool_result carries real output', () => {
    const task = { taskType: 'local_bash', isBackgrounded: false, status: 'running' };
    expect(shouldSettleTaskFromToolResult(task, 'exit code 0\nbuild ok')).toBe(true);
  });

  it('settles a foreground local_bash whose output arrives as content blocks', () => {
    const task = { taskType: 'local_bash', isBackgrounded: false, status: 'running' };
    expect(shouldSettleTaskFromToolResult(task, [{ type: 'text', text: 'ok' }])).toBe(true);
  });

  // The flag can be stale: a shell launched in the foreground and moved to the
  // background returns the launch acknowledgement before any task_updated
  // patch lands. The acknowledgement text still wins.
  it('does not settle a local_bash marked foreground when the result is a launch acknowledgement', () => {
    const task = { taskType: 'local_bash', isBackgrounded: false, status: 'running' };
    const ack =
      'Command running in background with ID: b0hywzbc1. Output is being written to: /tmp/tasks/b0hywzbc1.output.';
    expect(shouldSettleTaskFromToolResult(task, ack)).toBe(false);
  });

  // Older CLIs omit is_backgrounded entirely. The launch-acknowledgement
  // fallback is what has to carry NIM-1470 there.
  it('refuses a local_bash with no flag on its launch acknowledgement', () => {
    const task = { taskType: 'local_bash', status: 'running' };
    expect(
      shouldSettleTaskFromToolResult(task, 'Command running in background with ID: b0hywzbc1.'),
    ).toBe(false);
  });
});

describe('shouldRecordTerminalNotification', () => {
  it('records everything still running at the lead result while draining', () => {
    expect(shouldRecordTerminalNotification({ taskType: 'local_agent' }, true)).toBe(true);
    expect(shouldRecordTerminalNotification({ taskType: 'local_bash', isBackgrounded: false }, true)).toBe(true);
  });

  // A shell launched in the foreground and auto-backgrounded gets promoted at
  // the tool_result (the acknowledgement is the evidence), never via a patch.
  // That promotion is what has to carry it into the notification gate.
  it('records a local_bash promoted by its launch acknowledgement', () => {
    expect(shouldRecordTerminalNotification({ taskType: 'local_bash', isBackgrounded: true }, false)).toBe(true);
  });

  it('records a backgrounded task off the drain path (#1410)', () => {
    expect(shouldRecordTerminalNotification({ taskType: 'local_agent', isBackgrounded: true }, false)).toBe(true);
  });

  it('ignores a foreground sub-agent off the drain path', () => {
    expect(shouldRecordTerminalNotification({ taskType: 'local_agent' }, false)).toBe(false);
  });

  // Regression: GitHub #1493. Admitting every local_bash turned each ordinary
  // foreground Bash call into a queued "background task settled" continuation
  // turn once the CLI started reporting shell tasks for foreground commands.
  it('ignores a local_bash the SDK reported as foreground', () => {
    expect(shouldRecordTerminalNotification({ taskType: 'local_bash', isBackgrounded: false }, false)).toBe(false);
  });

  // Type alone is not evidence. An unpromoted local_bash ran in the foreground
  // and its output is already inline; a continuation would be a second, paid
  // turn reporting something the model has seen.
  it('ignores a local_bash with no background evidence at all', () => {
    expect(shouldRecordTerminalNotification({ taskType: 'local_bash' }, false)).toBe(false);
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

describe('shouldArmGraceTimerForResult', () => {
  // Regression: NIM-1470 follow-up. The grace-period timer that ends the
  // control channel after N seconds of stream silence must NOT arm on the
  // notification-flush result — the CLI keeps working (minutes of silence
  // during a background sub-agent), so arming there ended the channel mid-turn
  // and every later Bash tool_result failed "Stream closed" while the
  // subprocess ran away (chunkCount climbing past 400, promptController=ended).
  const flushResult = { type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '' };
  const realResult = { type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: 'answer' };

  it('does NOT arm on a notification-flush result (the runaway-subprocess bug)', () => {
    expect(shouldArmGraceTimerForResult(flushResult, true, false)).toBe(false);
  });

  it('arms on the real turn result', () => {
    expect(shouldArmGraceTimerForResult(realResult, true, false)).toBe(true);
  });

  it('arms on a plain result when no task notification preceded it', () => {
    // Without a preceding task notification it is not a flush, so it is the
    // real end-of-turn and must arm (unchanged behavior for normal turns).
    expect(shouldArmGraceTimerForResult(flushResult, false, false)).toBe(true);
  });

  it('never arms on a non-result chunk', () => {
    expect(shouldArmGraceTimerForResult({ type: 'assistant' }, true, false)).toBe(false);
    expect(shouldArmGraceTimerForResult({ type: 'user' }, false, false)).toBe(false);
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

  // Regression: GitHub #1355. A background shell (local_bash) streams no chunks
  // while it runs, so the drain grace timer never resets and closes stdin after
  // its window — the CLI then kills the shell and reports it 'stopped'. That is
  // OUR teardown, not a user stop, but it took the same silent path: the session
  // woke with no message at all and neither the agent nor the user could tell
  // "killed" from "stopped". A killed-by-teardown task must be reported.
  it('continues for a task our own teardown killed, unlike a user stop', () => {
    expect(
      shouldContinueWithTaskResults('resolved', [
        { taskId: 'b1', description: 'gh run watch', status: 'stopped', killedByTeardown: true },
      ]),
    ).toBe(true);
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

  // #1355: name the cause instead of leaving a bare "stopped". The agent reads
  // this to decide whether to re-run the work — an ambiguous status caused a
  // duplicate paid re-run in the reporter's workspace.
  it('reports a teardown kill as killed, names the grace window, and keeps a user stop out', () => {
    const msg = buildTaskResultContinuationMessage([
      {
        taskId: 'b1',
        description: 'gh run watch 32603089993',
        status: 'stopped',
        killedByTeardown: true,
        outputFile: '/tmp/tasks/b1.output',
      },
      { taskId: 'b2', description: 'user stopped watcher', status: 'stopped' },
    ]);
    expect(msg).toContain('gh run watch 32603089993');
    expect(msg).toContain('killed');
    expect(msg).toContain('/tmp/tasks/b1.output');
    expect(msg).not.toContain('user stopped watcher');
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

describe('resolvePromptEndDelay', () => {
  const WINDOWS = { idle: 30_000, subagent: 300_000, shell: 1_800_000 };

  it('uses the short idle window when nothing is running', () => {
    expect(resolvePromptEndDelay([], WINDOWS)).toBe(30_000);
    expect(
      resolvePromptEndDelay(
        [{ status: 'completed', taskType: 'local_bash' }, { status: 'stopped' }],
        WINDOWS,
      ),
    ).toBe(30_000);
  });

  it('uses the sub-agent stall window for running sub-agents', () => {
    expect(resolvePromptEndDelay([{ status: 'running' }], WINDOWS)).toBe(300_000);
    expect(
      resolvePromptEndDelay([{ status: 'running', taskType: 'agent' }], WINDOWS),
    ).toBe(300_000);
  });

  // Regression: GitHub #1355. A local_bash task streams no chunks while it runs,
  // so it never reset the grace timer and the 5-minute sub-agent window killed
  // every background shell that outran it.
  it('uses the long shell window for a running background shell', () => {
    expect(
      resolvePromptEndDelay([{ status: 'running', taskType: 'local_bash' }], WINDOWS),
    ).toBe(1_800_000);
  });

  it('takes the max so a stalled sub-agent cannot cut short a live shell', () => {
    expect(
      resolvePromptEndDelay(
        [{ status: 'running' }, { status: 'running', taskType: 'local_bash' }],
        WINDOWS,
      ),
    ).toBe(1_800_000);
  });

  it('ignores a settled shell so it stops holding the stream open', () => {
    expect(
      resolvePromptEndDelay(
        [{ status: 'completed', taskType: 'local_bash' }, { status: 'running' }],
        WINDOWS,
      ),
    ).toBe(300_000);
  });
});

describe('resolveShellDrainMs', () => {
  it('defaults to 30 minutes', () => {
    expect(resolveShellDrainMs({})).toBe(DEFAULT_SHELL_DRAIN_MS);
    expect(DEFAULT_SHELL_DRAIN_MS).toBe(1_800_000);
  });

  it('honors a positive override', () => {
    expect(resolveShellDrainMs({ NIMBALYST_CC_SHELL_DRAIN_MS: '5000' })).toBe(5000);
  });

  it('falls back on a non-numeric or non-positive override', () => {
    expect(resolveShellDrainMs({ NIMBALYST_CC_SHELL_DRAIN_MS: 'soon' })).toBe(DEFAULT_SHELL_DRAIN_MS);
    expect(resolveShellDrainMs({ NIMBALYST_CC_SHELL_DRAIN_MS: '0' })).toBe(DEFAULT_SHELL_DRAIN_MS);
    expect(resolveShellDrainMs({ NIMBALYST_CC_SHELL_DRAIN_MS: '-1' })).toBe(DEFAULT_SHELL_DRAIN_MS);
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
