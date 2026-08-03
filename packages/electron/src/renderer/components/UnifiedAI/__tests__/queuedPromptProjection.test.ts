import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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

  it('keeps reconciliation-blocked controls inert without corrupting durable projection truth', () => {
    const projection = projectQueuedPrompts('source-a', [], [{
      id: 'durable',
      clientSubmissionId: 'submission-a',
      sourceSessionId: 'source-a',
      submissionSequence: 1,
      prompt: 'preserved',
      timestamp: 1,
      status: 'pending',
    }]);

    const transcriptSource = readFileSync(
      new URL('../SessionTranscript.tsx', import.meta.url),
      'utf8',
    );
    expect(transcriptSource).toContain('isQueueMutationBlockedByModelReconciliation(modelReconciliationBlocked)');
    expect(transcriptSource).toContain('onModelChange={modelReconciliationBlocked ? undefined : handleModelChange}');
    expect(transcriptSource).toContain('disabled={modelReconciliationBlocked}');
    expect(projection).toMatchObject([{ id: 'durable', prompt: 'preserved', status: 'pending' }]);
  });
});
