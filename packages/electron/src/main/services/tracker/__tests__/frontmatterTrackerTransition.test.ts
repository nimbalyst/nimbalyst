import { describe, expect, it } from 'vitest';

import { computeFrontmatterTrackerTransition } from '../frontmatterTrackerTransition';

const NOW = 1_700_000_000_000;

describe('computeFrontmatterTrackerTransition', () => {
  it('records a status_changed transition when the frontmatter status changes', () => {
    const existing = {
      title: 'Team System Master Plan',
      status: 'in-design',
      priority: 'high',
      activity: [],
    };

    const result = computeFrontmatterTrackerTransition(
      existing,
      { title: 'Team System Master Plan', status: 'in-development', priority: 'high' },
      null,
      NOW,
    );

    expect(result.isNew).toBe(false);
    expect(result.changes).toEqual([{ field: 'status', from: 'in-design', to: 'in-development' }]);
    expect(result.data.status).toBe('in-development');
    expect(result.data.activity).toHaveLength(1);
    expect(result.data.activity[0]).toMatchObject({
      action: 'status_changed',
      field: 'status',
      oldValue: 'in-design',
      newValue: 'in-development',
      timestamp: NOW,
    });
  });

  it('emits no transition when no tracked field changed', () => {
    const existing = { title: 'A', status: 'draft', priority: 'high', activity: [] };
    const result = computeFrontmatterTrackerTransition(
      existing,
      { title: 'A', status: 'draft', priority: 'high' },
      null,
      NOW,
    );
    expect(result.changes).toEqual([]);
    expect(result.data.activity).toHaveLength(0);
  });

  it('anchors the timeline with a single created entry on first projection', () => {
    const result = computeFrontmatterTrackerTransition(
      null,
      { title: 'New Plan', status: 'draft', priority: 'medium' },
      null,
      NOW,
    );
    expect(result.isNew).toBe(true);
    expect(result.changes).toEqual([]);
    expect(result.data.activity).toHaveLength(1);
    expect(result.data.activity[0]).toMatchObject({ action: 'created', newValue: 'draft' });
  });

  it('preserves existing system metadata while applying field updates', () => {
    const existing = {
      title: 'A',
      status: 'draft',
      authorIdentity: { email: 'greg@stravu.com' },
      comments: [{ id: 'c1' }],
      linkedSessions: ['s1'],
      activity: [{ id: 'old', action: 'created', timestamp: 1 }],
    };
    const result = computeFrontmatterTrackerTransition(
      existing,
      { title: 'A', status: 'in-development' },
      null,
      NOW,
    );
    expect(result.data.authorIdentity).toEqual({ email: 'greg@stravu.com' });
    expect(result.data.comments).toEqual([{ id: 'c1' }]);
    expect(result.data.linkedSessions).toEqual(['s1']);
    // Existing activity retained, new transition appended.
    expect(result.data.activity).toHaveLength(2);
    expect(result.data.activity[0].id).toBe('old');
    expect(result.data.activity[1].action).toBe('status_changed');
  });

  it('records non-status field changes as updated', () => {
    const existing = { title: 'A', status: 'draft', priority: 'low', progress: 0, activity: [] };
    const result = computeFrontmatterTrackerTransition(
      existing,
      { title: 'A', status: 'draft', priority: 'high', progress: 50 },
      null,
      NOW,
    );
    expect(result.changes).toEqual([
      { field: 'priority', from: 'low', to: 'high' },
      { field: 'progress', from: 0, to: 50 },
    ]);
    expect(result.data.activity.every((a: { action: string }) => a.action === 'updated')).toBe(true);
  });

  it('treats an absent frontmatter field as no-change, not a clear', () => {
    const existing = { title: 'A', status: 'draft', owner: 'greg', activity: [] };
    const result = computeFrontmatterTrackerTransition(
      existing,
      { title: 'A', status: 'draft' }, // owner omitted
      null,
      NOW,
    );
    expect(result.changes).toEqual([]);
    expect(result.data.owner).toBe('greg');
  });

  it('bounds the activity log to the last 100 entries', () => {
    const activity = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, action: 'updated', timestamp: i }));
    const existing = { title: 'A', status: 'draft', activity };
    const result = computeFrontmatterTrackerTransition(
      existing,
      { title: 'A', status: 'shipped' },
      null,
      NOW,
    );
    expect(result.data.activity).toHaveLength(100);
    // Oldest dropped, newest transition retained.
    expect(result.data.activity[0].id).toBe('a1');
    expect(result.data.activity[99].action).toBe('status_changed');
  });
});
