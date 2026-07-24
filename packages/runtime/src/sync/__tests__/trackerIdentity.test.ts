/**
 * Unit tests for tracker identity matching logic.
 *
 * Tests the isMyItem() matching algorithm which determines whether
 * a tracker item belongs to the current user via a priority chain:
 * email > assignee email > git email > git name > legacy owner.
 *
 * isMyItem() lives in the electron package (TrackerIdentityService),
 * but since it's pure logic operating on runtime types, we test the
 * algorithm here for fast feedback.
 */

import { describe, it, expect } from 'vitest';
import type { TrackerIdentity, TrackerItem } from '../../core/DocumentService';

// Inline the pure matching logic (same algorithm as TrackerIdentityService.isMyItem)
// to test without electron dependencies
function isMyItem(item: TrackerItem, currentIdentity: TrackerIdentity): boolean {
  if (currentIdentity.email && item.authorIdentity?.email) {
    if (currentIdentity.email === item.authorIdentity.email) return true;
  }
  if (currentIdentity.email && item.assigneeEmail) {
    if (currentIdentity.email === item.assigneeEmail) return true;
  }
  if (currentIdentity.gitEmail && item.authorIdentity?.gitEmail) {
    if (currentIdentity.gitEmail === item.authorIdentity.gitEmail) return true;
  }
  if (currentIdentity.gitName && item.authorIdentity?.gitName) {
    if (currentIdentity.gitName === item.authorIdentity.gitName) return true;
  }
  if (currentIdentity.displayName && item.owner) {
    if (currentIdentity.displayName === item.owner) return true;
  }
  return false;
}

// ============================================================================
// Test Helpers
// ============================================================================

function makeIdentity(overrides: Partial<TrackerIdentity> = {}): TrackerIdentity {
  return {
    email: null,
    displayName: 'Test User',
    gitName: null,
    gitEmail: null,
    ...overrides,
  };
}

function makeItem(overrides: Partial<TrackerItem> = {}): TrackerItem {
  return {
    id: 'test-item',
    type: 'task',
    title: 'Test item',
    status: 'to-do',
    module: '',
    workspace: '/test',
    lastIndexed: new Date(),
    ...overrides,
  };
}

// ============================================================================
// isMyItem - Email Matching
// ============================================================================

describe('isMyItem', () => {
  describe('email matching (highest priority)', () => {
    it('should match when author email equals current user email', () => {
      const identity = makeIdentity({ email: 'alice@example.com' });
      const item = makeItem({
        authorIdentity: { email: 'alice@example.com', displayName: 'Alice', gitName: null, gitEmail: null },
      });
      expect(isMyItem(item, identity)).toBe(true);
    });

    it('should not match when author email differs', () => {
      const identity = makeIdentity({ email: 'alice@example.com' });
      const item = makeItem({
        authorIdentity: { email: 'bob@example.com', displayName: 'Bob', gitName: null, gitEmail: null },
      });
      expect(isMyItem(item, identity)).toBe(false);
    });

    it('should not match when current user has no email', () => {
      const identity = makeIdentity({ email: null });
      const item = makeItem({
        authorIdentity: { email: 'alice@example.com', displayName: 'Alice', gitName: null, gitEmail: null },
      });
      expect(isMyItem(item, identity)).toBe(false);
    });
  });

  describe('assignee email matching', () => {
    it('should match when assignee email equals current user email', () => {
      const identity = makeIdentity({ email: 'alice@example.com' });
      const item = makeItem({ assigneeEmail: 'alice@example.com' });
      expect(isMyItem(item, identity)).toBe(true);
    });

    it('should not match when assignee email differs', () => {
      const identity = makeIdentity({ email: 'alice@example.com' });
      const item = makeItem({ assigneeEmail: 'bob@example.com' });
      expect(isMyItem(item, identity)).toBe(false);
    });

    it('should match assignee even if author is different', () => {
      const identity = makeIdentity({ email: 'alice@example.com' });
      const item = makeItem({
        authorIdentity: { email: 'bob@example.com', displayName: 'Bob', gitName: null, gitEmail: null },
        assigneeEmail: 'alice@example.com',
      });
      expect(isMyItem(item, identity)).toBe(true);
    });
  });

  describe('git email fallback', () => {
    it('should match on git email when no primary email', () => {
      const identity = makeIdentity({ email: null, gitEmail: 'alice@dev.local' });
      const item = makeItem({
        authorIdentity: { email: null, displayName: 'Alice', gitName: null, gitEmail: 'alice@dev.local' },
      });
      expect(isMyItem(item, identity)).toBe(true);
    });

    it('should not match when git emails differ', () => {
      const identity = makeIdentity({ email: null, gitEmail: 'alice@dev.local' });
      const item = makeItem({
        authorIdentity: { email: null, displayName: 'Bob', gitName: null, gitEmail: 'bob@dev.local' },
      });
      expect(isMyItem(item, identity)).toBe(false);
    });
  });

  describe('git name fallback', () => {
    it('should match on git name when no emails available', () => {
      const identity = makeIdentity({ email: null, gitName: 'Alice Smith' });
      const item = makeItem({
        authorIdentity: { email: null, displayName: 'Alice', gitName: 'Alice Smith', gitEmail: null },
      });
      expect(isMyItem(item, identity)).toBe(true);
    });

    it('should not match when git names differ', () => {
      const identity = makeIdentity({ email: null, gitName: 'Alice Smith' });
      const item = makeItem({
        authorIdentity: { email: null, displayName: 'Bob', gitName: 'Bob Jones', gitEmail: null },
      });
      expect(isMyItem(item, identity)).toBe(false);
    });
  });

  describe('legacy owner fallback', () => {
    it('should match on legacy owner field', () => {
      const identity = makeIdentity({ displayName: 'ghinkle' });
      const item = makeItem({ owner: 'ghinkle' });
      expect(isMyItem(item, identity)).toBe(true);
    });

    it('should not match when owner differs', () => {
      const identity = makeIdentity({ displayName: 'ghinkle' });
      const item = makeItem({ owner: 'someone-else' });
      expect(isMyItem(item, identity)).toBe(false);
    });
  });

  describe('priority chain', () => {
    it('email match takes priority over git email', () => {
      const identity = makeIdentity({ email: 'alice@example.com', gitEmail: 'wrong@dev.local' });
      const item = makeItem({
        authorIdentity: { email: 'alice@example.com', displayName: 'Alice', gitName: null, gitEmail: 'different@dev.local' },
      });
      // Should match on email, not care about git email mismatch
      expect(isMyItem(item, identity)).toBe(true);
    });

    it('returns false when nothing matches', () => {
      const identity = makeIdentity({
        email: 'alice@example.com',
        gitEmail: 'alice@dev.local',
        gitName: 'Alice',
        displayName: 'Alice',
      });
      const item = makeItem({
        authorIdentity: { email: 'bob@example.com', displayName: 'Bob', gitName: 'Bob', gitEmail: 'bob@dev.local' },
        owner: 'Bob',
      });
      expect(isMyItem(item, identity)).toBe(false);
    });

    it('items with no identity info return false', () => {
      const identity = makeIdentity({ email: 'alice@example.com' });
      const item = makeItem(); // no authorIdentity, no owner, no assignee
      expect(isMyItem(item, identity)).toBe(false);
    });
  });
});
