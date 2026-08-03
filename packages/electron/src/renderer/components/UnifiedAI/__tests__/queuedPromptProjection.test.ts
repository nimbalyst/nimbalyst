import { describe, expect, it } from 'vitest';
import { projectQueuedPrompts } from '../queuedPromptProjection';

describe('queued prompt projection', () => {
  it('dedupes retries by stable submission identity and clears a stale local failure', () => {
    const result = projectQueuedPrompts('source-a', [
      { id: 'optimistic', clientSubmissionId: 'submission-a', sourceSessionId: 'source-a', prompt: 'same', timestamp: 2, status: 'failed', errorMessage: 'not sent' },
    ], [
      { id: 'durable', clientSubmissionId: 'submission-a', sourceSessionId: 'source-a', submissionSequence: 1, prompt: 'same', timestamp: 1, status: 'completed' },
      { id: 'other', clientSubmissionId: 'submission-b', sourceSessionId: 'source-b', prompt: 'other', timestamp: 1, status: 'pending' },
    ]);
    expect(result).toEqual([]);
  });
});
