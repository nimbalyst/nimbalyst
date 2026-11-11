import { beforeEach, expect, it, vi } from 'vitest';
const { showError, showWarning } = vi.hoisted(() => ({ showError: vi.fn(), showWarning: vi.fn() }));
vi.mock('../../../services/ErrorNotificationService', () => ({ errorNotificationService: { showError, showWarning } }));
import { requestTurnControl } from '../requestTurnControl';

beforeEach(() => { vi.clearAllMocks(); window.electronAPI = { invoke: vi.fn() } as any; });

it.each(['stop', 'send-now'] as const)('%s requires an explicit success and exposes rejected controls', async action => {
  vi.mocked(window.electronAPI.invoke).mockResolvedValueOnce({ success: false, error: 'The provider was replaced.' });
  expect(await requestTurnControl('session', action)).toBe(false);
  expect(showError).toHaveBeenCalledWith(expect.any(String), 'The provider was replaced.');
  vi.mocked(window.electronAPI.invoke).mockResolvedValueOnce({ success: true });
  expect(await requestTurnControl('session', action)).toBe(true);
  expect(showError).toHaveBeenCalledTimes(1);
});

it('retains the queued message when a commit defers send-now or IPC fails', async () => {
  vi.mocked(window.electronAPI.invoke).mockResolvedValueOnce({ success: false, deferred: 'commit-in-flight', error: 'Waiting for commit.' });
  expect(await requestTurnControl('session', 'send-now')).toBe(false);
  vi.mocked(window.electronAPI.invoke).mockRejectedValueOnce(new Error('IPC disconnected'));
  expect(await requestTurnControl('session', 'stop')).toBe(false);
  expect(showError).toHaveBeenLastCalledWith(expect.any(String), 'IPC disconnected');
});

it('shows a Stop warning while preserving its successful result', async () => {
  vi.mocked(window.electronAPI.invoke).mockResolvedValueOnce({ success: true, warning: 'A commit proposal may still be closing.' });
  expect(await requestTurnControl('session', 'stop')).toBe(true);
  expect(showWarning).toHaveBeenCalledWith('Turn stopped with a warning', 'A commit proposal may still be closing.');
  expect(showError).not.toHaveBeenCalled();
});
