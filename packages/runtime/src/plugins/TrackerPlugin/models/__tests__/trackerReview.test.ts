import { describe, it, expect, beforeAll } from 'vitest';
import { loadBuiltinTrackers } from '../ModelLoader';
import {
  hasReviewLane,
  humanOnlyStatusMessage,
  isHumanOnlyStatus,
  isReviewLaneStatus,
  reviewLaneFor,
  REVIEW_APPROVED,
  REVIEW_CHANGES_REQUESTED,
  REVIEW_IN_REVIEW,
} from '../trackerReview';

beforeAll(() => {
  loadBuiltinTrackers();
});

describe('trackerReview', () => {
  it('reserves approval for people', () => {
    expect(isHumanOnlyStatus(REVIEW_APPROVED)).toBe(true);
    // Everything an agent legitimately does stays allowed.
    expect(isHumanOnlyStatus(REVIEW_IN_REVIEW)).toBe(false);
    expect(isHumanOnlyStatus(REVIEW_CHANGES_REQUESTED)).toBe(false);
    expect(isHumanOnlyStatus('done')).toBe(false);
    expect(isHumanOnlyStatus(undefined)).toBe(false);
  });

  it('matches approval case- and whitespace-insensitively', () => {
    expect(isHumanOnlyStatus(' Approved ')).toBe(true);
  });

  it('tells the agent what to do instead of only refusing', () => {
    expect(humanOnlyStatusMessage(REVIEW_APPROVED)).toContain(REVIEW_IN_REVIEW);
  });

  it('exposes the lane the built-in work types offer, in lane order', () => {
    expect(reviewLaneFor('bug')).toEqual([REVIEW_IN_REVIEW, REVIEW_CHANGES_REQUESTED, REVIEW_APPROVED]);
    expect(reviewLaneFor('task')).toEqual([REVIEW_IN_REVIEW, REVIEW_CHANGES_REQUESTED, REVIEW_APPROVED]);
    expect(reviewLaneFor('plan')).toEqual([REVIEW_IN_REVIEW, REVIEW_CHANGES_REQUESTED, REVIEW_APPROVED]);
  });

  it('reports no lane for types that never go to review', () => {
    expect(hasReviewLane('idea')).toBe(false);
    expect(reviewLaneFor('milestone')).toEqual([]);
    expect(reviewLaneFor('not-a-registered-type')).toEqual([]);
  });

  it('identifies lane statuses', () => {
    expect(isReviewLaneStatus(REVIEW_CHANGES_REQUESTED)).toBe(true);
    expect(isReviewLaneStatus('in-progress')).toBe(false);
  });
});
