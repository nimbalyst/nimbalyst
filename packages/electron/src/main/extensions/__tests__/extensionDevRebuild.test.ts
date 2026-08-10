// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { rebuildExtensionForDev } from '../extensionDevRebuild';

describe('rebuildExtensionForDev', () => {
  it('builds successfully before broadcasting the reload', async () => {
    const order: string[] = [];
    const runBuild = vi.fn(async () => {
      order.push('build');
      return { success: true, stdout: 'built', stderr: '' };
    });
    const broadcastReload = vi.fn(async () => {
      order.push('reload');
    });

    const result = await rebuildExtensionForDev(
      { extensionId: 'com.nimbalyst.test', extensionPath: '/tmp/test-extension' },
      { runBuild, broadcastReload },
    );

    expect(result).toEqual({ success: true });
    expect(order).toEqual(['build', 'reload']);
  });

  it('returns the build failure and does not broadcast stale output', async () => {
    const broadcastReload = vi.fn();

    const result = await rebuildExtensionForDev(
      { extensionId: 'com.nimbalyst.test', extensionPath: '/tmp/test-extension' },
      {
        runBuild: vi.fn().mockResolvedValue({
          success: false,
          stdout: 'vite started',
          stderr: 'TypeScript compilation failed',
        }),
        broadcastReload,
      },
    );

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('TypeScript compilation failed'),
    });
    expect(broadcastReload).not.toHaveBeenCalled();
  });
});
