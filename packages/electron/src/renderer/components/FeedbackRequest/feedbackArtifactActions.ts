/**
 * Desktop resolution for artifacts carried by feedback requests.
 *
 * Resource refs name an owning organization and, for current requests, the
 * owning tracker/document project. Resolution must stay inside that scope: a
 * same-shaped id in the project currently on screen is not the referenced
 * artifact. Tracker refs additionally have to exist in the tracker map already
 * populated by that project's synced tracker room.
 *
 * **Resolution is a subscription, not a snapshot.** Every input here arrives
 * late: the collab scope after the connection establishes, the tracker map as
 * the tracker room syncs, the workstream selection whenever the user picks one.
 * A resolver that read the store once during render would paint
 * "not available in the synced project" on a first paint that is merely early,
 * and then never repaint — an inert subject the code believes it degraded
 * gracefully. Hence the split below: a pure core over already-resolved state,
 * and `useFeedbackArtifactActionResolver` as the thin subscribing wrapper that
 * every host call site uses.
 */

import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import type { FeedbackArtifact } from '@nimbalyst/collab-protocol';
import type { CollabScope } from '@nimbalyst/collab-client/core';
import type {
  FeedbackArtifactAction,
  FeedbackArtifactActionResolver,
} from '@nimbalyst/collab-client/feedback-ui';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';

import { selectedWorkstreamAtom } from '../../store/atoms/sessions';
import { activeCollabScopeAtom } from '../../store/atoms/collabDocuments';
import { openSharedDocumentInTab } from '../../utils/openSharedDocumentInTab';

export const FEEDBACK_TRACKER_OPEN_EVENT = 'nimbalyst:workstream-open-tracker';

/** Everything resolution depends on, read once by the hook and passed down. */
export interface FeedbackArtifactResolutionState {
  scope: CollabScope | null;
  trackerItems: ReadonlyMap<string, TrackerRecord>;
  /** The workstream a tracker item would open into; null when none is picked. */
  workstreamId: string | null;
}

function unavailable(reason: string): FeedbackArtifactAction {
  return { unavailableReason: reason };
}

function scopeMismatchReason(
  artifact: FeedbackArtifact,
  scope: CollabScope | null,
): string | null {
  const kindLabel = artifact.ref.kind === 'tracker' ? 'tracker item' : 'document';
  if (!scope) {
    return `This ${kindLabel} is unavailable because no team project is active.`;
  }
  if (artifact.ref.orgId !== scope.orgId) {
    return `This ${kindLabel} belongs to another organization.`;
  }
  const activeProjectId = scope.indexConfig.teamProjectId ?? undefined;
  if (artifact.ref.projectId && artifact.ref.projectId !== activeProjectId) {
    return `Open the project that owns this ${kindLabel} to view it.`;
  }
  return null;
}

/**
 * Resolve one artifact against already-resolved state. A caller renders
 * `unavailableReason` as inert explanatory copy; it never invokes a best-effort
 * callback that can silently do nothing.
 */
export function resolveFeedbackArtifactAction(
  artifact: FeedbackArtifact,
  state: FeedbackArtifactResolutionState,
): FeedbackArtifactAction {
  if (artifact.ref.kind !== 'document' && artifact.ref.kind !== 'tracker') {
    return {};
  }

  const mismatch = scopeMismatchReason(artifact, state.scope);
  if (mismatch) return unavailable(mismatch);

  if (artifact.ref.kind === 'document') {
    return {
      open: () => {
        openSharedDocumentInTab(artifact.ref, 'feedback_request');
      },
    };
  }

  const tracker = state.trackerItems.get(artifact.ref.sourceId);
  if (!tracker) {
    return unavailable('This tracker item is not available in the synced project.');
  }

  if (!state.workstreamId) {
    return unavailable('Select a workstream in this project to open this tracker item.');
  }

  const workstreamId = state.workstreamId;
  const projectId = state.scope?.indexConfig.teamProjectId ?? artifact.ref.projectId;
  return {
    open: () => {
      window.dispatchEvent(new CustomEvent(FEEDBACK_TRACKER_OPEN_EVENT, {
        detail: {
          workstreamId,
          trackerItemId: tracker.id,
          ...(projectId ? { projectId } : {}),
        },
      }));
    },
  };
}

/**
 * The resolver a desktop host hands to the shared feedback UI. Subscribes to
 * every input so a subject that could not be resolved on first paint becomes
 * openable the moment its room finishes syncing.
 */
export function useFeedbackArtifactActionResolver(
  workspacePath: string | undefined,
): FeedbackArtifactActionResolver {
  const scope = useAtomValue(activeCollabScopeAtom);
  const trackerItems = useAtomValue(trackerItemsMapAtom);
  // A stable family key even with no workspace: the empty member is always null,
  // which is the same answer a conditional hook would have to produce anyway.
  const selection = useAtomValue(selectedWorkstreamAtom(workspacePath ?? ''));

  return useMemo(() => {
    const state: FeedbackArtifactResolutionState = {
      scope,
      trackerItems,
      workstreamId: workspacePath ? selection?.id ?? null : null,
    };
    return (artifact: FeedbackArtifact) => resolveFeedbackArtifactAction(artifact, state);
  }, [scope, trackerItems, selection, workspacePath]);
}
