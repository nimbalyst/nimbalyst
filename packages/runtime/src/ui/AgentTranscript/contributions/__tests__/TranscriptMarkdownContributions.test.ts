import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _resetTranscriptMarkdownContributionsForTests,
  clearTranscriptMarkdownContributions,
  getMergedTranscriptMarkdownContributions,
  setTranscriptMarkdownContributions,
  subscribeToTranscriptMarkdownContributions,
} from '../TranscriptMarkdownContributions';

afterEach(() => {
  _resetTranscriptMarkdownContributionsForTests();
});

describe('TranscriptMarkdownContributions', () => {
  it('returns an empty frozen merged view when nothing is registered', () => {
    const merged = getMergedTranscriptMarkdownContributions();
    expect(merged.remarkPlugins).toEqual([]);
    expect(merged.rehypePlugins).toEqual([]);
    expect(merged.components).toEqual({});
    expect(merged.styles).toEqual([]);
  });

  it('merges plugins from every registered source in insertion order', () => {
    const remarkA = () => undefined;
    const remarkB = () => undefined;
    setTranscriptMarkdownContributions('extension-a', {
      remarkPlugins: [remarkA],
    });
    setTranscriptMarkdownContributions('extension-b', {
      remarkPlugins: [remarkB],
    });
    const merged = getMergedTranscriptMarkdownContributions();
    expect(merged.remarkPlugins).toEqual([remarkA, remarkB]);
  });

  it('lets the latest contributor override an overlapping component key', () => {
    const First = () => null;
    const Second = () => null;
    setTranscriptMarkdownContributions('extension-a', {
      components: { code: First },
    });
    setTranscriptMarkdownContributions('extension-b', {
      components: { code: Second },
    });
    const merged = getMergedTranscriptMarkdownContributions();
    expect(merged.components.code).toBe(Second);
  });

  it('caches the merged view across reads until the registry changes', () => {
    setTranscriptMarkdownContributions('extension-a', {
      remarkPlugins: [() => undefined],
    });
    const first = getMergedTranscriptMarkdownContributions();
    const second = getMergedTranscriptMarkdownContributions();
    expect(first).toBe(second);

    setTranscriptMarkdownContributions('extension-b', {
      remarkPlugins: [() => undefined],
    });
    const third = getMergedTranscriptMarkdownContributions();
    expect(third).not.toBe(first);
  });

  it('clears a contribution when set with undefined', () => {
    setTranscriptMarkdownContributions('extension-a', {
      remarkPlugins: [() => undefined],
    });
    setTranscriptMarkdownContributions('extension-a', undefined);
    const merged = getMergedTranscriptMarkdownContributions();
    expect(merged.remarkPlugins).toEqual([]);
  });

  it('clearTranscriptMarkdownContributions removes a registered source', () => {
    setTranscriptMarkdownContributions('extension-a', {
      remarkPlugins: [() => undefined],
    });
    clearTranscriptMarkdownContributions('extension-a');
    const merged = getMergedTranscriptMarkdownContributions();
    expect(merged.remarkPlugins).toEqual([]);
  });

  it('notifies subscribers on set, clear, and undefined-set, and stops after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToTranscriptMarkdownContributions(listener);

    setTranscriptMarkdownContributions('extension-a', {
      remarkPlugins: [() => undefined],
    });
    expect(listener).toHaveBeenCalledTimes(1);

    setTranscriptMarkdownContributions('extension-a', undefined);
    expect(listener).toHaveBeenCalledTimes(2);

    setTranscriptMarkdownContributions('extension-b', { remarkPlugins: [] });
    expect(listener).toHaveBeenCalledTimes(3);
    clearTranscriptMarkdownContributions('extension-b');
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
    setTranscriptMarkdownContributions('extension-c', { remarkPlugins: [] });
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('does not notify when clearing an unknown source', () => {
    const listener = vi.fn();
    subscribeToTranscriptMarkdownContributions(listener);
    clearTranscriptMarkdownContributions('never-registered');
    expect(listener).not.toHaveBeenCalled();
  });

  it('throws when called with an empty source', () => {
    expect(() =>
      setTranscriptMarkdownContributions('', { remarkPlugins: [] }),
    ).toThrow(/non-empty source/);
  });

  it('merges styles from every contributor', () => {
    setTranscriptMarkdownContributions('extension-a', {
      styles: [{ type: 'css-text', id: 'a-styles', cssText: '.a {}' }],
    });
    setTranscriptMarkdownContributions('extension-b', {
      styles: [{ type: 'stylesheet', id: 'b-styles', href: '/b.css' }],
    });
    const merged = getMergedTranscriptMarkdownContributions();
    expect(merged.styles).toHaveLength(2);
    expect(merged.styles[0]).toMatchObject({ id: 'a-styles' });
    expect(merged.styles[1]).toMatchObject({ id: 'b-styles' });
  });
});
