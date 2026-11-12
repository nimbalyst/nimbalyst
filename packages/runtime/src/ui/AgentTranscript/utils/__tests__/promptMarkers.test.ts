// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { TranscriptViewMessage } from '../../../../ai/server/types';
import { buildPromptMarkers } from '../promptMarkers';

let nextId = 1;
function msg(partial: Partial<TranscriptViewMessage>): TranscriptViewMessage {
  const id = nextId++;
  return { id, sequence: id, createdAt: new Date(1_700_000_000_000 + id * 1000), type: 'assistant_message', subagentId: null, ...partial } as TranscriptViewMessage;
}

function questionCall(toolName: string, providerToolCallId: string, args: Record<string, unknown>, result?: string): TranscriptViewMessage {
  return msg({
    type: 'tool_call',
    toolCall: {
      toolName, toolDisplayName: toolName, status: result ? 'completed' : 'running', description: null,
      arguments: args, targetFilePath: null, mcpServer: null, mcpTool: null, providerToolCallId, progress: [], result,
    },
  });
}

describe('buildPromptMarkers', () => {
  it('lists own prompts, agent prompts and answered questions in transcript order', () => {
    const messages = [
      msg({ type: 'user_message', text: 'Fix the menu', promptActor: 'human' }),
      questionCall('AskUserQuestion', 'q1', {
        questions: [{ question: 'Which layout?', header: 'Layout', options: [{ label: 'List' }, { label: 'Grid' }] }],
      }, JSON.stringify({ answers: { 'Which layout?': 'Grid' } })),
      msg({ type: 'assistant_message', text: 'Going with grid' }),
      msg({ type: 'user_message', text: '[Resuming after answering a question] go', promptActor: 'human' }),
      msg({ type: 'user_message', text: 'Child finished', promptActor: 'agent' }),
      msg({ type: 'user_message', text: 'system nudge', promptActor: 'system' }),
      questionCall('mcp__nimbalyst__PromptForUserInput', 'q2', {
        fields: [{ type: 'confirm', id: 'ship', label: 'Ship it?' }],
      }, JSON.stringify({ answers: { ship: { type: 'confirm', value: true } } })),
      questionCall('mcp__nimbalyst__PromptForUserInput', 'q3', {
        fields: [{ type: 'confirm', id: 'skip', label: 'Skipped?' }],
      }, JSON.stringify({ cancelled: true, reason: 'superseded' })),
      questionCall('AskUserQuestion', 'q4', { questions: [] }),
      msg({ type: 'user_message', text: 'Thanks' }),
    ];

    const markers = buildPromptMarkers(messages, 's1', false);

    expect(markers.map(m => [m.kind, m.promptNumber, m.promptText, m.answerText, m.outputIndex])).toEqual([
      ['prompt', 1, 'Fix the menu', undefined, 0],
      ['answer', undefined, 'Which layout?', 'Grid', 2],
      ['agentPrompt', undefined, 'Child finished', undefined, 4],
      ['answer', undefined, 'Ship it?', 'Yes', 6],
      ['prompt', 2, 'Thanks', undefined, 9],
    ]);
    expect(new Set(markers.map(m => m.id)).size).toBe(markers.length);
  });

  // #1577: an errored tool result is never an answer, even when the hook's
  // denial text happens to look like one.
  it('does not list a hook-denied question as an answer', () => {
    const denied = (call: TranscriptViewMessage): TranscriptViewMessage => ({
      ...call,
      toolCall: { ...call.toolCall!, status: 'error', isError: true },
    } as TranscriptViewMessage);
    const messages = [
      denied(questionCall('AskUserQuestion', 'd1', {
        questions: [{ question: 'mode', header: 'Mode', options: [{ label: 'short' }] }],
      }, 'Hook PreToolUse denied: use "mode"="short" instead')),
      denied(questionCall('mcp__nimbalyst__PromptForUserInput', 'd2', {
        fields: [{ type: 'confirm', id: 'ok', label: 'Ok?' }],
      }, 'Hook PreToolUse denied: {"answers":{"ok":{"type":"confirm","value":true}}}')),
    ];
    expect(buildPromptMarkers(messages, 's1', false).filter(m => m.kind === 'answer')).toEqual([]);
  });
});
