/**
 * The IPC-backed compose host: what "send" actually does.
 *
 * Same split as `createFeedbackRespondHost` and `createFeedbackResultsHost` --
 * the compose widget renders a draft and calls a host method; nothing in it
 * knows an IPC channel name, an org member id, or a tab key.
 *
 * Three ordering rules carry this module, and none of them is visible in the
 * widget:
 *
 * 1. **Publish only what the author confirmed, and only refs that are actually
 *    subjects of this request.** The draft gate already scopes the confirmation
 *    to the exact list the author was shown; this re-checks the payload against
 *    its own subjects so a stale or hand-built payload cannot publish something
 *    the author never saw.
 * 2. **Nothing is published until every confirmed ref is known to be
 *    publishable.** A request whose subjects are half-published and never sent
 *    is worse than one that refuses up front, so send runs in two passes:
 *    prepare every confirmed ref first (which is where the author walks through
 *    the real share-to-team dialog for a local file), then run them. An author
 *    who shares two mockups and closes the dialog on the third leaves nothing
 *    behind. Publishing itself, and what each kind means, lives in
 *    `publishFeedbackSubject`.
 * 3. **The results tab opens only after the server accepted the request.** A
 *    failed send leaves the draft where it is (the widget keeps it) and opens
 *    nothing, so retrying is the obvious next move.
 *
 * Fire-and-forget by construction: `create` returns as soon as the room
 * acknowledges, and no part of this waits on a recipient.
 */

import type { ResourceRef } from '@nimbalyst/collab-protocol';
import type {
  FeedbackComposeSendPayload,
  FeedbackRequestSendResult,
} from '@nimbalyst/runtime/ui/AgentTranscript/components/CustomToolWidgets/InteractiveWidgetHost';
import { store } from '@nimbalyst/runtime/store';

import type {
  FeedbackRequestCreateIpcRequest,
  FeedbackRequestServiceTarget,
} from '../../../shared/feedbackRequest';
import { feedbackRequestConsoleUrl } from '../../../shared/feedbackRequestLinks';
import { selectedWorkstreamAtom } from '../../store/atoms/sessions';
import { openFeedbackRequestResults, type FeedbackRequestTabRef } from './feedbackRequestTab';
import {
  isPublishableSubjectKind,
  prepareFeedbackSubjectPublish,
  unpublishableSubjectMessage,
  type FeedbackPublishOutcome,
  type FeedbackPublishPlan,
} from './publishFeedbackSubject';

export type { FeedbackPublishOutcome, FeedbackPublishPlan };

type Invoke = (channel: string, request: unknown) => Promise<unknown>;

export interface FeedbackComposeHostConfig {
  workspacePath: string;
  /** The drafting session; it becomes the request's author and its wake target. */
  sessionId: string;
  sessionName?: string;
  invoke?: Invoke;
  prepareSubject?: (ref: ResourceRef) => Promise<FeedbackPublishPlan>;
  openResults?: (ref: FeedbackRequestTabRef) => void;
  createRequestId?: () => string;
  createMutationId?: () => string;
}

export interface FeedbackComposeHost {
  send(payload: FeedbackComposeSendPayload): Promise<FeedbackRequestSendResult>;
  cancel(draftId: string): Promise<void>;
}

function randomId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function refKey(ref: ResourceRef): string {
  return `${ref.kind}:${ref.sourceId}`;
}

/**
 * The results tab lives in the workstream tab strip, so it needs a mounted
 * workstream. Imperative open on purpose -- projecting the request back into
 * `openResources` is the bridge that resurrects closed tracker tabs.
 */
function defaultOpenResults(workspacePath: string, ref: FeedbackRequestTabRef): void {
  const selection = workspacePath ? store.get(selectedWorkstreamAtom(workspacePath)) : null;
  if (!selection?.id) return;
  openFeedbackRequestResults({ ...ref, workstreamId: selection.id });
}

