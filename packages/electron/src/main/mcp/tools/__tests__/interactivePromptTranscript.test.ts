/**
 * NIM-806: synthetic transcript rows that make MCP interactive-prompt widgets
 * render for `claude-code-cli` sessions (the external CLI never writes to
 * `ai_agent_messages`, so without these the durable-prompt surface has nothing
 * to render and the CLI hangs).
 *
 * The faithful tests drive the REAL runtime projection
 * (`projectRawMessagesToViewMessages`) the renderer uses, asserting the
 * builders' rows become a widget-renderable tool call keyed by the CLI's
 * `claudecode/toolUseId`, and that a result row clears it.
 */
import { describe, it, expect } from 'vitest';
import { projectRawMessagesToViewMessages } from '@nimbalyst/runtime/ai/server/transcript';
import type { RawMessage } from '@nimbalyst/runtime/ai/server/transcript';
import {
  buildInteractivePromptToolUseContent,
  buildInteractivePromptToolResultContent,
} from '../interactivePromptTranscript';

const SESSION_ID = 'cli-session-1';
const TOOL_USE_ID = 'toolu_01CliAskUserQuestion';

function raw(overrides: Partial<RawMessage>): RawMessage {
  return {
    id: 1,
    sessionId: SESSION_ID,
    source: 'claude-code',
    direction: 'output',
    content: '',
    createdAt: new Date('2026-06-08T00:00:00Z'),
    ...overrides,
  };
}

function findToolCall(vms: any[]): any | undefined {
  return vms.find((m) => m?.toolCall?.toolName)?.toolCall;
}

describe('interactivePromptTranscript builders', () => {
  it('builds a nimbalyst_tool_use row with the fields ClaudeCodeRawParser reads', () => {
    const content = buildInteractivePromptToolUseContent({
      toolUseId: TOOL_USE_ID,
      toolName: 'AskUserQuestion',
      input: { questions: [{ header: 'Q', question: 'Tabs or spaces?', options: [] }] },
    });
    const parsed = JSON.parse(content);
    expect(parsed.type).toBe('nimbalyst_tool_use');
    expect(parsed.id).toBe(TOOL_USE_ID);
    expect(parsed.name).toBe('AskUserQuestion');
    expect(parsed.input.questions[0].question).toBe('Tabs or spaces?');
  });

  it('builds a nimbalyst_tool_result row keyed by tool_use_id with a string result', () => {
    const content = buildInteractivePromptToolResultContent({
      toolUseId: TOOL_USE_ID,
      result: { answers: { 'Tabs or spaces?': 'Tabs' } },
      isError: false,
    });
    const parsed = JSON.parse(content);
    expect(parsed.type).toBe('nimbalyst_tool_result');
    expect(parsed.tool_use_id).toBe(TOOL_USE_ID);
    expect(typeof parsed.result).toBe('string');
    expect(JSON.parse(parsed.result).answers['Tabs or spaces?']).toBe('Tabs');
    expect(parsed.is_error).toBe(false);
  });
});

