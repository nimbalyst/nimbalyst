import { describe, expect, it } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';

import {
  buildTrackerLaunchContext,
  deriveTrackerWorktreeName,
} from '../trackerSessionLaunch';

function makeTrackerRecord(overrides: Partial<TrackerRecord> = {}): TrackerRecord {
  return {
    id: 'feature_1624',
    primaryType: 'feature',
    typeTags: ['feature'],
    issueKey: 'NIM-1624',
    source: 'native',
    archived: false,
    syncStatus: 'local',
    fields: {
      title: 'Launch a Worktree from a Tracker',
      status: 'in-progress',
      priority: 'high',
      description: 'Create an isolated session with the tracker context pre-filled.',
    },
    system: {
      workspace: '/repo',
      createdAt: '2026-07-16T12:00:00.000Z',
      updatedAt: '2026-07-16T12:00:00.000Z',
    },
    ...overrides,
  };
}

describe('buildTrackerLaunchContext', () => {
  it('builds the native tracker link, shared draft, and worktree name', () => {
    const context = buildTrackerLaunchContext('feature_1624', makeTrackerRecord());

    expect(context).toEqual({
      trackerLinkId: 'feature_1624',
      draftInput: [
        'implement tracker item NIM-1624: Launch a Worktree from a Tracker',
        'type: feature, status: in-progress, priority: high',
        '',
        'Create an isolated session with the tracker context pre-filled.',
        '',
        'Update this tracker item\'s status when done using tracker_update with id "NIM-1624".',
      ].join('\n'),
      worktreeName: 'nim-1624-launch-a-worktree-from-a-tracker',
    });
  });

  it('uses the file tracker link and includes the document source', () => {
    const trackerItem = makeTrackerRecord({
      id: 'plan-branching',
      issueKey: undefined,
      primaryType: 'plan',
      typeTags: ['plan'],
      source: 'frontmatter',
      fields: {
        title: 'Branching Plan',
        status: 'to-do',
      },
      system: {
        workspace: '/repo',
        documentPath: 'nimbalyst-local/plans/branching.md',
        createdAt: '2026-07-16T12:00:00.000Z',
        updatedAt: '2026-07-16T12:00:00.000Z',
      },
    });

    const context = buildTrackerLaunchContext('plan-branching', trackerItem);

    expect(context.trackerLinkId).toBe('file:nimbalyst-local/plans/branching.md');
    expect(context.draftInput).toContain('implement tracker item plan-branching: Branching Plan');
    expect(context.draftInput).toContain('Source: @nimbalyst-local/plans/branching.md');
    expect(context.worktreeName).toBe('plan-branching-branching-plan');
  });
});

describe('deriveTrackerWorktreeName', () => {
  it('produces a bounded branch-safe slug', () => {
    const name = deriveTrackerWorktreeName(
      'NIM-1624',
      'Launch worktree: preserve SAME tracker context?! with a deliberately long title',
    );

    expect(name).toMatch(/^nim-1624-[a-z0-9-]+$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).not.toMatch(/-$/);
  });
});
