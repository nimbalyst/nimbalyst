// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { saveSessionArchived } from '../saveSessionArchived';

vi.mock('../../services/ErrorNotificationService', () => ({
  errorNotificationService: { showError: vi.fn() },
}));

describe('saveSessionArchived', () => {
  beforeEach(() => {
    vi.mocked(errorNotificationService.showError).mockClear();
  });

  it('returns true and stays quiet when the backend saves the change', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true });
    vi.stubGlobal('window', { electronAPI: { invoke } });

    expect(await saveSessionArchived('s1', true)).toBe(true);
    expect(invoke).toHaveBeenCalledWith('sessions:update-metadata', 's1', { isArchived: true });
    expect(errorNotificationService.showError).not.toHaveBeenCalled();
  });

  it('shows the backend error and returns false when the backend rejects the change', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: false, error: 'Session not found' });
    vi.stubGlobal('window', { electronAPI: { invoke } });

    expect(await saveSessionArchived('s1', true)).toBe(false);
    expect(errorNotificationService.showError).toHaveBeenCalledWith('Failed to archive session', 'Session not found');
  });

  it('shows an error and returns false when the call throws', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('boom'));
    vi.stubGlobal('window', { electronAPI: { invoke } });

    expect(await saveSessionArchived('s1', false)).toBe(false);
    expect(errorNotificationService.showError).toHaveBeenCalledWith('Failed to unarchive session', 'boom');
  });
});
