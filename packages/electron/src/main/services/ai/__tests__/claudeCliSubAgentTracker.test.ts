import { describe, it, expect, beforeEach } from 'vitest';
import {
  isSubAgentTurnInFlight,
  noteAssistantTaskCalls,
  noteToolResultsCompleteTasks,
  clearSubAgentTracking,
} from '../claudeCliSubAgentTracker';

const SID = 'session-1';

const turn = (blocks: Array<{ type: string; name?: string; id?: string }>) => ({ content: blocks });

describe('claudeCliSubAgentTracker', () => {
  beforeEach(() => clearSubAgentTracking(SID));

  it('treats turns as visible until a Task is in flight, hides them during, then restores', () => {
    // Parent turn ends with a Task call — itself still visible (checked before noting).
    expect(isSubAgentTurnInFlight(SID)).toBe(false);
    noteAssistantTaskCalls(SID, turn([{ type: 'tool_use', name: 'Task', id: 'toolu_task1' }]));

    // Sub-agent turns observed while the Task runs are in flight (→ hidden).
    expect(isSubAgentTurnInFlight(SID)).toBe(true);

    // A sub-agent's own Bash result does NOT end the window (not a Task id).
    noteToolResultsCompleteTasks(SID, ['toolu_bash_inner']);
    expect(isSubAgentTurnInFlight(SID)).toBe(true);

    // The Task's tool_result (in the parent's next body) closes the window.
    noteToolResultsCompleteTasks(SID, ['toolu_task1']);
    expect(isSubAgentTurnInFlight(SID)).toBe(false);
  });

  it('handles two parallel Tasks — window stays open until both resolve', () => {
    noteAssistantTaskCalls(
      SID,
      turn([
        { type: 'tool_use', name: 'Task', id: 'toolu_a' },
        { type: 'tool_use', name: 'Task', id: 'toolu_b' },
      ]),
    );
    expect(isSubAgentTurnInFlight(SID)).toBe(true);
    noteToolResultsCompleteTasks(SID, ['toolu_a']);
    expect(isSubAgentTurnInFlight(SID)).toBe(true);
    noteToolResultsCompleteTasks(SID, ['toolu_b']);
    expect(isSubAgentTurnInFlight(SID)).toBe(false);
  });

  it('ignores non-Task tool_use blocks and is isolated per session', () => {
    noteAssistantTaskCalls(SID, turn([{ type: 'tool_use', name: 'Bash', id: 'toolu_x' }]));
    expect(isSubAgentTurnInFlight(SID)).toBe(false);

    noteAssistantTaskCalls('other-session', turn([{ type: 'tool_use', name: 'Task', id: 'toolu_y' }]));
    expect(isSubAgentTurnInFlight(SID)).toBe(false);
    expect(isSubAgentTurnInFlight('other-session')).toBe(true);
    clearSubAgentTracking('other-session');
  });
});