describe('interactive-prompt synthetic rows project into a widget-renderable tool call', () => {
  const questions = [
    {
      header: 'Indentation',
      question: 'Do you prefer tabs or spaces?',
      options: [
        { label: 'Tabs', description: 'Tab characters.' },
        { label: 'Spaces', description: 'Space characters.' },
      ],
      multiSelect: false,
    },
  ];

  it('renders a pending AskUserQuestion tool call (the gap that hangs the CLI)', async () => {
    const messages: RawMessage[] = [
      raw({
        id: 1,
        content: buildInteractivePromptToolUseContent({
          toolUseId: TOOL_USE_ID,
          toolName: 'AskUserQuestion',
          input: { questions },
        }),
      }),
    ];

    const vms = await projectRawMessagesToViewMessages(messages, 'claude-code-cli');
    const toolCall = findToolCall(vms);

    expect(toolCall).toBeDefined();
    expect(toolCall.toolName).toBe('AskUserQuestion');
    // Widget keys its answer channel off providerToolCallId; it MUST equal the
    // MCP handler's response id (the CLI's claudecode/toolUseId).
    expect(toolCall.providerToolCallId).toBe(TOOL_USE_ID);
    expect(toolCall.arguments.questions[0].question).toBe('Do you prefer tabs or spaces?');
    // Pending: no result yet -> ClaudeCliPromptSurface renders it.
    expect(toolCall.result == null || toolCall.result === '').toBe(true);
  });

  // NIM-806: the proxy observation bridge now persists the CLI's whole assistant
  // turn (source 'claude-code') INCLUDING the AskUserQuestion tool_use block, so
  // the synthetic nimbalyst_tool_use row is redundant — and writing both caused an
  // ordering inversion (synthetic row at tool-call time sorts BEFORE the proxy
  // turn's explanatory text, persisted ~26ms later at message_stop) plus a
  // double-rendered question. This proves the proxy turn ALONE renders the same
  // answerable widget, ordered AFTER its text — the safety net for dropping the
  // synthetic write (Option B).
  it('renders the answerable AskUserQuestion widget from the proxy assistant turn, after its text', async () => {
    const messages: RawMessage[] = [
      raw({
        id: 1,
        content: JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_proxyturn',
            role: 'assistant',
            model: 'claude-opus-4-8',
            content: [
              { type: 'text', text: 'Here is my analysis. How do you want to take this forward?' },
              {
                // The model calls the MCP tool, so the proxy turn carries the
                // FULL mcp name (verified against live row 1625835), not the bare
                // 'AskUserQuestion'. The widget must still render from this.
                type: 'tool_use',
                id: TOOL_USE_ID,
                name: 'mcp__nimbalyst-mcp__AskUserQuestion',
                input: { questions },
              },
            ],
          },
        }),
      }),
    ];

    const vms = await projectRawMessagesToViewMessages(messages, 'claude-code-cli');

    // Exactly ONE AskUserQuestion widget (no duplicate), keyed for the answer
    // channel. The projector preserves the full MCP tool name; CustomToolWidgets
    // registers 'mcp__nimbalyst-mcp__AskUserQuestion' -> AskUserQuestionWidget
    // (index.ts), so it renders the interactive widget.
    const isAuq = (m: any) => typeof m?.toolCall?.toolName === 'string' && m.toolCall.toolName.endsWith('AskUserQuestion');
    const toolCalls = vms.filter(isAuq);
    expect(toolCalls).toHaveLength(1);
    const toolCall: any = (toolCalls[0] as any).toolCall;
    expect(toolCall.toolName).toBe('mcp__nimbalyst-mcp__AskUserQuestion');
    expect(toolCall.providerToolCallId).toBe(TOOL_USE_ID);
    expect(toolCall.arguments.questions[0].question).toBe('Do you prefer tabs or spaces?');
    // Pending (no result yet) -> still answerable.
    expect(toolCall.result == null || toolCall.result === '').toBe(true);

    // Ordering: the explanatory text must come BEFORE the question widget.
    const textIdx = vms.findIndex((m: any) =>
      typeof m?.text === 'string' && m.text.includes('How do you want to take this forward'),
    );
    const widgetIdx = vms.findIndex(isAuq);
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(widgetIdx).toBeGreaterThan(textIdx);
  });

  it('clears the tool call once the synthetic tool_result is appended', async () => {
    const messages: RawMessage[] = [
      raw({
        id: 1,
        content: buildInteractivePromptToolUseContent({
          toolUseId: TOOL_USE_ID,
          toolName: 'AskUserQuestion',
          input: { questions },
        }),
      }),
      raw({
        id: 2,
        createdAt: new Date('2026-06-08T00:00:01Z'),
        content: buildInteractivePromptToolResultContent({
          toolUseId: TOOL_USE_ID,
          result: { answers: { 'Do you prefer tabs or spaces?': 'Tabs' } },
          isError: false,
        }),
      }),
    ];

    const vms = await projectRawMessagesToViewMessages(messages, 'claude-code-cli');
    const toolCall = findToolCall(vms);

    expect(toolCall).toBeDefined();
    expect(toolCall.providerToolCallId).toBe(TOOL_USE_ID);
    // Completed: result populated -> ClaudeCliPromptSurface drops it from pending.
    expect(toolCall.result).toBeTruthy();
    expect(String(toolCall.result)).toContain('Tabs');
  });
});
