// @vitest-environment jsdom
/**
 * Opening a request's results tab from a layout where nothing is listening.
 *
 * The property worth pinning is what happens *after* the tab opens: the strip
 * owns the tab set once mounted and mirrors it back, so a closed tab must stay
 * closed. A seeded open that survives that mirror is invisible on inspection —
 * it shows up as a tab the author closed reappearing on the next layout change.
 */

import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { Provider } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';

import {
  FEEDBACK_REQUEST_OPEN_EVENT,
  feedbackRequestTabUri,
  openFeedbackRequestResults,
} from '../feedbackRequestTab';
import {
  FEEDBACK_TRACKER_OPEN_EVENT,
  resolveFeedbackArtifactAction,
  useFeedbackArtifactActionResolver,
  type FeedbackArtifactResolutionState,
} from '../feedbackArtifactActions';
import { windowModeAtom } from '../../../store/atoms/windowMode';
import { activeCollabScopeAtom } from '../../../store/atoms/collabDocuments';
import { selectedWorkstreamAtom } from '../../../store/atoms/sessions';
import {
  initWorkstreamState,
  setWorkstreamResourcesAtom,
  workstreamActiveFileAtom,
  workstreamLayoutModeAtom,
  workstreamStateAtom,
  type WorkstreamLayoutMode,
  type WorkstreamResource,
} from '../../../store/atoms/workstreamState';

let nextWorkstream = 0;
const WORKSPACE = '/tmp/feedback-request-tab-test';

/** A fresh workstream per test: the state atoms live for the module's life. */
function newWorkstream(layoutMode: WorkstreamLayoutMode): string {
  const workstreamId = `ws-${++nextWorkstream}`;
  store.set(workstreamStateAtom(workstreamId), { layoutMode });
  return workstreamId;
}

function openResourceIds(workstreamId: string): string[] {
  return store
    .get(workstreamStateAtom(workstreamId))
    .openResources.map((t) => t.resource.resourceId);
}

/** What the mounted strip writes back after any tab change. */
function mirrorLiveTabs(workstreamId: string, resources: WorkstreamResource[]): void {
  store.set(setWorkstreamResourcesAtom, {
    workstreamId,
    resources,
    activeResourceId: resources[resources.length - 1]?.resourceId ?? null,
  });
}

const REQUEST_1 = feedbackRequestTabUri({ orgId: 'org-1', requestId: 'req-1' });
const REQUEST_2 = feedbackRequestTabUri({ orgId: 'org-1', requestId: 'req-2' });

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    invoke: vi.fn().mockResolvedValue({}),
  };
  initWorkstreamState(WORKSPACE);
  store.set(windowModeAtom, 'files');
  store.set(activeCollabScopeAtom, null);
  store.set(trackerItemsMapAtom, new Map());
  store.set(selectedWorkstreamAtom(WORKSPACE), null);
});

describe('feedback tracker artifact actions', () => {
  const trackerArtifact = {
    ref: {
      orgId: 'org-1',
      projectId: 'project-design',
      kind: 'tracker' as const,
      sourceId: 'tracker-item-1',
    },
    label: 'Design follow-up',
  };

  const SCOPE = {
    scopeKey: WORKSPACE,
    orgId: 'org-1',
    indexConfig: {
      serverUrl: 'wss://sync.example.test',
      teamProjectId: 'project-design',
      teamMemberId: asTeamMemberId('user-1'),
    },
  };

  const TRACKER_ITEMS = new Map([[
    'tracker-item-1',
    { id: 'tracker-item-1' } as TrackerRecord,
  ]]);

  function resolutionState(
    overrides: Partial<FeedbackArtifactResolutionState> = {},
  ): FeedbackArtifactResolutionState {
    return {
      scope: SCOPE,
      trackerItems: TRACKER_ITEMS,
      workstreamId: 'workstream-7',
      ...overrides,
    };
  }

  it('dispatches the imperative tracker open to the resolved workstream and project', () => {
    const handler = vi.fn();
    window.addEventListener(FEEDBACK_TRACKER_OPEN_EVENT, handler);

    const action = resolveFeedbackArtifactAction(trackerArtifact, resolutionState());
    expect(() => action.open?.()).not.toThrow();
    window.removeEventListener(FEEDBACK_TRACKER_OPEN_EVENT, handler);

    expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual({
      workstreamId: 'workstream-7',
      trackerItemId: 'tracker-item-1',
      projectId: 'project-design',
    });
  });

  it('degrades to an inert reason when the synced tracker room lacks the item', () => {
    const action = resolveFeedbackArtifactAction(
      trackerArtifact,
      resolutionState({ trackerItems: new Map() }),
    );

    expect(action.open).toBeUndefined();
    expect(action.unavailableReason).toBeTruthy();
  });

  /**
   * The degradation above is only honest if it is temporary. The tracker room
   * syncs after the surface paints, so a resolver that read the store once
   * would leave a subject permanently inert while claiming it had handled the
   * miss. This renders the real hook and moves the atoms underneath it.
   */
  it('turns an unavailable tracker subject into an open action once its room syncs', () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(Provider, { store }, children);
    const { result } = renderHook(
      () => useFeedbackArtifactActionResolver(WORKSPACE),
      { wrapper },
    );

    expect(result.current(trackerArtifact).open).toBeUndefined();
    expect(result.current(trackerArtifact).unavailableReason).toBeTruthy();

    act(() => {
      store.set(activeCollabScopeAtom, SCOPE);
      store.set(trackerItemsMapAtom, new Map(TRACKER_ITEMS));
      store.set(selectedWorkstreamAtom(WORKSPACE), { type: 'workstream', id: 'workstream-7' });
    });

    const action = result.current(trackerArtifact);
    expect(action.unavailableReason).toBeUndefined();
    expect(action.open).toBeTypeOf('function');
  });
});

