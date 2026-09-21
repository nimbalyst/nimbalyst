// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { loadFileSessions } from '../fileSessionsLoader';

afterEach(() => vi.restoreAllMocks());

it('serializes updates during a running lookup and returns the trailing result to every caller', async () => {
  let finish!: (rows: unknown[]) => void;
  const invoke = vi.fn()
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue([{ id: 'latest' }]);
  window.electronAPI = { invoke } as never;
  const first = loadFileSessions('/project', '/project/a.md', 0);
  const second = loadFileSessions('/project', '/project/a.md', 1);
  const third = loadFileSessions('/project', '/project/a.md', 2);
  expect(invoke).toHaveBeenCalledTimes(1);
  finish([{ id: 'stale' }]);
  expect(await Promise.all([first, second, third])).toEqual(Array(3).fill([{ id: 'latest' }]));
  expect(invoke).toHaveBeenCalledTimes(2);

  invoke.mockRejectedValueOnce(new Error('offline'));
  await expect(loadFileSessions('/project', '/project/a.md', 3)).rejects.toThrow('offline');
  await expect(loadFileSessions('/project', '/project/a.md', 3)).resolves.toEqual([{ id: 'latest' }]);
  expect(invoke).toHaveBeenCalledTimes(4);
});
