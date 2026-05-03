import { describe, expect, it } from 'vitest';
import { extractMessageText, extractUserPrompts } from '../metaAgentMessageText';

describe('extractMessageText', () => {
  describe('synthetic prompts and plain text', () => {
    it('returns prompt field for { prompt } shape', () => {
      const text = extractMessageText(JSON.stringify({ prompt: '  Hello world  ' }));
      expect(text).toBe('Hello world');
    });

    it('returns content for { type: "text", content } shape', () => {
      const text = extractMessageText(JSON.stringify({ type: 'text', content: 'plain' }));
      expect(text).toBe('plain');
    });

    it('returns trimmed plain string when not JSON', () => {
      expect(extractMessageText('  raw text  ')).toBe('raw text');
    });

    it('returns null for empty input', () => {
      expect(extractMessageText('')).toBeNull();
      expect(extractMessageText('   ')).toBeNull();
    });
  });

  describe('Claude / Claude Code shape', () => {
    it('joins text blocks from assistant.message.content', () => {
      const text = extractMessageText(JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'First line' },
            { type: 'tool_use', name: 'Read' },
            { type: 'text', text: 'Second line' },
          ],
        },
      }));
      expect(text).toBe('First line\nSecond line');
    });

    it('returns null when assistant message has no text blocks', () => {
      const text = extractMessageText(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read' }] },
      }));
      expect(text).toBeNull();
    });
  });

  describe('OpenAI Codex / OpenCode shapes', () => {
    it('extracts last_agent_message from task_complete event', () => {
      const text = extractMessageText(JSON.stringify({
        type: 'task_complete',
        last_agent_message: 'All done.',
      }));
      expect(text).toBe('All done.');
    });

    it('extracts text from item.completed agent_message item', () => {
      const text = extractMessageText(JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'The fix is in place.',
        },
      }));
      expect(text).toBe('The fix is in place.');
    });

    it('extracts text from item.completed with content array of text blocks', () => {
      const text = extractMessageText(JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          content: [
            { type: 'text', text: 'Part one.' },
            { type: 'text', text: 'Part two.' },
          ],
        },
      }));
      expect(text).toBe('Part one.\nPart two.');
    });

    it('extracts text from item.updated streaming event', () => {
      const text = extractMessageText(JSON.stringify({
        type: 'item.updated',
        item: {
          type: 'agent_message',
          text: 'Streaming chunk',
        },
      }));
      expect(text).toBe('Streaming chunk');
    });

    it('extracts text from reasoning items', () => {
      const text = extractMessageText(JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'reasoning',
          text: 'Thinking about it...',
        },
      }));
      expect(text).toBe('Thinking about it...');
    });

    it('extracts text from event_msg agent_message_delta payload', () => {
      const text = extractMessageText(JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'agent_message_delta',
          delta: 'partial response',
        },
      }));
      expect(text).toBe('partial response');
    });

    it('extracts text from delta with content array', () => {
      const text = extractMessageText(JSON.stringify({
        delta: {
          content: [{ type: 'output_text', text: 'streamed' }],
        },
      }));
      expect(text).toBe('streamed');
    });

    it('returns null for token_count events with no text', () => {
      const text = extractMessageText(JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { input_tokens: 100, output_tokens: 50 },
        },
      }));
      expect(text).toBeNull();
    });

    it('returns null for thread.started events', () => {
      const text = extractMessageText(JSON.stringify({
        type: 'thread.started',
        thread_id: 'abc-123',
      }));
      expect(text).toBeNull();
    });

    it('returns null for command_execution tool calls', () => {
      const text = extractMessageText(JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'ls -la',
          aggregated_output: 'file1\nfile2',
          exit_code: 0,
          status: 'completed',
        },
      }));
      expect(text).toBeNull();
    });
  });

  describe('system reminder filtering', () => {
    it('returns null when metadata.promptType is system_reminder', () => {
      const text = extractMessageText(
        '<SYSTEM_REMINDER>Call the session metadata tool now before continuing.</SYSTEM_REMINDER>',
        { promptType: 'system_reminder', reminderKind: 'session_naming' },
      );
      expect(text).toBeNull();
    });

    it('still extracts plain user prompts when metadata.promptType is absent', () => {
      const text = extractMessageText('Plain Codex user prompt', { mode: 'agent' });
      expect(text).toBe('Plain Codex user prompt');
    });
  });

  describe('interactive prompt summaries', () => {
    it('summarizes AskUserQuestion', () => {
      const text = extractMessageText(JSON.stringify({
        type: 'nimbalyst_tool_use',
        name: 'AskUserQuestion',
      }));
      expect(text).toBe('Interactive prompt: AskUserQuestion');
    });

    it('summarizes permission_request with toolName', () => {
      const text = extractMessageText(JSON.stringify({
        type: 'permission_request',
        toolName: 'Bash',
      }));
      expect(text).toBe('Permission request: Bash');
    });

    it('summarizes exit_plan_mode_request with planFilePath', () => {
      const text = extractMessageText(JSON.stringify({
        type: 'exit_plan_mode_request',
        planFilePath: 'plans/feature.md',
      }));
      expect(text).toBe('Plan ready for review: plans/feature.md');
    });
  });
});

