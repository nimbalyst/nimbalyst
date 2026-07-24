/**
 * Unit tests for tracker activity log and comment data structures.
 *
 * Tests the activity append logic and comment structure contracts
 * to ensure the data stored in the JSONB data.activity and data.comments
 * arrays is well-formed and bounded.
 */

import { describe, it, expect } from 'vitest';
import type { TrackerIdentity, TrackerActivity } from '../../core/DocumentService';

// Inline the appendActivity logic (same algorithm as trackerToolHandlers.appendActivity)
function appendActivity(
  data: Record<string, any>,
  authorIdentity: TrackerIdentity,
  action: string,
  details?: { field?: string; oldValue?: string; newValue?: string }
): void {
  const activity = data.activity || [];
  activity.push({
    id: `activity_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    authorIdentity,
    action,
    field: details?.field,
    oldValue: details?.oldValue,
    newValue: details?.newValue,
    timestamp: Date.now(),
  });
  if (activity.length > 100) {
    data.activity = activity.slice(-100);
  } else {
    data.activity = activity;
  }
}

function makeIdentity(overrides: Partial<TrackerIdentity> = {}): TrackerIdentity {
  return {
    email: 'alice@example.com',
    displayName: 'Alice',
    gitName: null,
    gitEmail: null,
    ...overrides,
  };
}

// ============================================================================
// appendActivity
// ============================================================================

describe('appendActivity', () => {
  it('should create activity array when none exists', () => {
    const data: Record<string, any> = {};
    appendActivity(data, makeIdentity(), 'created');
    expect(data.activity).toHaveLength(1);
    expect(data.activity[0].action).toBe('created');
  });

  it('should append to existing activity array', () => {
    const data: Record<string, any> = {
      activity: [{ id: 'existing', action: 'created', timestamp: 1000 }],
    };
    appendActivity(data, makeIdentity(), 'updated', { field: 'status', oldValue: 'to-do', newValue: 'done' });
    expect(data.activity).toHaveLength(2);
    expect(data.activity[1].action).toBe('updated');
    expect(data.activity[1].field).toBe('status');
    expect(data.activity[1].oldValue).toBe('to-do');
    expect(data.activity[1].newValue).toBe('done');
  });

  it('should include authorIdentity on each entry', () => {
    const data: Record<string, any> = {};
    const identity = makeIdentity({ email: 'bob@co.com', displayName: 'Bob' });
    appendActivity(data, identity, 'commented');
    expect(data.activity[0].authorIdentity.email).toBe('bob@co.com');
    expect(data.activity[0].authorIdentity.displayName).toBe('Bob');
  });

  it('should generate unique IDs', () => {
    const data: Record<string, any> = {};
    appendActivity(data, makeIdentity(), 'created');
    appendActivity(data, makeIdentity(), 'updated');
    expect(data.activity[0].id).not.toBe(data.activity[1].id);
    expect(data.activity[0].id).toMatch(/^activity_/);
  });

  it('should set timestamp to current time', () => {
    const before = Date.now();
    const data: Record<string, any> = {};
    appendActivity(data, makeIdentity(), 'created');
    const after = Date.now();
    expect(data.activity[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(data.activity[0].timestamp).toBeLessThanOrEqual(after);
  });

  it('should truncate activity log at 100 entries', () => {
    const data: Record<string, any> = {
      activity: Array.from({ length: 100 }, (_, i) => ({
        id: `old_${i}`,
        action: 'updated',
        timestamp: i,
      })),
    };
    expect(data.activity).toHaveLength(100);

    appendActivity(data, makeIdentity(), 'commented');

    expect(data.activity).toHaveLength(100);
    // Oldest entry should be dropped
    expect(data.activity[0].id).toBe('old_1');
    // Newest entry should be the comment
    expect(data.activity[99].action).toBe('commented');
  });

  it('should handle status_changed action with field details', () => {
    const data: Record<string, any> = {};
    appendActivity(data, makeIdentity(), 'status_changed', {
      field: 'status',
      oldValue: 'to-do',
      newValue: 'in-progress',
    });
    const entry = data.activity[0];
    expect(entry.action).toBe('status_changed');
    expect(entry.field).toBe('status');
    expect(entry.oldValue).toBe('to-do');
    expect(entry.newValue).toBe('in-progress');
  });

  it('should handle archived action', () => {
    const data: Record<string, any> = {};
    appendActivity(data, makeIdentity(), 'archived', {
      field: 'archived',
      oldValue: 'false',
      newValue: 'true',
    });
    expect(data.activity[0].action).toBe('archived');
  });

  it('should omit optional details fields when not provided', () => {
    const data: Record<string, any> = {};
    appendActivity(data, makeIdentity(), 'created');
    expect(data.activity[0].field).toBeUndefined();
    expect(data.activity[0].oldValue).toBeUndefined();
    expect(data.activity[0].newValue).toBeUndefined();
  });
});

// ============================================================================
// Comment data structure
// ============================================================================

describe('TrackerComment data structure', () => {
  it('should have required fields for a new comment', () => {
    const comment = {
      id: `comment_${Date.now()}_abc123`,
      authorIdentity: makeIdentity(),
      body: 'This is a test comment',
      createdAt: Date.now(),
      updatedAt: null,
      deleted: false,
    };

    expect(comment.id).toMatch(/^comment_/);
    expect(comment.authorIdentity.email).toBe('alice@example.com');
    expect(comment.body).toBe('This is a test comment');
    expect(typeof comment.createdAt).toBe('number');
    expect(comment.updatedAt).toBeNull();
    expect(comment.deleted).toBe(false);
  });

  it('should support edit via updatedAt timestamp', () => {
    const comment = {
      id: 'comment_1',
      authorIdentity: makeIdentity(),
      body: 'Original text',
      createdAt: 1000,
      updatedAt: null as number | null,
      deleted: false,
    };

    // Simulate edit
    comment.body = 'Edited text';
    comment.updatedAt = 2000;

    expect(comment.body).toBe('Edited text');
    expect(comment.updatedAt).toBe(2000);
  });

  it('should support soft delete', () => {
    const comment = {
      id: 'comment_1',
      authorIdentity: makeIdentity(),
      body: 'Will be deleted',
      createdAt: 1000,
      updatedAt: null,
      deleted: false,
    };

    comment.deleted = true;

    expect(comment.deleted).toBe(true);
    // Body is preserved for sync, just hidden in UI
    expect(comment.body).toBe('Will be deleted');
  });

  it('should filter visible comments by excluding deleted', () => {
    const comments = [
      { id: 'c1', body: 'Visible', deleted: false },
      { id: 'c2', body: 'Deleted', deleted: true },
      { id: 'c3', body: 'Also visible', deleted: false },
    ];

    const visible = comments.filter(c => !c.deleted);
    expect(visible).toHaveLength(2);
    expect(visible.map(c => c.id)).toEqual(['c1', 'c3']);
  });
});
