import { describe, expect, it } from 'vitest';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/types';
import {
  assembleTranscriptSelection,
  MAX_TRANSCRIPT_SELECTION_CHARS,
  tidySelectionText,
} from '../transcriptSelectionText';

function msg(type: TranscriptViewMessage['type'], text = '', toolCall?: Partial<NonNullable<TranscriptViewMessage['toolCall']>>) {
  return { type, text, toolCall } as TranscriptViewMessage;
}

const conversation = [
  msg('user_message', 'Can you **check** the plan?'),
  msg('tool_call', '', { toolName: 'Read', toolDisplayName: 'Read', targetFilePath: '/ws/plan.md' }),
  msg('assistant_message', 'Two questions:\n\n1. Dedupe?\n2. `ticket` it?'),
  msg('turn_ended'),
  msg('user_message', 'yes'),
];

describe('assembleTranscriptSelection', () => {
  it('uses the markdown source for a wholly selected message', () => {
    expect(assembleTranscriptSelection(conversation, { index: 0 }, { index: 0 }))
      .toEqual({ text: 'Can you **check** the plan?', author: 'user' });
  });

  it('uses the rendered text for a partly selected message', () => {
    expect(assembleTranscriptSelection(conversation, { index: 2, partialText: 'Dedupe?' }, { index: 2, partialText: 'Dedupe?' }))
      .toEqual({ text: 'Dedupe?', author: 'assistant' });
  });

  it('includes every message between the ends, labeled by author, with tool calls as markers', () => {
    const result = assembleTranscriptSelection(conversation, { index: 0, partialText: 'the plan?' }, { index: 4 });
    expect(result?.author).toBe('mixed');
    expect(result?.text).toBe(
      '[User]\nthe plan?\n\n' +
      '[Your reply]\n[Tool call: Read (/ws/plan.md)]\n\nTwo questions:\n\n1. Dedupe?\n2. `ticket` it?\n\n' +
      '[User]\nyes',
    );
  });

  it('includes the tool calls drawn inside a wholly selected starting row', () => {
    expect(assembleTranscriptSelection(conversation, { index: 2 }, { index: 2 })?.text)
      .toMatch(/^\[Tool call: Read \(\/ws\/plan\.md\)\]\n\nTwo questions/);
  });

  it('marks a selection cut at the size limit', () => {
    const long = [msg('assistant_message', 'x'.repeat(MAX_TRANSCRIPT_SELECTION_CHARS + 10))];
    expect(assembleTranscriptSelection(long, { index: 0 }, { index: 0 })?.text)
      .toContain(`showing the first ${MAX_TRANSCRIPT_SELECTION_CHARS} of ${MAX_TRANSCRIPT_SELECTION_CHARS + 10} characters`);
  });

  it('leaves out the context Nimbalyst appended to a sent user message', () => {
    const sent = [msg('user_message', 'yes\n\n<NIMBALYST_SYSTEM_MESSAGE>\n<SELECTED_TEXT>old</SELECTED_TEXT>\n</NIMBALYST_SYSTEM_MESSAGE>')];
    expect(assembleTranscriptSelection(sent, { index: 0 }, { index: 0 })?.text).toBe('yes');
  });

  it("takes a tool's file path from its arguments when the projection has none", () => {
    const edit = [
      msg('tool_call', '', { toolName: 'Edit', toolDisplayName: 'Edit', targetFilePath: null, arguments: { file_path: '/ws/a.ts' } }),
      msg('assistant_message', 'Done.'),
    ];
    expect(assembleTranscriptSelection(edit, { index: 1 }, { index: 1 })?.text).toBe('[Tool call: Edit (/ws/a.ts)]\n\nDone.');
  });

  it('returns null when nothing selected has text', () => {
    expect(assembleTranscriptSelection(conversation, { index: 3 }, { index: 3 })).toBeNull();
  });
});

describe('tidySelectionText', () => {
  it('drops leading blank lines and trailing whitespace but keeps indentation', () => {
    expect(tidySelectionText('\n  \n    return x;\n  ')).toBe('    return x;');
  });
});
