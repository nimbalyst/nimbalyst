/**
 * Content focus is the tracker body's "fill the surface" layout: the metadata
 * sections stand down and the editor takes the whole panel.
 *
 * It used to be gated on a *collaborative* body, which meant local-only users
 * never saw the feature and Tracker Mode's document view rendered the unfocused
 * layout for file-backed plans and database-only items (plan:
 * tracker-document-mode, checkbox 22). Focus is purely a layout state, so the
 * only gate left is whether the host offers it -- collab chrome (presence, sync
 * dot, inline comments) stays gated on the body actually being collaborative.
 */

import type { TrackerContentMode } from './TrackerItemDetail';

export interface TrackerContentFocusState {
  /** Whether the focus toggle is offered at all. */
  showFocusToggle: boolean;
  /** Whether the focused layout is currently applied. */
  focusActive: boolean;
  /** Whether the collaborative chrome should be mounted. */
  showCollabChrome: boolean;
}

export function resolveTrackerContentFocus(params: {
  enableContentFocus: boolean;
  contentFocus: boolean;
  contentMode: TrackerContentMode;
}): TrackerContentFocusState {
  const showFocusToggle = params.enableContentFocus;
  return {
    showFocusToggle,
    focusActive: params.contentFocus && showFocusToggle,
    showCollabChrome: params.contentMode === 'collaborative',
  };
}
