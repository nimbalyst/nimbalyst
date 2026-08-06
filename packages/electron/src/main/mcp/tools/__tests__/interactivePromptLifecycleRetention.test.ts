import { describe, expect, it } from 'vitest';
import { buildInteractivePromptToolUseContent } from '../interactivePromptTranscript';

describe('structured prompt lifecycle retention', () => {
  it('persists an answerable AskUserQuestion identity and payload before the turn can settle', () => {
    const content = JSON.parse(buildInteractivePromptToolUseContent({
      toolUseId: 'question-1',
      toolName: 'AskUserQuestion',
      input: {
        questions: [{
          header: 'Acceptance',
          question: 'Complete the artifact-bound V13 acceptance?',
          options: [{ label: 'Continue', description: 'continue' }],
        }],
      },
    }));

    expect(content).toEqual({
      type: 'nimbalyst_tool_use',
      id: 'question-1',
      name: 'AskUserQuestion',
      input: expect.objectContaining({ questions: expect.any(Array) }),
    });
  });
});