describe('openFeedbackRequestResults', () => {
  it('seeds the request and reveals a surface that can host it', () => {
    const workstreamId = newWorkstream('transcript');

    openFeedbackRequestResults({ workstreamId, orgId: 'org-1', requestId: 'req-1' });

    expect(openResourceIds(workstreamId)).toEqual([REQUEST_1]);
    expect(store.get(workstreamStateAtom(workstreamId)).activeResourceId).toBe(REQUEST_1);
    expect(store.get(workstreamLayoutModeAtom(workstreamId))).toBe('split');
    expect(store.get(windowModeAtom)).toBe('agent');
  });

  it('leaves a closed results tab closed across a layout change', () => {
    const workstreamId = newWorkstream('transcript');
    openFeedbackRequestResults({ workstreamId, orgId: 'org-1', requestId: 'req-1' });

    // The strip mounts, projects the seeded request, and mirrors its tabs back.
    mirrorLiveTabs(workstreamId, store.get(workstreamStateAtom(workstreamId)).openResources.map((t) => t.resource));
    // The author closes the tab; the mirror is the close.
    mirrorLiveTabs(workstreamId, []);

    store.set(workstreamStateAtom(workstreamId), { layoutMode: 'transcript' });
    store.set(workstreamStateAtom(workstreamId), { layoutMode: 'split' });

    expect(openResourceIds(workstreamId)).toEqual([]);
  });

  it('opens the second request alongside the first, focused', () => {
    const workstreamId = newWorkstream('transcript');

    openFeedbackRequestResults({ workstreamId, orgId: 'org-1', requestId: 'req-1' });
    store.set(workstreamStateAtom(workstreamId), { layoutMode: 'transcript' });
    openFeedbackRequestResults({ workstreamId, orgId: 'org-1', requestId: 'req-2' });

    expect(openResourceIds(workstreamId)).toEqual([REQUEST_1, REQUEST_2]);
    expect(store.get(workstreamStateAtom(workstreamId)).activeResourceId).toBe(REQUEST_2);
  });

  it('hands the open to a mounted strip instead of writing behind it', () => {
    store.set(windowModeAtom, 'agent');
    const workstreamId = newWorkstream('split');
    const handler = vi.fn();
    window.addEventListener(FEEDBACK_REQUEST_OPEN_EVENT, handler);

    openFeedbackRequestResults({ workstreamId, orgId: 'org-1', requestId: 'req-1' });
    window.removeEventListener(FEEDBACK_REQUEST_OPEN_EVENT, handler);

    expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual({
      workstreamId,
      orgId: 'org-1',
      requestId: 'req-1',
    });
    // TabsContext is authoritative once mounted; it writes the mirror itself.
    expect(openResourceIds(workstreamId)).toEqual([]);
  });

  it('is not the workstream current file', () => {
    const workstreamId = newWorkstream('transcript');

    openFeedbackRequestResults({ workstreamId, orgId: 'org-1', requestId: 'req-1' });

    // A results tab that typed itself as a file would be sent to the agent as
    // the document the author is looking at.
    expect(store.get(workstreamActiveFileAtom(workstreamId))).toBeNull();
  });
});
