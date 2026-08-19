/**
 * One feedback request, wired to the collaboration layer, wherever it is met.
 *
 * Every surface that shows a live request needs the same six things: the room
 * opened, the per-viewer projection read, a respond host, a results host, the
 * discussion adapter, and the artifact resolver that makes subjects openable.
 * The Inbox context pane grew that block first; the shared area's feedback list
 * would have been a second copy of it, so it lives here once and both mount it.
 *
 * What stays outside: the choice of *where* this sits and how wide it is. The
 * embedding surface owns its own chrome and passes a class name.
 */

import React, { useEffect, useMemo } from 'react';
import { useAtomValue, useStore } from 'jotai';
import type { TeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

import { settingAtom } from '../../store/atoms/settingAtomFamily';
import {
  feedbackRequestStateForTargetAtomFamily,
  feedbackRequestTargetKey,
} from '../../store/atoms/feedbackRequests';
import type {
  FeedbackRequestCommentIpcRequest,
  FeedbackRequestServiceState,
  FeedbackRequestServiceTarget,
} from '../../../shared/feedbackRequest';
import { CommentThread } from '../Comments/CommentThread';
import type { CommentCapabilities } from '../Comments/commentTypes';
import { FeedbackRequestRespond } from './FeedbackRequestRespond';
import { FeedbackRequestResults } from './FeedbackRequestResults';
import { createFeedbackRespondHost } from './createFeedbackRespondHost';
import {
  createFeedbackResultsHost,
  startFeedbackRequestSync,
} from './createFeedbackResultsHost';
import { createFeedbackDiscussionAdapter } from './feedbackDiscussionAdapter';
import { useFeedbackArtifactActionResolver } from './feedbackArtifactActions';
import { renderLazyFeedbackOptionPreview } from './lazyFeedbackOptionPreview';
import { feedbackRequestViewMode } from './feedbackRequestViewMode';

export interface FeedbackRequestSurfaceProps {
  /** Workspace whose team JWT backs the request room. */
  workspacePath: string;
  orgId: string;
  requestId: string;
  /**
   * Team identity to fall back on until main reports the projection's own
   * viewer. A surface that already knows who is looking (an inbox delivery, the
   * index's active viewer) hands it over so the first paint is not anonymous.
   */
  teamMemberId?: TeamMemberId;
  /** Names the discussion in its own chrome; the request card carries the title. */
  title?: string;
  /** False where the viewer may read but not post. */
  canComment?: boolean;
  /**
   * `'respond'` pins the recipient card — the Inbox does, because a delivery is
   * an ask addressed to you and flipping it to tallies mid-read would move the
   * answer controls out from under the reader. `'auto'` shows tallies to anyone
   * who owes nothing.
   */
  view?: 'auto' | 'respond';
  className?: string;
  /** Height for the embedded discussion; surfaces differ in how much they can give it. */
  discussionClassName?: string;
}

const DEFAULT_DISCUSSION_CLASS = 'h-[320px] min-h-[240px]';

export function FeedbackRequestSurface({
  workspacePath,
  orgId,
  requestId,
  teamMemberId: teamMemberIdProp,
  title,
  canComment = true,
  view = 'auto',
  className = '',
  discussionClassName = DEFAULT_DISCUSSION_CLASS,
}: FeedbackRequestSurfaceProps) {
  const target = useMemo<FeedbackRequestServiceTarget>(
    () => ({ workspacePath, orgId, requestId }),
    [workspacePath, orgId, requestId],
  );
  const targetStore = useStore();
  const state = useAtomValue(
    feedbackRequestStateForTargetAtomFamily(feedbackRequestTargetKey(target)),
  );
  const teamMemberId = state.teamMemberId || teamMemberIdProp || '';
  const respondHost = useMemo(
    () => createFeedbackRespondHost({ target }),
    [target],
  );
  const resultsHost = useMemo(
    () => createFeedbackResultsHost({ target }),
    [target],
  );
  const viewerActor = useMemo(() => ({
    kind: 'user' as const,
    userId: teamMemberId,
    onBehalfOfUserId: teamMemberId,
  }), [teamMemberId]);
  const capabilities = useMemo<CommentCapabilities>(() => ({
    read: true,
    comment: canComment && state.request?.lifecycle.status === 'open',
    react: false,
    editOwn: false,
    deleteOwn: false,
    moderate: false,
    manageRoom: false,
  }), [canComment, state.request?.lifecycle.status]);
  const adapter = useMemo(
    () => createFeedbackDiscussionAdapter({
      target,
      viewerActor,
      capabilities,
      store: targetStore,
      post: (input) => {
        const request: FeedbackRequestCommentIpcRequest = {
          target,
          clientMutationId: input.clientMutationId,
          body: input.body,
          replyToCommentId: input.replyToCommentId,
        };
        return window.electronAPI.invoke('feedback-request:comment', request);
      },
    }),
    [capabilities, target, targetStore, viewerActor],
  );
  const directory = useMemo(() => ({
    people: [{
      userId: teamMemberId,
      displayName: 'You',
      handle: 'you',
      avatarInitials: 'YO',
    }],
    agents: [],
    displayNames: { [teamMemberId]: 'You' },
  }), [teamMemberId]);
  const density = useAtomValue(settingAtom('team.messages.density'));

  useEffect(() => {
    void startFeedbackRequestSync(target);
  }, [target]);

  const resolveArtifactAction = useFeedbackArtifactActionResolver(workspacePath);

  const mode = view === 'respond'
    ? 'respond'
    : feedbackRequestViewMode(state.request, teamMemberId);
  const resolvedState: FeedbackRequestServiceState | null = state.teamMemberId
    ? { ...state, teamMemberId: state.teamMemberId }
    : null;

  const discussion = (
    <div className={`feedback-request-discussion-thread ${discussionClassName}`}>
      <CommentThread
        adapter={adapter}
        capabilities={capabilities}
        context={{
          conversationId: requestId,
          conversationTitle: title,
          agentPostingEnabled: false,
          attachedAgentSessionIds: [],
          surfaceLabel: title ?? 'Feedback request',
        }}
        directory={directory}
        orgId={orgId}
        viewerUserId={teamMemberId}
        viewerActor={viewerActor}
        emptyLabel="No discussion yet."
        density={density}
      />
    </div>
  );

  return (
    <div
      className={`feedback-request-surface ${className}`}
      data-testid="feedback-request-surface"
      data-component="FeedbackRequestSurface"
      data-view={mode}
    >
      {mode === 'respond' && resolvedState
        ? (
          <FeedbackRequestRespond
            state={resolvedState}
            host={respondHost}
            resolveArtifactAction={resolveArtifactAction}
            renderOptionPreview={renderLazyFeedbackOptionPreview}
            discussion={discussion}
          />
        )
        : (
          <>
            <FeedbackRequestResults
              target={target}
              host={resultsHost}
              resolveArtifactAction={resolveArtifactAction}
            />
            {/* The results card has no discussion slot of its own, so it is
                stacked below rather than threaded through it. */}
            <div className="feedback-request-surface-discussion mt-3">
              {discussion}
            </div>
          </>
        )}
    </div>
  );
}
