import { describe, it, expect, vi } from 'vitest';

vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: {
    query: vi.fn(),
  },
}));

vi.mock('../TrackerSyncManager', () => ({
  syncTrackerItem: vi.fn(),
  unsyncTrackerItem: vi.fn(),
  isTrackerSyncActive: vi.fn(() => false),
}));

import {
  computeDeterministicInlineTrackerId,
  resolveInlineTrackerIds,
  type ParsedInlineTrackerCandidate,
} from '../ElectronDocumentService';

function makeCandidate(overrides: Partial<ParsedInlineTrackerCandidate> = {}): ParsedInlineTrackerCandidate {
  return {
    explicitId: false,
    type: 'bug',
    title: 'Fix parser',
    description: undefined,
    status: 'to-do',
    priority: 'high',
    owner: undefined,
    module: 'notes.md',
    lineNumber: 12,
    workspace: '/tmp/workspace',
    tags: undefined,
    created: undefined,
    updated: undefined,
    dueDate: undefined,
    archived: false,
    lastIndexed: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  };
}

describe('inline tracker identity helpers', () => {
  it('generates the same deterministic fallback id for the same candidate', () => {
    const first = computeDeterministicInlineTrackerId('notes.md', 'bug', 12, 'Fix parser');
    const second = computeDeterministicInlineTrackerId('notes.md', 'bug', 12, 'Fix parser');

    expect(first).toBe(second);
  });

  it('reuses an existing id when the line number is unchanged', () => {
    const resolved = resolveInlineTrackerIds(
      [makeCandidate({ title: 'Fix parser title changed' })],
      [{ id: 'bug_existing', type: 'bug', line_number: 12, title: 'Fix parser' }],
      'notes.md',
    );

    expect(resolved[0].id).toBe('bug_existing');
  });

  it('reuses an existing id when the item moved but the title stayed the same', () => {
    const resolved = resolveInlineTrackerIds(
      [makeCandidate({ lineNumber: 20 })],
      [{ id: 'bug_existing', type: 'bug', line_number: 12, title: 'Fix parser' }],
      'notes.md',
    );

    expect(resolved[0].id).toBe('bug_existing');
  });

  it('does not steal ids across duplicate-title items', () => {
    const resolved = resolveInlineTrackerIds(
      [makeCandidate({ lineNumber: 40 })],
      [
        { id: 'bug_old_far', type: 'bug', line_number: 10, title: 'Fix parser' },
        { id: 'bug_old_near', type: 'bug', line_number: 41, title: 'Fix parser' },
      ],
      'notes.md',
    );

    expect(resolved[0].id).toBe('bug_old_near');
  });

  it('preserves explicit ids from source content', () => {
    const resolved = resolveInlineTrackerIds(
      [makeCandidate({ id: 'bug_manual', explicitId: true })],
      [{ id: 'bug_existing', type: 'bug', line_number: 12, title: 'Fix parser' }],
      'notes.md',
    );

    expect(resolved[0].id).toBe('bug_manual');
  });
});
