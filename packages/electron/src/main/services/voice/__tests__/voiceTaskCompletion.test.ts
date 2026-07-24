import { describe, expect, it } from 'vitest';
import { buildVoiceTaskCompletion } from '../voiceTaskCompletion';

describe('buildVoiceTaskCompletion', () => {
  it('returns the coding agent summary for a successful task', () => {
    expect(buildVoiceTaskCompletion({ summary: 'Fixed the launch path.' })).toEqual({
      deferredResult: {
        success: true,
        summary: 'Fixed the launch path.',
      },
      fallbackMessage: '[INTERNAL: Task complete. Result: Fixed the launch path.]',
    });
  });

  it('reports provider failures instead of claiming the task completed', () => {
    expect(buildVoiceTaskCompletion({ error: 'Provider/model mismatch' })).toEqual({
      deferredResult: {
        success: false,
        error: 'Provider/model mismatch',
      },
      fallbackMessage: '[INTERNAL: Task failed. Error: Provider/model mismatch]',
    });
  });
});
