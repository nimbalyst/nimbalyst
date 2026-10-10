// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { flushPersonalPageBody, restoreHistoryToPersonalPage, usePersonalPageBody } from '../usePersonalPageBody';

let invoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  invoke = vi.fn();
  (window as any).electronAPI = { invoke };
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as any).electronAPI;
});

function bodyCalls(channel: string) {
  return invoke.mock.calls.filter((c) => c[0] === channel);
}

async function renderLoaded(body: { content: string; version: number } | null) {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'personal-pages:get-body') return body;
    throw new Error(`unexpected ${channel}`);
  });
  const hook = renderHook(() => usePersonalPageBody({ workspacePath: '/ws', documentId: 'pdoc-1', saveDelayMs: 500 }));
  await act(async () => {});
  return hook;
}

describe('usePersonalPageBody', () => {
  it('keeps a missing page unavailable and refuses edits and history restore', async () => {
    const { result, unmount } = await renderLoaded(null);
    expect(result.current.status).toBe('unavailable');
    act(() => result.current.onEdit('must not create a replacement page'));
    await act(async () => { vi.advanceTimersByTime(500); });
    await expect(restoreHistoryToPersonalPage('personal-doc://pdoc-1', 'old body', '/ws')).rejects.toThrow(/unavailable/i);
    unmount();
    await expect(restoreHistoryToPersonalPage('personal-doc://pdoc-1', 'old body', '/ws')).rejects.toThrow(/unavailable/i);
    expect(bodyCalls('personal-pages:update-body')).toHaveLength(0);
  });

  it('allows an existing empty page to be edited', async () => {
    const { result } = await renderLoaded({ content: '', version: 0 });
    expect(result.current.status).toBe('ready');
    invoke.mockImplementation(async () => ({ version: 1 }));
    act(() => result.current.onEdit('first words'));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(bodyCalls('personal-pages:update-body')).toEqual([
      ['personal-pages:update-body', '/ws', 'pdoc-1', 'first words', 0],
    ]);
  });

  it('can retry an unavailable page once its body is present', async () => {
    const { result } = await renderLoaded(null);
    invoke.mockImplementation(async () => ({ content: 'recovered', version: 2 }));
    await act(async () => result.current.retryLoad());
    expect(result.current.status).toBe('ready');
    expect(result.current.initialContent).toBe('recovered');
  });

  it('loads the body once and exposes it as the initial content', async () => {
    const { result, rerender } = await renderLoaded({ content: '# Notes', version: 3 });
    rerender();
    expect(result.current.status).toBe('ready');
    expect(result.current.initialContent).toBe('# Notes');
    expect(bodyCalls('personal-pages:get-body')).toEqual([['personal-pages:get-body', '/ws', 'pdoc-1']]);
  });

  it('debounces edits into one save carrying the loaded version, then the saved version', async () => {
    const { result } = await renderLoaded({ content: 'a', version: 3 });
    invoke.mockImplementation(async (channel: string, _ws, _id, _content, expected) => {
      if (channel === 'personal-pages:update-body') return { version: expected + 1 };
      throw new Error(`unexpected ${channel}`);
    });

    act(() => {
      result.current.onEdit('ab');
      result.current.onEdit('abc');
    });
    expect(bodyCalls('personal-pages:update-body')).toHaveLength(0);
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(bodyCalls('personal-pages:update-body')).toEqual([
      ['personal-pages:update-body', '/ws', 'pdoc-1', 'abc', 3],
    ]);

    act(() => result.current.onEdit('abcd'));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(bodyCalls('personal-pages:update-body')[1]).toEqual(['personal-pages:update-body', '/ws', 'pdoc-1', 'abcd', 4]);
  });

  it('on a version conflict reloads the stored body, remounts and shows a notice', async () => {
    const { result } = await renderLoaded({ content: 'mine', version: 3 });
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'personal-pages:update-body') return { conflict: true, version: 7, content: 'theirs' };
      throw new Error(`unexpected ${channel}`);
    });
    const epoch = result.current.editorEpoch;

    act(() => result.current.onEdit('mine, edited'));
    await act(async () => { vi.advanceTimersByTime(500); });

    expect(result.current.initialContent).toBe('theirs');
    expect(result.current.editorEpoch).toBe(epoch + 1);
    expect(result.current.notice).toMatch(/changed elsewhere/);

    // The next save is made against the version the conflict reported.
    invoke.mockImplementation(async () => ({ version: 8 }));
    act(() => result.current.onEdit('theirs, edited'));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(bodyCalls('personal-pages:update-body').at(-1)).toEqual(
      ['personal-pages:update-body', '/ws', 'pdoc-1', 'theirs, edited', 7],
    );
  });

  it('keeps the latest draft in local history when a save conflicts after the tab closed', async () => {
    const { result, unmount } = await renderLoaded({ content: 'base', version: 3 });
    let settle!: (value: unknown) => void;
    invoke.mockImplementation((channel: string) => {
      if (channel === 'personal-pages:update-body') return new Promise((resolve) => { settle = resolve; });
      return Promise.resolve(undefined);
    });

    act(() => result.current.onEdit('draft'));
    await act(async () => { vi.advanceTimersByTime(500); });
    act(() => result.current.onEdit('draft, typed while saving'));
    unmount();
    await act(async () => { settle({ conflict: true, version: 9, content: 'theirs' }); });

    expect(bodyCalls('personal-pages:update-body')).toHaveLength(1);
    expect(bodyCalls('history:create-snapshot')).toEqual([[
      'history:create-snapshot', 'personal-doc://pdoc-1', 'draft, typed while saving', 'manual',
      'Unsaved edits kept after a conflict',
    ]]);
  });

  it('stops retrying a persistently failing save, then keeps the text in history on close', async () => {
    const { result, unmount } = await renderLoaded({ content: 'a', version: 1 });
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'personal-pages:update-body') throw new Error('database is gone');
      return undefined;
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    act(() => result.current.onEdit('a, never saved'));
    for (const ms of [500, 1000, 2000, 4000, 60_000]) {
      await act(async () => { vi.advanceTimersByTime(ms); });
    }
    expect(bodyCalls('personal-pages:update-body')).toHaveLength(4);
    expect(result.current.notice).toMatch(/could not be saved/);

    unmount();
    await act(async () => {});
    expect(bodyCalls('personal-pages:update-body')).toHaveLength(5);
    expect(bodyCalls('history:create-snapshot')[0]?.slice(1, 3)).toEqual(['personal-doc://pdoc-1', 'a, never saved']);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(bodyCalls('personal-pages:update-body')).toHaveLength(5);
  });

  it('flushes a pending edit on unmount instead of dropping it', async () => {
    const { result, unmount } = await renderLoaded({ content: 'a', version: 1 });
    invoke.mockImplementation(async () => ({ version: 2 }));
    act(() => result.current.onEdit('a, unsaved'));
    unmount();
    expect(bodyCalls('personal-pages:update-body')).toEqual([
      ['personal-pages:update-body', '/ws', 'pdoc-1', 'a, unsaved', 1],
    ]);
  });

  it('lets another surface flush the debounced edit and wait until it is stored', async () => {
    const { result } = await renderLoaded({ content: 'a', version: 1 });
    let store: () => void = () => {};
    invoke.mockImplementation(() => new Promise((resolve) => { store = () => resolve({ version: 2 }); }));
    act(() => result.current.onEdit('a, typed just now'));

    let settled = false;
    const flushed = flushPersonalPageBody('/ws', 'pdoc-1').then(() => { settled = true; });
    await act(async () => {});
    expect(bodyCalls('personal-pages:update-body')).toEqual([
      ['personal-pages:update-body', '/ws', 'pdoc-1', 'a, typed just now', 1],
    ]);
    expect(settled).toBe(false);

    await act(async () => { store(); await flushed; });
    expect(settled).toBe(true);
    // No open editor for a page: nothing to wait for.
    await expect(flushPersonalPageBody('/ws', 'other')).resolves.toBeUndefined();
  });

  it('restores history into the open page: draft stored first, editor shows the restore, next edit saves cleanly', async () => {
    const { result } = await renderLoaded({ content: 'a', version: 3 });
    const stored = { content: 'a', version: 3 };
    invoke.mockImplementation(async (channel: string, _ws, _id, content: string, expected?: number) => {
      if (channel === 'personal-pages:get-body') return { ...stored };
      if (channel === 'personal-pages:update-body') {
        if (expected !== stored.version) return { conflict: true, ...stored };
        Object.assign(stored, { content, version: stored.version + 1 });
        return { version: stored.version };
      }
      return undefined;
    });
    act(() => result.current.onEdit('a, unsaved draft'));
    const epoch = result.current.editorEpoch;

    await act(async () => {
      await expect(restoreHistoryToPersonalPage('personal-doc://pdoc-1', '# Older text', '/ws')).resolves.toBe(true);
    });
    // The draft became a body (and so a history entry) before the restore replaced it.
    expect(bodyCalls('personal-pages:update-body').map((call) => call.slice(3))).toEqual([
      ['a, unsaved draft', 3],
      ['# Older text', 4],
    ]);
    expect(result.current.initialContent).toBe('# Older text');
    expect(result.current.editorEpoch).toBe(epoch + 1);

    act(() => result.current.onEdit('# Older text, edited'));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(stored).toEqual({ content: '# Older text, edited', version: 6 });
    expect(result.current.notice).toBeNull();
  });
});
