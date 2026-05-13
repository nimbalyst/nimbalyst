import { describe, expect, it } from 'vitest';
import { buildFeedbackInitialDraft } from '../FeedbackIntakeDialog';

describe('buildFeedbackInitialDraft', () => {
  it('includes bug log consent when drafting a bug report', () => {
    expect(buildFeedbackInitialDraft('bug', { mayGatherLogs: true })).toBe(
      '/feedback:bug-report\n\nLog gathering: allowed',
    );
    expect(buildFeedbackInitialDraft('bug', { mayGatherLogs: false })).toBe(
      '/feedback:bug-report\n\nLog gathering: not allowed',
    );
  });

  it('includes feature mockup intent without leaking bug log consent', () => {
    expect(buildFeedbackInitialDraft('feature', { shouldCreateMockup: true })).toBe(
      '/feedback:feature-request\n\nUX mockup: requested',
    );
    expect(buildFeedbackInitialDraft('feature', { shouldCreateMockup: false })).toBe(
      '/feedback:feature-request\n\nUX mockup: not requested',
    );
  });
});
