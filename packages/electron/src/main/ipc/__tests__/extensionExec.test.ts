// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExec = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ exec: mockExec, default: { exec: mockExec } }));

import { runExtensionCommand } from '../extensionExec';

describe('runExtensionCommand', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it('hides the console window on Windows (#1839)', async () => {
    // Project Graph indexes through this with `git rev-parse` / `rev-list` / `log`.
    mockExec.mockImplementation((_cmd, _opts, callback) => callback(null, 'abc\n', ''));
    const result = await runExtensionCommand({ command: 'git rev-parse HEAD', cwd: '/repo', timeout: 1000, maxBuffer: 1024 });
    expect(mockExec.mock.calls[0][1]).toMatchObject({ windowsHide: true, cwd: '/repo' });
    expect(result).toEqual({ success: true, stdout: 'abc\n', stderr: '', exitCode: 0 });
  });

  it('reports the exit code and stderr of a failed command', async () => {
    mockExec.mockImplementation((_cmd, _opts, callback) =>
      callback(Object.assign(new Error('boom'), { code: 128 }), '', 'fatal: not a git repository'));
    const result = await runExtensionCommand({ command: 'git log', cwd: '/x', timeout: 1000, maxBuffer: 1024 });
    expect(result).toEqual({ success: false, stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 });
  });
});
