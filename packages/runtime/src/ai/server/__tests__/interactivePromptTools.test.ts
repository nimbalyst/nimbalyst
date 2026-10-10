// @vitest-environment node
//
// #1341: Claude Code parks a slow MCP call at 120s and returns an
// acknowledgement in the tool_result slot. Treating that as the real result
// retires the question widget while the call is still running, so the user
// cannot answer a question that is still waiting on them.

import { describe, it, expect } from 'vitest';

import {
  isBackgroundedToolAck,
  isInteractiveWidgetTool,
  partitionUnansweredQuestions,
} from '../interactivePromptTools';
import { applyToolResultToToolCall } from '../providers/claudeCode/toolChunkUtils';

const MCP_ACK =
  'MCP tool "nimbalyst - AskUserQuestion (MCP)" is still running after 120s. '
  + 'It was moved to the background as task bq7x2k and keeps running; you\'ll receive a '
  + 'notification with the result when it completes.';

const BASH_ACK =
  'Command did not complete within its 120s timeout and was moved to the background (ID: bibikgthp).';

describe('isBackgroundedToolAck', () => {
  it('recognises the MCP and Bash/sub-agent wordings', () => {
    expect(isBackgroundedToolAck(MCP_ACK)).toBe(true);
    expect(isBackgroundedToolAck(BASH_ACK)).toBe(true);
    expect(isBackgroundedToolAck('Async agent launched successfully')).toBe(true);
  });

  it('does not mistake a real prompt answer for an acknowledgement', () => {
    // A settled prompt is always a JSON payload -- including one whose answer
    // text happens to quote the acknowledgement wording.
    expect(isBackgroundedToolAck(JSON.stringify({ answers: { q: 'moved to the background' } }))).toBe(false);
    expect(isBackgroundedToolAck(JSON.stringify({ cancelled: true }))).toBe(false);
    expect(isBackgroundedToolAck('')).toBe(false);
    expect(isBackgroundedToolAck(undefined)).toBe(false);
  });
});

describe('applyToolResultToToolCall', () => {
  it('leaves an interactive prompt pending on a background acknowledgement', () => {
    const toolCall: any = { name: 'mcp__nimbalyst__AskUserQuestion', arguments: { questions: [] } };

    const { isBackgroundAck } = applyToolResultToToolCall(toolCall, MCP_ACK, false);

    expect(isBackgroundAck).toBe(true);
    expect(toolCall.result).toBeUndefined();
  });

  it('still applies the acknowledgement to a non-interactive tool', () => {
    const toolCall: any = { name: 'mcp__nimbalyst-trackers__tracker_list', arguments: {} };

    const { isBackgroundAck } = applyToolResultToToolCall(toolCall, MCP_ACK, false);

    expect(isBackgroundAck).toBeFalsy();
    expect(toolCall.result).toBe(MCP_ACK);
  });

  it('applies the real answer once the prompt settles', () => {
    const toolCall: any = { name: 'mcp__nimbalyst__AskUserQuestion', arguments: {} };
    const answer = JSON.stringify({ answers: { 'Pick one': 'A' } });

    applyToolResultToToolCall(toolCall, MCP_ACK, false);
    const { isDuplicate } = applyToolResultToToolCall(toolCall, answer, false);

    expect(isDuplicate).toBe(false);
    expect(toolCall.result).toBe(answer);
  });
});

describe('isInteractiveWidgetTool', () => {
  it('matches bare and MCP-prefixed prompt tools only', () => {
    expect(isInteractiveWidgetTool('AskUserQuestion')).toBe(true);
    expect(isInteractiveWidgetTool('mcp__nimbalyst__developer_git_commit_proposal')).toBe(true);
    expect(isInteractiveWidgetTool('mcp__nimbalyst-trackers__tracker_list')).toBe(false);
    expect(isInteractiveWidgetTool(undefined)).toBe(false);
  });
});

describe('partitionUnansweredQuestions', () => {
  const question = (id: string, result?: string, toolName = 'mcp__nimbalyst__AskUserQuestion') =>
    ({ type: 'tool_call', toolCall: { toolName, providerToolCallId: id, result } });
  const user = { type: 'user_message' };

  it('closes questions the user answered by starting a new turn and keeps later ones open', () => {
    const { open, superseded } = partitionUnansweredQuestions([
      user,
      question('q1'),
      question('q2', JSON.stringify({ answers: { a: 'b' } })),
      question('perm', undefined, 'ToolPermission'),
      question('q3', undefined, 'mcp__nimbalyst__PromptForUserInput'),
      user,
      question('q4'),
    ]);

    expect(superseded.map(q => q.id)).toEqual(['q1', 'q3']);
    expect(superseded[1].toolName).toBe('PromptForUserInput');
    expect(open.map(q => q.id)).toEqual(['q4']);
  });

  it('keeps a question open after a cancel, which writes no user message', () => {
    const { open, superseded } = partitionUnansweredQuestions([user, question('q1'), { type: 'turn_ended' }]);
    expect(open.map(q => q.id)).toEqual(['q1']);
    expect(superseded).toEqual([]);
  });

  it('uses the last occurrence of an echoed tool call', () => {
    const answered = JSON.stringify({ answers: { a: 'b' } });
    const { open, superseded } = partitionUnansweredQuestions([
      question('q1'),
      user,
      question('q1', answered),
    ]);
    expect(open).toEqual([]);
    expect(superseded).toEqual([]);
  });

  it('only a human turn closes questions', () => {
    const answered = JSON.stringify({ answers: { a: 'b' } });
    // Stop with two open questions, answer one: the auto-resume must leave the
    // other answerable, with or without provenance on the row.
    for (const resume of [
      { type: 'user_message', text: '[Resuming after answering a question]\n\nq1: b' },
      { type: 'user_message', text: 'q1: b', promptOrigin: 'interactive-question' },
    ]) {
      const { open, superseded } = partitionUnansweredQuestions([
        user, question('q1', answered), question('q2'), resume,
      ]);
      expect(open.map(q => q.id)).toEqual(['q2']);
      expect(superseded).toEqual([]);
    }

    for (const nonBoundary of [
      { type: 'user_message', text: 'Child finished', promptActor: 'agent' },
      { type: 'user_message', text: 'Nightly run', promptActor: 'system' },
      // Shown before main persisted it; a failed send leaves it behind.
      { type: 'user_message', text: 'Do something else', optimistic: true },
    ]) {
      expect(partitionUnansweredQuestions([user, question('q1'), nonBoundary]).open.map(q => q.id)).toEqual(['q1']);
    }

    const human = { type: 'user_message', text: 'Do something else', promptActor: 'human' };
    expect(partitionUnansweredQuestions([user, question('q1'), human]).superseded.map(q => q.id)).toEqual(['q1']);
  });
});
