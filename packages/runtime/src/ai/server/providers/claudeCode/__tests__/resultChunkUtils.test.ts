import { describe, it, expect } from 'vitest';
import { detectResultChunkErrorFlags, extractResultChunkErrorMessage } from '../resultChunkUtils';

describe('detectResultChunkErrorFlags', () => {
  describe('isModelUnavailable (billing / plan rejection)', () => {
    // The motivating case: a subscription model that now needs prepaid usage
    // credits (e.g. Fable 5 after its plan-inclusion window) must classify as a
    // billing/plan rejection, not an auth error, so the UI shows a useful hint
    // instead of a raw API string or a "re-login" prompt.
    const billingMessages = [
      'Your credit balance is too low to access the Anthropic API.',
      'This request requires prepaid usage credits.',
      'API Error: 402 Payment Required',
      'The model claude-fable-5 is not available on your plan.',
      'claude-fable-5 is not available on your subscription.',
      'Your organization does not have access to model claude-fable-5.',
      'model not found: claude-fable-5',
    ];

    it.each(billingMessages)('flags %j as model-unavailable', (msg) => {
      expect(detectResultChunkErrorFlags(msg).isModelUnavailable).toBe(true);
    });

    it('does not misclassify billing messages as auth errors', () => {
      for (const msg of billingMessages) {
        expect(detectResultChunkErrorFlags(msg).isAuthError).toBe(false);
      }
    });

    it('does not flag unrelated errors as model-unavailable', () => {
      const unrelated = [
        'Invalid API key. Please run /login.',
        'Internal server error',
        'rate limit exceeded',
        'No conversation found for this session.',
      ];
      for (const msg of unrelated) {
        expect(detectResultChunkErrorFlags(msg).isModelUnavailable).toBe(false);
      }
    });
  });

  describe('existing classifications still hold', () => {
    it('flags auth errors', () => {
      expect(detectResultChunkErrorFlags('401 Unauthorized: invalid API key').isAuthError).toBe(true);
    });

    it('flags expired sessions', () => {
      expect(detectResultChunkErrorFlags('No conversation found').isExpiredSessionError).toBe(true);
    });

    it('flags server errors', () => {
      expect(detectResultChunkErrorFlags('Internal server error (500)').isServerError).toBe(true);
    });
  });
});

describe('extractResultChunkErrorMessage', () => {
  it('unwraps the nested API error message', () => {
    const chunk = {
      result: 'API Error: 402 {"error":{"message":"Your credit balance is too low to access the Anthropic API."}}',
    };
    const msg = extractResultChunkErrorMessage(chunk);
    expect(msg).toBe('Your credit balance is too low to access the Anthropic API.');
    // And the unwrapped message must still classify as a billing rejection.
    expect(detectResultChunkErrorFlags(msg).isModelUnavailable).toBe(true);
  });
});
