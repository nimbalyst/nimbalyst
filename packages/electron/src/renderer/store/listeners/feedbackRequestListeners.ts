import type { Store } from 'jotai/vanilla/store';

import type { FeedbackRequestServiceState } from '../../../shared/feedbackRequest';
import type { FeedbackRequestIndexChangedPayload } from '../../../shared/feedbackRequestIndex';
import { store } from '..';
import {
  feedbackRequestActiveViewerAtomFamily,
  feedbackRequestAtomKey,
  feedbackRequestStateAtomFamily,
  feedbackRequestTargetKey,
  feedbackRequestIndexActiveViewerAtomFamily,
  feedbackRequestIndexTargetKey,
  feedbackRequestIndexViewerEntriesAtomFamily,
  feedbackRequestIndexViewerKey,
} from '../atoms/feedbackRequests';

const FEEDBACK_REQUEST_RENDER_DEBOUNCE_MS = 40;

function isFeedbackRequestState(
  value: unknown,
): value is FeedbackRequestServiceState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<FeedbackRequestServiceState>;
  return (
    typeof candidate.workspacePath === 'string'
    && typeof candidate.orgId === 'string'
    && typeof candidate.requestId === 'string'
    && typeof candidate.teamMemberId === 'string'
    && typeof candidate.status === 'string'
  );
}

function isFeedbackRequestIndexChangedPayload(
  value: unknown,
): value is FeedbackRequestIndexChangedPayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<FeedbackRequestIndexChangedPayload>;
  return (
    typeof candidate.workspacePath === 'string'
    && typeof candidate.orgId === 'string'
    && typeof candidate.teamMemberId === 'string'
    && Array.isArray(candidate.entries)
  );
}

/** Installs the only renderer subscription for feedback request sync state. */
export function initFeedbackRequestListeners(
  targetStore: Store = store,
): () => void {
  const pending = new Map<string, FeedbackRequestServiceState>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingIndexes = new Map<string, FeedbackRequestIndexChangedPayload>();
  const indexTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const unsubscribes = [window.electronAPI.on(
    'feedback-request:state-changed',
    (value: unknown) => {
      if (!isFeedbackRequestState(value)) return;
      const key = feedbackRequestAtomKey(value);
      const targetKey = feedbackRequestTargetKey(value);
      // Switch identity before the debounced projection write. A newly active
      // viewer may see their own older cache briefly, but can never see the
      // previous viewer's response projection under the shared target key.
      targetStore.set(
        feedbackRequestActiveViewerAtomFamily(targetKey),
        value.teamMemberId,
      );
      pending.set(key, value);
      const current = timers.get(key);
      if (current) clearTimeout(current);
      timers.set(key, setTimeout(() => {
        timers.delete(key);
        const next = pending.get(key);
        pending.delete(key);
        if (next) targetStore.set(feedbackRequestStateAtomFamily(key), next);
      }, FEEDBACK_REQUEST_RENDER_DEBOUNCE_MS));
    },
  ), window.electronAPI.on(
    'feedback-request-index:changed',
    (value: unknown) => {
      if (!isFeedbackRequestIndexChangedPayload(value)) return;
      const targetKey = feedbackRequestIndexTargetKey(value);
      const viewerKey = feedbackRequestIndexViewerKey(value);
      // Switch identity immediately so a different local account never reads
      // the prior account's participant-filtered list during debounce.
      targetStore.set(
        feedbackRequestIndexActiveViewerAtomFamily(targetKey),
        value.teamMemberId,
      );
      pendingIndexes.set(viewerKey, value);
      const current = indexTimers.get(viewerKey);
      if (current) clearTimeout(current);
      indexTimers.set(viewerKey, setTimeout(() => {
        indexTimers.delete(viewerKey);
        const next = pendingIndexes.get(viewerKey);
        pendingIndexes.delete(viewerKey);
        if (next) {
          targetStore.set(
            feedbackRequestIndexViewerEntriesAtomFamily(viewerKey),
            next.entries,
          );
        }
      }, FEEDBACK_REQUEST_RENDER_DEBOUNCE_MS));
    },
  )];

  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    for (const timer of timers.values()) clearTimeout(timer);
    for (const timer of indexTimers.values()) clearTimeout(timer);
    timers.clear();
    pending.clear();
    indexTimers.clear();
    pendingIndexes.clear();
  };
}
