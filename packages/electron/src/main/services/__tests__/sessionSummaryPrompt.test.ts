import { describe, expect, it } from 'vitest';

import {
  appendPendingPromptSection,
  collectPendingPromptDescriptionsFromRawRows,
  collectPendingPromptDescriptionsFromTranscript,
} from '../sessionSummaryPrompt';

describe('session summary pending prompts', () => {
  it('appends an unresolved question at the very end of a summary', () => {
    const summary = appendPendingPromptSection(
      'Session recap\n\nMost recent agent message:\nI need a choice.',
      ['Question: Which database should we use? (options: SQLite, Postgres)'],
    );

    expect(summary).toBe(
      'Session recap\n\nMost recent agent message:\nI need a choice.\n\n'
      + 'This session is waiting for your input:\n'
      + '- Question: Which database should we use? (options: SQLite, Postgres)',
    );
    expect(summary.endsWith('Question: Which database should we use? (options: SQLite, Postgres)'))
      .toBe(true);
  });

  it('leaves summaries without pending questions unchanged', () => {
    const summary = 'Session recap\n\nMost recent agent message:\nAll done.';

    expect(appendPendingPromptSection(summary, [])).toBe(summary);
  });

  it('finds the latest unresolved question in raw session messages', () => {
    const descriptions = collectPendingPromptDescriptionsFromRawRows([
      {
        content: JSON.stringify({
          type: 'nimbalyst_tool_use',
          id: 'answered-question',
          name: 'AskUserQuestion',
          input: { questions: [{ question: 'Old question?' }] },
        }),
      },
      {
        content: JSON.stringify({
          type: 'ask_user_question_response',
          questionId: 'answered-question',
          answers: { 'Old question?': 'Done' },
        }),
      },
      {
        content: JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'pending-question',
                name: 'mcp__nimbalyst__AskUserQuestion',
                input: {
                  questions: [
                    {
                      question: 'Which database should we use?',
                      options: [{ label: 'SQLite' }, { label: 'Postgres' }],
                    },
                  ],
                },
              },
            ],
          },
        }),
      },
    ]);

    expect(descriptions).toEqual([
      'Question: Which database should we use? (options: SQLite, Postgres)',
    ]);
  });

  it('surfaces pending structured-input fields from transcript tool calls', () => {
    const descriptions = collectPendingPromptDescriptionsFromTranscript([
      {
        type: 'tool_call',
        toolCall: {
          toolName: 'mcp__nimbalyst__PromptForUserInput',
          status: 'running',
          result: null,
          arguments: {
            title: 'Choose release settings',
            fields: [
              { type: 'singleSelect', id: 'channel', label: 'Release channel' },
              { type: 'confirm', id: 'publish', label: 'Publish immediately?' },
            ],
          },
        },
      },
      {
        type: 'interactive_prompt',
        interactivePrompt: {
          promptType: 'permission_request',
          status: 'resolved',
          toolName: 'Bash',
          rawCommand: 'npm test',
        },
      },
    ]);

    expect(descriptions).toEqual([
      'Question: Choose release settings (Release channel; Publish immediately?)',
    ]);
  });
});