export function createFeedbackComposeHost(
  config: FeedbackComposeHostConfig,
): FeedbackComposeHost {
  const invoke: Invoke = config.invoke
    ?? ((channel, request) => window.electronAPI.invoke(channel, request));
  const prepareSubject = config.prepareSubject
    ?? ((ref: ResourceRef) =>
      prepareFeedbackSubjectPublish(ref, { workspacePath: config.workspacePath }));
  const openResults = config.openResults
    ?? ((ref: FeedbackRequestTabRef) => defaultOpenResults(config.workspacePath, ref));
  const newRequestId = config.createRequestId ?? (() => randomId('feedback-request'));
  const newMutationId = config.createMutationId ?? (() => randomId('feedback-compose'));

  return {
    async send(payload: FeedbackComposeSendPayload): Promise<FeedbackRequestSendResult> {
      if (!payload.orgId) {
        return { success: false, error: 'This workspace has no team to send the request to.' };
      }
      if (!config.workspacePath) {
        return { success: false, error: 'This session has no workspace to send from.' };
      }

      const subjectKeys = new Set(payload.subjects.map((subject) => refKey(subject.ref)));
      const stray = payload.publishSubjectRefs.find((ref) => !subjectKeys.has(refKey(ref)));
      if (stray) {
        return {
          success: false,
          error: `${stray.sourceId} is not one of this request's subjects, so it was not published.`,
        };
      }

      const unpublishable = payload.publishSubjectRefs.filter(
        (ref) => !isPublishableSubjectKind(ref.kind),
      );
      if (unpublishable.length > 0) {
        return {
          success: false,
          error: [...new Set(unpublishable.map(unpublishableSubjectMessage))].join(' '),
        };
      }

      // Pass one: everything the author has to answer, before anything is
      // created. Preparing a file opens the share dialog, so a cancel here
      // costs the author nothing but the dialog they just closed.
      const plans: Array<{ ref: ResourceRef; plan: FeedbackPublishPlan }> = [];
      for (const ref of payload.publishSubjectRefs) {
        let plan: FeedbackPublishPlan;
        try {
          plan = await prepareSubject(ref);
        } catch (error) {
          plan = {
            status: 'blocked',
            error: error instanceof Error ? error.message : `${ref.sourceId} could not be published.`,
          };
        }
        if (plan.status !== 'ready') return { success: false, error: plan.error };
        plans.push({ ref, plan });
      }

      // Pass two: publish. A file turns into a shared document, so the ref the
      // request carries is the published one -- a recipient cannot resolve a
      // path on the author's disk.
      const publishedRefs = new Map<string, ResourceRef>();
      for (const { ref, plan } of plans) {
        if (plan.status !== 'ready') continue;
        let outcome: FeedbackPublishOutcome;
        try {
          outcome = await plan.run();
        } catch (error) {
          outcome = {
            success: false,
            error: error instanceof Error ? error.message : `${ref.sourceId} could not be published.`,
          };
        }
        // A later failure leaves the earlier publishes standing. That is on
        // purpose: they are what the author asked for, publishing is
        // idempotent, and re-sending reuses them instead of duplicating them.
        if (!outcome.success) return { success: false, error: outcome.error };
        if (outcome.ref) publishedRefs.set(refKey(ref), outcome.ref);
      }
      // The published ref replaces the local one; the author's label rides
      // through untouched, because it is the only thing a recipient who never
      // synced the project can read.
      const republish = <T extends { ref: ResourceRef }>(artifact: T): T => {
        const published = publishedRefs.get(refKey(artifact.ref));
        return published ? { ...artifact, ref: published } : artifact;
      };
      const subjects = payload.subjects.map(republish);
      // Option-bound artifacts carry their own copy of the ref, so a rewrite
      // that stopped at `subjects` would leave every option card pointing at a
      // path on the author's disk.
      const asks = payload.asks.map((ask) =>
        'artifacts' in ask && ask.artifacts?.length
          ? { ...ask, artifacts: ask.artifacts.map(republish) }
          : ask);

      const requestId = newRequestId();
      const target: FeedbackRequestServiceTarget = {
        workspacePath: config.workspacePath,
        orgId: payload.orgId,
        requestId,
      };
      const request: FeedbackRequestCreateIpcRequest = {
        target,
        clientMutationId: newMutationId(),
        request: {
          id: requestId,
          orgId: payload.orgId,
          author: {
            kind: 'agent',
            sessionId: config.sessionId,
            ...(config.sessionName ? { sessionName: config.sessionName } : {}),
          },
          subjects,
          asks,
          recipients: payload.recipients,
          assignments: payload.assignments,
          visibility: payload.visibility,
          wakePolicy: payload.wakePolicy,
          quorum: payload.quorum,
          ...(payload.deadline !== undefined ? { deadline: payload.deadline } : {}),
        },
      };

      try {
        await invoke('feedback-request:create', request);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'The request could not be sent.',
        };
      }

      openResults({ orgId: payload.orgId, requestId });
      // The confirmation's copy action. A recipient without the desktop app is
      // reached by this link or by nothing, so it is minted on the send path
      // rather than left to a surface to assemble.
      return {
        success: true,
        requestId,
        shareUrl: feedbackRequestConsoleUrl(payload.orgId, requestId),
      };
    },

    /**
     * Nothing to undo: `RequestFeedback` is non-blocking and already returned
     * its draft, and no server object exists until send. The widget discards
     * its own draft; this exists so the widget's cancel path is a decision
     * rather than a missing method.
     */
    async cancel(_draftId: string): Promise<void> {},
  };
}
