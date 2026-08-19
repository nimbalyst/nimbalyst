/**
 * FeedbackRequestRoom wire protocol.
 *
 * One team-JWT-authorized Durable Object owns each first-class feedback
 * request. The server stamps actor identity on response and discussion writes.
 */

import type { Actor, RichCommentBody } from "./comments.js";
import type {
  FeedbackAnswer,
  FeedbackArtifact,
  FeedbackAsk,
  FeedbackAskAssignment,
  FeedbackDiscussionComment,
  FeedbackRequest,
  FeedbackRequestLifecycle,
  FeedbackRequestLifecycleStatus,
  FeedbackRequestProgress,
  FeedbackRequestQuorum,
  FeedbackRequestRecipient,
  FeedbackRequestVisibility,
  FeedbackRequestWakePolicy,
  FeedbackResponse,
  FeedbackResponseReadModel,
} from "./feedbackRequest.js";

export type FeedbackRequestReadModel = Omit<FeedbackRequest, "responses"> & {
  responses: FeedbackResponseReadModel[];
};

export interface FeedbackRequestCreateInput {
  id: string;
  orgId: string;
  author: Actor;
  subjects: FeedbackArtifact[];
  asks: FeedbackAsk[];
  recipients: FeedbackRequestRecipient[];
  assignments: FeedbackAskAssignment[];
  visibility: FeedbackRequestVisibility;
  wakePolicy: FeedbackRequestWakePolicy;
  quorum: FeedbackRequestQuorum;
  deadline?: number;
}

export type FeedbackRequestClientMessage =
  | FeedbackRequestSyncMessage
  | FeedbackRequestCreateMessage
  | FeedbackResponseMessage
  | FeedbackRequestCommentMessage
  | FeedbackRequestCloseMessage
  | FeedbackRequestNudgeMessage;

/** Request the current resource projected through the caller's visibility. */
export interface FeedbackRequestSyncMessage {
  type: "feedbackRequestSync";
}

export interface FeedbackRequestCreateMessage {
  type: "feedbackRequestCreate";
  clientMutationId: string;
  request: FeedbackRequestCreateInput;
}

/** Recipient identity is server-stamped from the team JWT. */
export interface FeedbackResponseMessage {
  type: "feedbackResponse";
  clientMutationId: string;
  requestId: string;
  askId: string;
  answer: FeedbackAnswer;
}

/** Comment identity and timestamps are server-stamped from the team JWT. */
export interface FeedbackRequestCommentMessage {
  type: "feedbackRequestComment";
  clientMutationId: string;
  requestId: string;
  body: RichCommentBody;
  replyToCommentId?: string;
}

export interface FeedbackRequestCloseMessage {
  type: "feedbackRequestClose";
  clientMutationId: string;
  requestId: string;
  status: Exclude<FeedbackRequestLifecycleStatus, "open">;
}

export interface FeedbackRequestNudgeMessage {
  type: "feedbackRequestNudge";
  clientMutationId: string;
  requestId: string;
  /** Omitted to nudge every outstanding recipient. */
  recipientUserIds?: string[];
}

export type FeedbackRequestEvent =
  | { type: "feedbackRequestCreated"; request: FeedbackRequest }
  | { type: "feedbackResponse"; response: FeedbackResponse }
  | {
      type: "feedbackRequestCommented";
      requestId: string;
      comment: FeedbackDiscussionComment;
    }
  | {
      type: "feedbackRequestClosed";
      requestId: string;
      lifecycle: FeedbackRequestLifecycle;
    }
  | {
      type: "feedbackRequestNudged";
      requestId: string;
      recipientUserIds: string[];
      nudgedAt: number;
    };

export type FeedbackRequestServerMessage =
  | FeedbackRequestSnapshotMessage
  | FeedbackRequestCreateAckMessage
  | FeedbackResponseAckMessage
  | FeedbackRequestCommentAckMessage
  | FeedbackRequestCloseAckMessage
  | FeedbackRequestNudgeAckMessage
  | FeedbackRequestEventMessage
  | FeedbackRequestErrorMessage;

/** Full current state with responses filtered and attributed server-side. */
export interface FeedbackRequestSnapshotMessage {
  type: "feedbackRequestSnapshot";
  request: FeedbackRequestReadModel;
  progress: FeedbackRequestProgress;
}

export interface FeedbackRequestCreateAckMessage {
  type: "feedbackRequestCreateAck";
  clientMutationId: string;
  request: FeedbackRequestReadModel;
  replayed: boolean;
}

export interface FeedbackResponseAckMessage {
  type: "feedbackResponseAck";
  clientMutationId: string;
  response: FeedbackResponse;
  progress: FeedbackRequestProgress;
  replayed: boolean;
}

export interface FeedbackRequestCommentAckMessage {
  type: "feedbackRequestCommentAck";
  clientMutationId: string;
  requestId: string;
  comment: FeedbackDiscussionComment;
  replayed: boolean;
}

export interface FeedbackRequestCloseAckMessage {
  type: "feedbackRequestCloseAck";
  clientMutationId: string;
  request: FeedbackRequestReadModel;
  replayed: boolean;
}

export interface FeedbackRequestNudgeAckMessage {
  type: "feedbackRequestNudgeAck";
  clientMutationId: string;
  requestId: string;
  recipientUserIds: string[];
  nudgedAt: number;
  replayed: boolean;
}

export interface FeedbackRequestEventMessage {
  type: "feedbackRequestEvent";
  event: FeedbackRequestEvent;
}

export interface FeedbackRequestErrorMessage {
  type: "feedbackRequestError";
  code: string;
  message: string;
}