describe('extractUserPrompts', () => {
  it('extracts JSON-wrapped prompts (Claude / Claude Code shape)', () => {
    const prompts = extractUserPrompts([
      { direction: 'input', content: JSON.stringify({ prompt: 'First task' }) },
      { direction: 'output', content: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } }) },
      { direction: 'input', content: JSON.stringify({ prompt: 'Second task' }) },
    ]);
    expect(prompts).toEqual(['First task', 'Second task']);
  });

  it('extracts raw plain-text prompts (Codex shape)', () => {
    const prompts = extractUserPrompts([
      { direction: 'input', content: 'In 2 sentences, what does the @nimbalyst/runtime package do? Then say DONE.', metadata: { mode: 'agent' } },
    ]);
    expect(prompts).toEqual(['In 2 sentences, what does the @nimbalyst/runtime package do? Then say DONE.']);
  });

  it('handles a mix of Claude and Codex inputs in order', () => {
    const prompts = extractUserPrompts([
      { direction: 'input', content: 'Plain Codex prompt', metadata: { mode: 'agent' } },
      { direction: 'input', content: JSON.stringify({ prompt: 'Wrapped Claude prompt' }) },
    ]);
    expect(prompts).toEqual(['Plain Codex prompt', 'Wrapped Claude prompt']);
  });

  it('skips system reminders by metadata.promptType', () => {
    const prompts = extractUserPrompts([
      { direction: 'input', content: 'Real user prompt', metadata: { mode: 'agent' } },
      {
        direction: 'input',
        content: '<SYSTEM_REMINDER>Call session metadata.</SYSTEM_REMINDER>',
        metadata: { promptType: 'system_reminder', reminderKind: 'session_naming' },
      },
      { direction: 'input', content: 'Another real prompt', metadata: { mode: 'agent' } },
    ]);
    expect(prompts).toEqual(['Real user prompt', 'Another real prompt']);
  });

  it('ignores output-direction messages', () => {
    const prompts = extractUserPrompts([
      { direction: 'output', content: 'assistant text' },
      { direction: 'input', content: 'user text' },
    ]);
    expect(prompts).toEqual(['user text']);
  });

  it('skips empty / whitespace-only content', () => {
    const prompts = extractUserPrompts([
      { direction: 'input', content: '   ', metadata: { mode: 'agent' } },
      { direction: 'input', content: JSON.stringify({ prompt: '   ' }) },
      { direction: 'input', content: 'real', metadata: { mode: 'agent' } },
    ]);
    expect(prompts).toEqual(['real']);
  });
});
