// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { useArchiveWorktreeDialog } from '../useArchiveWorktreeDialog';

vi.mock('../../services/ErrorNotificationService', () => ({
  errorNotificationService: {
    showInfo: vi.fn(() => 'notice-1'),
    showError: vi.fn(),
    dismiss: vi.fn(),
  },
}));

describe('useArchiveWorktreeDialog showDialog', () => {
  const worktreeGetStatus = vi.fn();
  const worktreeArchive = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(errorNotificationService.showInfo).mockClear();
    vi.mocked(errorNotificationService.dismiss).mockClear();
    worktreeGetStatus.mockReset();
    worktreeArchive.mockReset();
    worktreeArchive.mockResolvedValue({ success: true });
    (window as any).electronAPI = { worktreeGetStatus, worktreeArchive };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as any).electronAPI;
  });

  it('shows the "Checking for unsaved work" notice while the status check is slow, and removes it when the check ends', async () => {
    // The status call stays open until the test lets it finish.
    let finishStatus!: (value: unknown) => void;
    worktreeGetStatus.mockReturnValue(new Promise((resolve) => { finishStatus = resolve; }));

    const { result } = renderHook(() => useArchiveWorktreeDialog());

    let archived: Promise<boolean>;
    act(() => {
      archived = result.current.showDialog({
        worktreeId: 'wt-1',
        worktreeName: 'my-worktree',
        worktreePath: '/tmp/my-worktree',
        workspacePath: '/tmp/workspace',
      });
    });

    // Just under one second: the check is still running, but no notice yet.
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(errorNotificationService.showInfo).not.toHaveBeenCalled();

    // One second reached: the notice appears and the check is still running.
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(errorNotificationService.showInfo).toHaveBeenCalledTimes(1);
    expect(errorNotificationService.showInfo).toHaveBeenCalledWith(
      'Checking for unsaved work',
      expect.stringContaining('my-worktree'),
      expect.anything(),
    );
    expect(errorNotificationService.dismiss).not.toHaveBeenCalled();

    // The status call ends (clean and merged, so the worktree archives itself).
    await act(async () => {
      finishStatus({
        success: true,
        status: { hasUncommittedChanges: false, modifiedFileCount: 0, isMerged: true },
      });
      await archived;
    });

    expect(worktreeGetStatus).toHaveBeenCalledWith('/tmp/my-worktree', { fetchFirst: true });
    expect(errorNotificationService.dismiss).toHaveBeenCalledTimes(1);
    expect(errorNotificationService.dismiss).toHaveBeenCalledWith('notice-1');
  });
});
