// @vitest-environment node
/**
 * The regression here is an absence, and absences do not show on screen:
 * `assignMissingLocalKeys` shipped with no production caller at all, so the
 * only numbering that ever ran was whatever a list query happened to touch.
 *
 * These pin the wrapper's two obligations -- run once per workspace, and let a
 * failure be retried rather than pinning it for the process. The allocation
 * rules themselves belong to `localKeyAllocator.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAssignMissingLocalKeys = vi.fn();

vi.mock('../localKeyAllocator', () => ({
  assignMissingLocalKeys: (...args: unknown[]) => mockAssignMissingLocalKeys(...args),
}));
vi.mock('../workspaceLocalKeyStore', () => ({ workspaceLocalKeyStore: { store: true } }));
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: { db: true } }));
vi.mock('../../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), error: vi.fn() } },
}));

import { globalRegistry, parseTrackerYAML } from '@nimbalyst/tracker-schema';
import {
  ensureWorkspaceLocalNumbers,
  resetLocalNumberSweepStateForTests,
} from '../ensureWorkspaceLocalNumbers';

describe('ensureWorkspaceLocalNumbers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLocalNumberSweepStateForTests();
    mockAssignMissingLocalKeys.mockResolvedValue(3);
  });

  it('numbers a workspace without consulting auth, team, or sync state', async () => {
    // The whole reason this is a sibling of `initializeTrackerSync` rather than
    // a step inside it: that function returns early for exactly the workspace
    // whose items will only ever have a local number.
    expect(await ensureWorkspaceLocalNumbers('/src/solo')).toBe(3);
    expect(mockAssignMissingLocalKeys).toHaveBeenCalledWith(
      { db: true },
      { store: true },
      '/src/solo',
      expect.any(Function),
    );
  });

  it('sweeps a workspace once per process', async () => {
    await ensureWorkspaceLocalNumbers('/src/solo');
    await ensureWorkspaceLocalNumbers('/src/solo');
    expect(mockAssignMissingLocalKeys).toHaveBeenCalledTimes(1);
  });

  it('sweeps each workspace independently', async () => {
    await ensureWorkspaceLocalNumbers('/src/one');
    await ensureWorkspaceLocalNumbers('/src/two');
    expect(mockAssignMissingLocalKeys).toHaveBeenCalledTimes(2);
  });

  it('allows a retry after a failure instead of pinning it for the process', async () => {
    // A sweep that ran before the database was up must not permanently mark the
    // workspace done -- a single-window workspace gets few later triggers.
    mockAssignMissingLocalKeys.mockRejectedValueOnce(new Error('database not ready'));
    expect(await ensureWorkspaceLocalNumbers('/src/solo')).toBe(0);

    mockAssignMissingLocalKeys.mockResolvedValue(7);
    expect(await ensureWorkspaceLocalNumbers('/src/solo')).toBe(7);
    expect(mockAssignMissingLocalKeys).toHaveBeenCalledTimes(2);
  });

  // Numbers are opt-in per type. The sweep is what would quietly re-number
  // every new item on the next window open if it stopped asking the type.
  it('numbers only types whose YAML opts in to local numbers', async () => {
    const model = (type: string, localNumbers?: boolean) => parseTrackerYAML(
      `type: ${type}\ndisplayName: X\ndisplayNamePlural: Xs\nicon: bug\ncolor: '#000'\nidPrefix: x\n`
      + `modes:\n  inline: true\n${localNumbers ? 'localNumbers: true\n' : ''}fields:\n  - name: title\n    type: string\n`,
    );
    globalRegistry.register(model('lknplain'));
    globalRegistry.register(model('lknopted', true));

    await ensureWorkspaceLocalNumbers('/src/solo');
    const isNumberedType = mockAssignMissingLocalKeys.mock.calls[0][3] as (type: string) => boolean;

    expect(isNumberedType('lknplain')).toBe(false);
    expect(isNumberedType('lknopted')).toBe(true);
    expect(isNumberedType('lknunregistered')).toBe(false);
    globalRegistry.unregister('lknplain');
    globalRegistry.unregister('lknopted');
  });

  it('ignores an empty workspace path', async () => {
    expect(await ensureWorkspaceLocalNumbers('')).toBe(0);
    expect(mockAssignMissingLocalKeys).not.toHaveBeenCalled();
  });
});
