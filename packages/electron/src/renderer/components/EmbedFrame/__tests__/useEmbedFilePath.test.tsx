// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useEmbedFilePath } from '../useEmbedFilePath';

afterEach(() => { vi.unstubAllGlobals(); });

it('does not mount or expose the previous target while resolving a changed link', async () => {
  let finishOld!: (exists: boolean) => void;
  const invoke = vi.fn(async (_channel: string, path: string) => {
    if (path === '/ws/docs/old.mockup.html') return new Promise<boolean>(resolve => { finishOld = resolve; });
    return path === '/ws/new.mockup.html';
  });
  vi.stubGlobal('electronAPI', { invoke });
  const { result, rerender } = renderHook(({ src }) => useEmbedFilePath(src, '/ws/docs', '/ws'), {
    initialProps: { src: 'old.mockup.html' },
  });
  expect(result.current).toEqual({ path: null, pending: true, error: null });
  rerender({ src: 'new.mockup.html' });
  await waitFor(() => expect(result.current.path).toBe('/ws/new.mockup.html'));
  await act(async () => { finishOld(true); });
  expect(result.current.path).toBe('/ws/new.mockup.html');
  rerender({ src: './explicit.mockup.html' });
  expect(result.current.path).toBe('/ws/docs/explicit.mockup.html');
});

it('surfaces a rejected lookup without mounting a fallback file', async () => {
  const invoke = vi.fn(async () => { throw new Error('IPC disconnected'); });
  vi.stubGlobal('electronAPI', { invoke });
  const { result } = renderHook(() => useEmbedFilePath('/panel.mockup.html', '/ws/docs', '/ws'));
  await waitFor(() => expect(result.current.error).toContain('IPC disconnected'));
  expect(result.current.path).toBeNull();
  expect(invoke).toHaveBeenCalledTimes(1);
});
