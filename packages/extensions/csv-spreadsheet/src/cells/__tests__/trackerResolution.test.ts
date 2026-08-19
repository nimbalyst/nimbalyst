// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { TrackerResolutionStore, trackerStatusTone } from '../trackerResolution';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The chip's whole contract with the grid is invisible on screen: templates
 * sample the store at paint time, so a resolution that arrives later only shows
 * up if the store asks for a repaint — and a store that asks too eagerly turns
 * the resolver's re-render into an infinite refresh loop.
 */
describe('TrackerResolutionStore', () => {
  it('registers an unknown key for resolution and reads as unresolved until one arrives', async () => {
    const store = new TrackerResolutionStore();
    const onKeys = vi.fn();
    store.onKeysChanged(onKeys);

    expect(store.read('NIM-1')).toBeNull();
    expect(onKeys).not.toHaveBeenCalled();

    await flush();
    expect(onKeys).toHaveBeenCalledWith(['NIM-1']);
  });

  it('batches every key painted in the same tick into one update', async () => {
    const store = new TrackerResolutionStore();
    const onKeys = vi.fn();
    store.onKeysChanged(onKeys);

    store.read('NIM-1');
    store.read('NIM-2');
    store.read('NIM-1');

    await flush();
    expect(onKeys).toHaveBeenCalledTimes(1);
    expect(onKeys).toHaveBeenCalledWith(['NIM-1', 'NIM-2']);
  });

  it('repaints when a resolution arrives, and serves it to later paints', () => {
    const store = new TrackerResolutionStore();
    const repaint = vi.fn();
    store.onRepaintNeeded(repaint);

    store.read('NIM-1');
    store.setResolution('NIM-1', { itemId: 'abc', title: 'Fix the thing', status: 'in-progress' });

    expect(repaint).toHaveBeenCalledTimes(1);
    expect(store.read('NIM-1')).toEqual({
      itemId: 'abc',
      title: 'Fix the thing',
      status: 'in-progress',
    });
  });

  it('does not repaint when a resolver re-reports the same item', () => {
    const store = new TrackerResolutionStore();
    const repaint = vi.fn();
    store.onRepaintNeeded(repaint);

    const resolution = { itemId: 'abc', title: 'Fix the thing', status: 'in-progress' };
    store.setResolution('NIM-1', resolution);
    store.setResolution('NIM-1', { ...resolution });
    expect(repaint).toHaveBeenCalledTimes(1);

    // A changed title is a real change and must repaint.
    store.setResolution('NIM-1', { ...resolution, title: 'Fix the other thing' });
    expect(repaint).toHaveBeenCalledTimes(2);
  });

  it('repaints when a key resolves to nothing, but only once', () => {
    const store = new TrackerResolutionStore();
    const repaint = vi.fn();
    store.onRepaintNeeded(repaint);

    store.setResolution('NIM-1', null);
    store.setResolution('NIM-1', null);
    expect(repaint).toHaveBeenCalledTimes(1);
  });

  it('goes quiet after destroy', async () => {
    const store = new TrackerResolutionStore();
    const onKeys = vi.fn();
    const repaint = vi.fn();
    store.onKeysChanged(onKeys);
    store.onRepaintNeeded(repaint);

    store.read('NIM-1');
    store.destroy();
    store.setResolution('NIM-1', { itemId: 'abc', title: 'x' });

    await flush();
    expect(onKeys).not.toHaveBeenCalled();
    expect(repaint).not.toHaveBeenCalled();
  });
});

describe('trackerStatusTone', () => {
  it.each([
    ['in progress', 'in-progress'],
    ['In Review', 'in-review'],
    ['done', 'completed'],
    ['blocked', 'blocked'],
    ['to-do', 'to-do'],
    // Statuses are workspace-configurable, so anything unrecognized is neutral
    // rather than mislabeled.
    ['marinating', 'neutral'],
    [undefined, 'neutral'],
  ])('%o -> %s', (status, expected) => {
    expect(trackerStatusTone(status)).toBe(expected);
  });
});
