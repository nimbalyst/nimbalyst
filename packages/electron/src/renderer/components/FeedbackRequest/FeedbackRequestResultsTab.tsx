/**
 * The results surface as a tab.
 *
 * Everything IPC-shaped lives here -- opening the room, building the host --
 * so `FeedbackRequestResults` stays a component that reads atoms and calls
 * host methods. Mounted by TabContent for a `virtual://feedback-request/` tab.
 */

import React, { useEffect, useMemo } from 'react';

import type { FeedbackRequestServiceTarget } from '../../../shared/feedbackRequest';
import { FeedbackRequestResults } from './FeedbackRequestResults';
import {
  createFeedbackResultsHost,
  startFeedbackRequestSync,
} from './createFeedbackResultsHost';
import { useFeedbackArtifactActionResolver } from './feedbackArtifactActions';
import { parseFeedbackRequestTabUri } from './feedbackRequestTab';

export interface FeedbackRequestResultsTabProps {
  /** The tab's `virtual://feedback-request/<orgId>/<requestId>` key. */
  tabUri: string;
  /** Absent only while a window has no workspace resolved yet. */
  workspacePath?: string;
}

export const FeedbackRequestResultsTab: React.FC<FeedbackRequestResultsTabProps> = ({
  tabUri,
  workspacePath,
}) => {
  const ref = useMemo(() => parseFeedbackRequestTabUri(tabUri), [tabUri]);
  const target = useMemo<FeedbackRequestServiceTarget | null>(
    () => (ref && workspacePath
      ? { workspacePath, orgId: ref.orgId, requestId: ref.requestId }
      : null),
    [ref, workspacePath],
  );

  useEffect(() => {
    if (!target) return;
    void startFeedbackRequestSync(target);
  }, [target]);

  const host = useMemo(
    () => (target ? createFeedbackResultsHost({ target }) : undefined),
    [target],
  );
  const resolveArtifactAction = useFeedbackArtifactActionResolver(workspacePath);

  if (!target) {
    return (
      <div
        data-testid="feedback-request-results-tab-invalid"
        className="feedback-request-results-tab-invalid select-text p-4 text-xs text-nim-muted"
      >
        This tab does not point at a feedback request any more.
      </div>
    );
  }

  return (
    <div className="feedback-request-results-tab h-full overflow-auto p-4">
      <FeedbackRequestResults
        target={target}
        host={host}
        resolveArtifactAction={resolveArtifactAction}
      />
    </div>
  );
};
