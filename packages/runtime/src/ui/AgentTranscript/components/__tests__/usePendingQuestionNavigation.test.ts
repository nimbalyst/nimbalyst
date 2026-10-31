// @vitest-environment node
//
// Several question cards can be open at once: a question abandoned without a
// result stays open after the agent re-asks it under a new id. Navigation must
// target the newest one, the card a live agent turn is waiting on.

import { describe, expect, it } from 'vitest';
import type { TranscriptViewMessage } from '../../../../ai/server/types';
import {
  findPendingQuestions,
  newestPendingQuestion,
  selectAutoJumpQuestion,
} from '../usePendingQuestionNavigation';

const question = (id: string) => ({
  type: 'tool_call',
  toolCall: { toolName: 'AskUserQuestion', providerToolCallId: id },
}) as TranscriptViewMessage;
const reply = { type: 'assistant_message', text: '' } as TranscriptViewMessage;

describe('pending question selection', () => {
  const transcript = [question('stale'), reply, question('live'), reply];
  const pending = findPendingQuestions(transcript);

  it('targets the newest open question, not an abandoned card above it', () => {
    expect(pending.map(q => q.id)).toEqual(['stale', 'live']);
    expect(newestPendingQuestion(pending)).toEqual({ id: 'live', rowIndex: 3 });
    expect(newestPendingQuestion([])).toBeUndefined();
  });

  it('auto-jumps once per newly opened question and never to an older card', () => {
    expect(selectAutoJumpQuestion(pending, new Set())?.id).toBe('live');
    expect(selectAutoJumpQuestion(pending, new Set(['live']))).toBeUndefined();

    const reasked = findPendingQuestions([...transcript, question('reasked'), reply]);
    expect(selectAutoJumpQuestion(reasked, new Set(['stale', 'live']))?.id).toBe('reasked');
  });
});
