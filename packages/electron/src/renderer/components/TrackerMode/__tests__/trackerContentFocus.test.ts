/**
 * Regression guard for the loosened focus gate (plan: tracker-document-mode,
 * checkbox 22): a local or file-backed body gets the focused layout too, while
 * the collaborative chrome stays gated on a collaborative body.
 */
import { describe, expect, it } from 'vitest';
import { resolveTrackerContentFocus } from '../trackerContentFocus';

describe('resolveTrackerContentFocus', () => {
  it('focuses a local PGLite body, which used to be refused', () => {
    const state = resolveTrackerContentFocus({
      enableContentFocus: true,
      contentFocus: true,
      contentMode: 'local-pglite',
    });

    expect(state.showFocusToggle).toBe(true);
    expect(state.focusActive).toBe(true);
    expect(state.showCollabChrome).toBe(false);
  });

  it('focuses a file-backed body', () => {
    const state = resolveTrackerContentFocus({
      enableContentFocus: true,
      contentFocus: true,
      contentMode: 'file-backed',
    });

    expect(state.focusActive).toBe(true);
    expect(state.showCollabChrome).toBe(false);
  });

  it('keeps presence and the sync dot for collaborative bodies only', () => {
    expect(resolveTrackerContentFocus({
      enableContentFocus: true,
      contentFocus: true,
      contentMode: 'collaborative',
    }).showCollabChrome).toBe(true);
  });

  it('offers nothing when the host does not enable focus', () => {
    const state = resolveTrackerContentFocus({
      enableContentFocus: false,
      contentFocus: true,
      contentMode: 'collaborative',
    });

    expect(state.showFocusToggle).toBe(false);
    expect(state.focusActive).toBe(false);
  });
});
