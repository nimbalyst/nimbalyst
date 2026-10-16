// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { findWindowByWorkspace } from '../../../window/WindowManager';
import { resolveStreamingWindow } from '../resolveStreamingWindow';

vi.mock('../../../window/WindowManager', () => ({ findWindowByWorkspace: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it.each(['live', 'closed', 'renderer-destroyed', 'missing'])('resolves a %s workspace window safely', (state) => {
  const window = state === 'missing' ? null : {
    isDestroyed: () => state === 'closed',
    webContents: { isDestroyed: () => state === 'renderer-destroyed' },
  };
  vi.mocked(findWindowByWorkspace).mockReturnValue(window as never);
  expect(resolveStreamingWindow('/project')).toBe(state === 'live' ? window : null);
  expect(findWindowByWorkspace).toHaveBeenCalledWith('/project');
});
