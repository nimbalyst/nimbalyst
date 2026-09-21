import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVoicePreview } from '../useVoicePreview';

afterEach(() => vi.unstubAllGlobals());

describe('bundled voice playback', () => {
  it('stops on selection change and ignores rejection from an older playback', async () => {
    const instances: Array<{ pause: ReturnType<typeof vi.fn>; reject: (error: Error) => void; onended: (() => void) | null }> = [];
    vi.stubGlobal('Audio', class {
      pause = vi.fn();
      onended = null;
      onerror = null;
      reject!: (error: Error) => void;
      play = () => new Promise<void>((_, reject) => { this.reject = reject; });
      constructor(public src: string) { instances.push(this); }
    });
    const { result, rerender, unmount } = renderHook(({ source }) => useVoicePreview(source), { initialProps: { source: '/marin.mp3' } });
    let oldPlay!: Promise<void>;
    act(() => { oldPlay = result.current.toggle(); });
    expect(result.current.isPlaying).toBe(true);
    rerender({ source: '/cedar.mp3' });
    expect(instances[0].pause).toHaveBeenCalledOnce();
    act(() => { void result.current.toggle(); });
    await act(async () => { instances[0].reject(new Error('interrupted')); await oldPlay; });
    expect(result.current.isPlaying).toBe(true);
    expect(result.current.error).toBeUndefined();
    unmount();
    expect(instances[1].pause).toHaveBeenCalledOnce();
  });

  it('allows stopping while play is pending and reports a current playback failure', async () => {
    let reject!: (error: Error) => void;
    const pause = vi.fn();
    vi.stubGlobal('Audio', class {
      pause = pause;
      play = () => new Promise<void>((_, fail) => { reject = fail; });
    });
    const { result } = renderHook(() => useVoicePreview('/marin.mp3'));
    let pending!: Promise<void>;
    act(() => { pending = result.current.toggle(); });
    await act(async () => { await result.current.toggle(); reject(new Error('stopped')); await pending; });
    expect(result.current.isPlaying).toBe(false);
    expect(result.current.error).toBeUndefined();
    act(() => { pending = result.current.toggle(); });
    await act(async () => { reject(new Error('decode failed')); await pending; });
    expect(result.current.error).toBeDefined();
    expect(result.current.isPlaying).toBe(false);
  });
});
