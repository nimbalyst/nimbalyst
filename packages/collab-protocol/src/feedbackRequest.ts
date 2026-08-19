/**
 * Feedback Request resource contract.
 *
 * A feedback request is organization-scoped customer data. The server stores
 * it in its own Durable Object; messages and documents may reference it, but do
 * not own it. Team collaboration callers authenticate with a team JWT.
 */

import type { Actor, ResourceRef, RichCommentBody } from "./comments.js";
import { MAX_RICH_COMMENT_BODY_ENVELOPE_BYTES } from "./comments.js";
import type {
  StructuredInputAnswerByType,
  StructuredInputFieldByType,
  StructuredInputFieldType,
} from "./structuredInput.js";

export type FeedbackRequestUrn = `nimbalyst://feedback-request/${string}`;

const FEEDBACK_REQUEST_URN_PREFIX = "nimbalyst://feedback-request/";

/** Maximum trimmed string length accepted for an incoming edit-text answer. */
export const MAX_FEEDBACK_TEXT_ANSWER_LENGTH = 32 * 1024;

export function getFeedbackTextAnswerMaxLength(
  configuredMaxLength?: number
): number {
  return Math.min(
    configuredMaxLength ?? MAX_FEEDBACK_TEXT_ANSWER_LENGTH,
    MAX_FEEDBACK_TEXT_ANSWER_LENGTH
  );
}

export function feedbackRequestUrn(requestId: string): FeedbackRequestUrn {
  return `${FEEDBACK_REQUEST_URN_PREFIX}${encodeURIComponent(requestId)}`;
}

export function parseFeedbackRequestUrn(urn: string): string | null {
  if (!urn.startsWith(FEEDBACK_REQUEST_URN_PREFIX)) return null;
  const encodedId = urn.slice(FEEDBACK_REQUEST_URN_PREFIX.length);
  if (!encodedId || encodedId.includes("/")) return null;
  try {
    const requestId = decodeURIComponent(encodedId);
    return requestId || null;
  } catch {
    return null;
  }
}

/**
 * A resource the request points at, carried with the display metadata the
 * author stamped on it at send time.
 *
 * The label is not a convenience. It follows `BoundedPreview` for the same
 * reason `BoundedPreview` exists: the recipient may have never synced the
 * project the resource lives in, so nothing on their side can derive a title
 * from the ref. Worse, publishing rewrites a `file` ref to the created
 * `document`, so by the time a subject reaches a recipient its `sourceId` is an
 * opaque document id. A surface holding only the ref can render an identifier
 * and nothing else.
 */
export interface FeedbackArtifact {
  ref: ResourceRef;
  /** Author-stamped title. Never derived from the ref by the recipient. */
  label: string;
  /** Muted second line, e.g. the containing folder. */
  context?: string;
}

/**
 * A `FeedbackArtifact` bound to one entry of a select-like ask, which is what
 * makes "pick one of these three mockups" a visual question rather than three
 * strings.
 *
 * Bound by id from outside the entry rather than by a field inside it, because
 * `StructuredInputSingleSelectOption` and `StructuredInputReorderItem` share
 * nothing but an `id` -- and because those types live in `structuredInput.ts`,
 * which is deliberately free of any collaboration dependency so local prompts
 * can reuse it. A `ResourceRef` inside an option would take that away.
 */
export interface FeedbackAskArtifact extends FeedbackArtifact {
  /** A `singleSelect` option id or a `reorder` item id. */
  entryId: string;
}

/**
 * Ask types that can carry per-entry artifacts. `multiSelect` is excluded: an
 * artifact per checkbox row has no scenario behind it, and adding one later is
 * additive.
 */
export type FeedbackArtifactBearingAskType = "singleSelect" | "reorder";

/**
 * Accepts a subject stored before subjects carried display metadata and gives
 * it the shape the current surfaces read. A legacy row is a bare `ResourceRef`,
 * so its best available label is its own `sourceId` -- which is exactly the
 * opaque-id rendering this type exists to end, and is therefore a floor rather
 * than something to be satisfied with.
 */
export function normalizeFeedbackArtifact(
  subject: FeedbackArtifact | ResourceRef
): FeedbackArtifact {
  if ("ref" in subject) return subject;
  return { ref: subject, label: subject.sourceId };
}

export interface FeedbackRatingAsk {
  type: "rating";
  id: string;
  label: string;
  description: string;
  min: number;
  max: number;
  step?: number;
  initialValue?: number;
  minLabel?: string;
  maxLabel?: string;
}

type FeedbackStructuredAskForType<Type extends StructuredInputFieldType> = Omit<
  StructuredInputFieldByType[Type],
  "description"
> & {
  description: string;
} & (Type extends FeedbackArtifactBearingAskType
    ? { artifacts?: FeedbackAskArtifact[] }
    : unknown);

export type FeedbackAskByType = {
  [Type in StructuredInputFieldType]: FeedbackStructuredAskForType<Type>;
} & {
  rating: FeedbackRatingAsk;
};

export type FeedbackAskType = keyof FeedbackAskByType;
export type FeedbackAsk = FeedbackAskByType[FeedbackAskType];

export type FeedbackAnswerByType = StructuredInputAnswerByType & {
  rating: { type: "rating"; value: number };
};

export type FeedbackAnswer = FeedbackAnswerByType[FeedbackAskType];

export interface FeedbackRequestRecipient {
  /** Org-scoped member id, as carried by a team JWT. */
  userId: string;
  /** Resolved member name shown to the author and recipient. */
  name: string;
}

/**
 * Assignment targets stay discriminated so a future role target can resolve to
 * multiple recipients without changing the surrounding assignment shape.
 */
export type FeedbackAskAssignmentTarget = {
  kind: "user";
  userId: string;
};

export interface FeedbackAskAssignment {
  askId: string;
  target: FeedbackAskAssignmentTarget;
}

export type FeedbackRequestLifecycleStatus =
  | "open"
  | "closed"
  | "expired"
  | "cancelled";

export interface FeedbackRequestLifecycle {
  status: FeedbackRequestLifecycleStatus;
  changedAt: number;
}

export type FeedbackRequestVisibility = "hiddenUntilAnswered" | "open";

/** The only automatic wake rule; a nudge is an explicit wire action. */
export type FeedbackRequestWakePolicy = "quorumOrClose";

export interface FeedbackRequestQuorum {
  /** Recipients count only after answering every ask assigned to them. */
  requiredRecipientCount: number;
}

export interface FeedbackDiscussionComment {
  id: string;
  actor: Actor;
  body: RichCommentBody;
  createdAt: number;
  editedAt?: number;
  deletedAt?: number;
  replyToCommentId?: string;
}

/**
 * Server-stamped fields on a stored comment -- id, actor, timestamps, reply
 * target -- rounded up. Charged alongside the client's body so a flood of empty
 * comments is measured at what it actually costs the row, and so the budget can
 * be checked before the comment is built.
 */
const FEEDBACK_DISCUSSION_COMMENT_OVERHEAD_BYTES = 320;

const feedbackUtf8Encoder = new TextEncoder();

function jsonByteLength(value: unknown): number | null {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined
      ? null
      : feedbackUtf8Encoder.encode(encoded).byteLength;
  } catch {
    return null;
  }
}

/**
 * Plaintext bytes the discussion would occupy once `incomingBody` is stored.
 *
 * `incomingBody` is untrusted and measured before validation, so an
 * unserializable body is charged the largest body a valid one could be rather
 * than passing free; validation rejects it a moment later either way.
 */
export function measureFeedbackDiscussionBytes(
  discussion: readonly FeedbackDiscussionComment[],
  incomingBody: unknown,
): number {
  return (
    (jsonByteLength(discussion) ?? 0)
    + (jsonByteLength(incomingBody) ?? MAX_RICH_COMMENT_BODY_ENVELOPE_BYTES)
    + FEEDBACK_DISCUSSION_COMMENT_OVERHEAD_BYTES
  );
}

type FeedbackResponseForType<Type extends FeedbackAskType> = {
  id: string;
  requestId: string;
  askId: string;
  /** Stamped from the responding member's team JWT. */
  recipientUserId: string;
  answer: FeedbackAnswerByType[Type];
  createdAt: number;
  updatedAt: number;
};

/** One discriminated response per recipient per ask. */
export type FeedbackResponse = {
  [Type in FeedbackAskType]: FeedbackResponseForType<Type>;
}[FeedbackAskType];

export interface FeedbackRequest {
  id: string;
  urn: FeedbackRequestUrn;
  orgId: string;
  author: Actor;
  subjects: FeedbackArtifact[];
  asks: FeedbackAsk[];
  recipients: FeedbackRequestRecipient[];
  assignments: FeedbackAskAssignment[];
  responses: FeedbackResponse[];
  discussion: FeedbackDiscussionComment[];
  lifecycle: FeedbackRequestLifecycle;
  visibility: FeedbackRequestVisibility;
  wakePolicy: FeedbackRequestWakePolicy;
  quorum: FeedbackRequestQuorum;
  deadline?: number;
  createdAt: number;
  updatedAt: number;
}

export interface FeedbackRequestProgress {
  answeredAskCount: number;
  totalAssignedAskCount: number;
  answeredRecipientCount: number;
  totalRecipientCount: number;
  quorumReached: boolean;
}

/**
 * Small org-index projection used to enumerate feedback requests without
 * opening every request room. Rich request content deliberately stays in the
 * request Durable Object and is fetched only when a participant opens it.
 */
export interface FeedbackRequestIndexEntry {
  requestId: string;
  urn: FeedbackRequestUrn;
  orgId: string;
  /** Stable list title derived from the request's first ask or subject. */
  title: string;
  author: Actor;
  recipients: FeedbackRequestRecipient[];
  lifecycle: FeedbackRequestLifecycle;
  progress: FeedbackRequestProgress;
  /** Frozen resource labels are preserved so the index is useful offline. */
  subjects: FeedbackArtifact[];
  createdAt: number;
  updatedAt: number;
  /** Terminal lifecycle timestamp; omitted while the request is open. */
  closedAt?: number;
}

export type FeedbackResponseValidationErrorCode =
  | "requestMismatch"
  | "requestNotOpen"
  | "unknownAsk"
  | "unknownRecipient"
  | "askNotAssigned"
  | "answerTypeMismatch"
  | "invalidAnswer";

/**
 * Request-level and response-level validation share one result shape so a
 * caller can surface either without branching on which check produced it.
 */
export interface FeedbackValidationError<Code extends string> {
  code: Code;
  message: string;
}

export interface FeedbackValidationResult<Code extends string> {
  valid: boolean;
  errors: FeedbackValidationError<Code>[];
}

export type FeedbackResponseValidationError =
  FeedbackValidationError<FeedbackResponseValidationErrorCode>;

export type FeedbackResponseValidationResult =
  FeedbackValidationResult<FeedbackResponseValidationErrorCode>;

export type FeedbackRequestValidationErrorCode =
  | "quorumBelowOne"
  | "quorumExceedsRecipients"
  | "duplicateAsk"
  | "duplicateRecipient"
  | "duplicateAssignment"
  | "unknownAssignedAsk"
  | "orphanedAssignment"
  | "recipientWithoutAsks"
  | "unknownArtifactEntry"
  | "duplicateArtifactEntry";

export type FeedbackRequestValidationError =
  FeedbackValidationError<FeedbackRequestValidationErrorCode>;

export type FeedbackRequestValidationResult =
  FeedbackValidationResult<FeedbackRequestValidationErrorCode>;

/**
 * The structural subset quorum reachability depends on, so the creating client
 * and the server DO run the same check against a create input and a stored
 * request alike.
 */
export type FeedbackRequestQuorumShape = Pick<
  FeedbackRequest,
  "asks" | "recipients" | "assignments" | "quorum"
>;

/**
 * The structural subset "which asks belong to this person" depends on, so the
 * respond surface can ask the question of a read model whose responses have
 * been withheld or anonymized server-side.
 */
export type FeedbackRequestAssignmentShape = Pick<
  FeedbackRequest,
  "asks" | "assignments"
>;

function assignedAskIdsForRecipient(
  request: Pick<FeedbackRequest, "assignments">,
  recipientUserId: string
): Set<string> {
  return new Set(
    request.assignments
      .filter(
        (assignment) =>
          assignment.target.kind === "user" &&
          assignment.target.userId === recipientUserId
      )
      .map((assignment) => assignment.askId)
  );
}

function answeredAskIdsForRecipient(
  request: FeedbackRequest,
  recipientUserId: string
): Set<string> {
  return new Set(
    request.responses
      .filter((response) => response.recipientUserId === recipientUserId)
      .map((response) => response.askId)
  );
}

/**
 * The asks one person is being asked, in the request's own ask order.
 *
 * Every surface that shows a recipient their asks resolves them through here
 * rather than filtering assignments inline: a per-surface filter is a place for
 * someone else's ask to leak into a view, and the request's ask order is what
 * keeps the Q1/Q2 numbering stable no matter what order assignments arrived in.
 */
export function getFeedbackAsksForRecipient(
  request: FeedbackRequestAssignmentShape,
  recipientUserId: string
): FeedbackAsk[] {
  const assignedAskIds = assignedAskIdsForRecipient(request, recipientUserId);
  return request.asks.filter((ask) => assignedAskIds.has(ask.id));
}

export function hasRecipientAnsweredAssignedAsks(
  request: FeedbackRequest,
  recipientUserId: string
): boolean {
  const assignedAskIds = assignedAskIdsForRecipient(request, recipientUserId);
  if (assignedAskIds.size === 0) return false;
  const answeredAskIds = answeredAskIdsForRecipient(request, recipientUserId);
  return [...assignedAskIds].every((askId) => answeredAskIds.has(askId));
}

export function getFeedbackRequestProgress(
  request: FeedbackRequest
): FeedbackRequestProgress {
  const assignedByRecipient = new Map<string, Set<string>>();
  for (const assignment of request.assignments) {
    if (assignment.target.kind !== "user") continue;
    const assigned = assignedByRecipient.get(assignment.target.userId);
    if (assigned) assigned.add(assignment.askId);
    else {
      assignedByRecipient.set(
        assignment.target.userId,
        new Set([assignment.askId])
      );
    }
  }

  const answeredAssignments = new Set<string>();
  const answeredByRecipient = new Map<string, Set<string>>();
  for (const response of request.responses) {
    if (!assignedByRecipient.get(response.recipientUserId)?.has(response.askId)) {
      continue;
    }
    answeredAssignments.add(`${response.recipientUserId}\u0000${response.askId}`);
    const answered = answeredByRecipient.get(response.recipientUserId);
    if (answered) answered.add(response.askId);
    else {
      answeredByRecipient.set(
        response.recipientUserId,
        new Set([response.askId])
      );
    }
  }

  const answeredRecipientCount = request.recipients.filter((recipient) => {
    const assigned = assignedByRecipient.get(recipient.userId);
    if (!assigned || assigned.size === 0) return false;
    const answered = answeredByRecipient.get(recipient.userId);
    return !!answered && [...assigned].every((askId) => answered.has(askId));
  }).length;

  return {
    answeredAskCount: answeredAssignments.size,
    totalAssignedAskCount: request.assignments.length,
    answeredRecipientCount,
    totalRecipientCount: request.recipients.length,
    quorumReached:
      answeredRecipientCount >= request.quorum.requiredRecipientCount,
  };
}

/**
 * Rejects requests whose quorum is arithmetically wrong at birth. Nothing
 * downstream re-checks this: an unreachable quorum is accepted, never
 * completes, and the author's session is never woken.
 */
/**
 * The selectable entry ids of an ask, in display order, or `null` for an ask
 * type that has no entries. `null` rather than `[]` so a caller can tell "this
 * ask cannot carry artifacts" apart from "this ask has none".
 */
export function feedbackAskEntryIds(ask: FeedbackAsk): string[] | null {
  if (ask.type === "singleSelect") return ask.options.map((option) => option.id);
  if (ask.type === "reorder") return ask.items.map((item) => item.id);
  return null;
}

/**
 * An artifact bound to an entry the ask does not define would render nowhere,
 * and the author would never see that it failed -- the card would simply look
 * the way it looks today. So it is rejected at validation rather than dropped.
 */
function feedbackAskArtifactErrors(
  ask: FeedbackAsk
): FeedbackRequestValidationError[] {
  const artifacts = "artifacts" in ask ? ask.artifacts : undefined;
  if (!artifacts?.length) return [];

  const errors: FeedbackRequestValidationError[] = [];
  const entryIds = new Set(feedbackAskEntryIds(ask) ?? []);
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    if (!entryIds.has(artifact.entryId)) {
      errors.push({
        code: "unknownArtifactEntry",
        message: `Ask ${ask.id} binds an artifact to entry ${artifact.entryId}, which the ask does not define.`,
      });
    }
    if (seen.has(artifact.entryId)) {
      errors.push({
        code: "duplicateArtifactEntry",
        message: `Ask ${ask.id} binds more than one artifact to entry ${artifact.entryId}.`,
      });
    }
    seen.add(artifact.entryId);
  }
  return errors;
}

export function validateFeedbackRequest(
  request: FeedbackRequestQuorumShape
): FeedbackRequestValidationResult {
  const errors: FeedbackRequestValidationError[] = [];

  const askIds = new Set<string>();
  for (const ask of request.asks) {
    if (askIds.has(ask.id)) {
      errors.push({
        code: "duplicateAsk",
        message: `Ask ${ask.id} is defined more than once.`,
      });
    }
    askIds.add(ask.id);
    errors.push(...feedbackAskArtifactErrors(ask));
  }
  const recipientIds = new Set<string>();
  for (const recipient of request.recipients) {
    if (recipientIds.has(recipient.userId)) {
      errors.push({
        code: "duplicateRecipient",
        message: `Recipient ${recipient.userId} is listed more than once and would count toward quorum twice.`,
      });
    }
    recipientIds.add(recipient.userId);
  }

  const assignedRecipientIds = new Set<string>();
  const assignmentKeys = new Set<string>();
  for (const assignment of request.assignments) {
    if (!askIds.has(assignment.askId)) {
      errors.push({
        code: "unknownAssignedAsk",
        message: `Assignment references ask ${assignment.askId}, which the request does not define.`,
      });
    }
    if (assignment.target.kind !== "user") continue;
    const assignmentKey = `${assignment.target.userId}\u0000${assignment.askId}`;
    if (assignmentKeys.has(assignmentKey)) {
      errors.push({
        code: "duplicateAssignment",
        message: `Ask ${assignment.askId} is assigned to ${assignment.target.userId} more than once.`,
      });
    }
    assignmentKeys.add(assignmentKey);
    if (recipientIds.has(assignment.target.userId)) {
      assignedRecipientIds.add(assignment.target.userId);
    } else {
      errors.push({
        code: "orphanedAssignment",
        message: `Ask ${assignment.askId} is assigned to ${assignment.target.userId}, who is not a recipient.`,
      });
    }
  }

  // A recipient with no assigned asks is rejected rather than dropped from the
  // quorum denominator: silently shrinking "quorum of 3" to two people is the
  // same missed wake-up this check exists to prevent, only harder to notice.
  for (const userId of recipientIds) {
    if (assignedRecipientIds.has(userId)) continue;
    errors.push({
      code: "recipientWithoutAsks",
      message: `Recipient ${userId} has no assigned asks and can never count toward quorum.`,
    });
  }

  const { requiredRecipientCount } = request.quorum;
  if (requiredRecipientCount < 1) {
    // Zero makes quorumReached true before anyone answers, waking the author
    // on an empty result set.
    errors.push({
      code: "quorumBelowOne",
      message: "Quorum must require at least one recipient.",
    });
  } else if (requiredRecipientCount > recipientIds.size) {
    errors.push({
      code: "quorumExceedsRecipients",
      message: `Quorum requires ${requiredRecipientCount} recipients but the request has ${recipientIds.size}.`,
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Everything a response check reads. Stored responses are deliberately absent:
 * a client holding a viewer-filtered read model must still be able to run the
 * same assignment check the server runs, and re-answering an ask is a replace
 * rather than a conflict.
 */
export type FeedbackResponseValidationShape = Pick<
  FeedbackRequest,
  "id" | "asks" | "recipients" | "assignments" | "lifecycle"
>;

function feedbackAnswerIsValid(
  ask: FeedbackAsk,
  answerValue: unknown
): boolean {
  if (!answerValue || typeof answerValue !== "object") return false;
  const answer = answerValue as Record<string, unknown>;
  if (answer.type !== ask.type) return false;

  switch (ask.type) {
    case "singleSelect": {
      if (typeof answer.selectedId !== "string") return false;
      if (ask.options.some((option) => option.id === answer.selectedId)) {
        return answer.otherText === undefined || typeof answer.otherText === "string";
      }
      return ask.allowOther === true
        && answer.selectedId === "__other__"
        && typeof answer.otherText === "string"
        && answer.otherText.trim().length > 0;
    }
    case "multiSelect": {
      if (!Array.isArray(answer.selectedIds)
        || !answer.selectedIds.every((id) => typeof id === "string")) return false;
      const selected = answer.selectedIds as string[];
      const allowed = new Set(ask.items.map((item) => item.id));
      return new Set(selected).size === selected.length
        && selected.every((id) => allowed.has(id))
        && selected.length >= (ask.minSelected ?? 0)
        && selected.length <= (ask.maxSelected ?? ask.items.length);
    }
    case "reorder": {
      if (!Array.isArray(answer.orderedIds)
        || !Array.isArray(answer.removedIds)
        || !answer.orderedIds.every((id) => typeof id === "string")
        || !answer.removedIds.every((id) => typeof id === "string")) return false;
      const ordered = answer.orderedIds as string[];
      const removed = answer.removedIds as string[];
      const catalog = new Map(ask.items.map((item) => [item.id, item]));
      const all = [...ordered, ...removed];
      return new Set(all).size === all.length
        && all.length === catalog.size
        && all.every((id) => catalog.has(id))
        && removed.every((id) => catalog.get(id)?.removable === true)
        && ordered.length >= Math.max(ask.minItems ?? 0, 1);
    }
    case "editText": {
      if (typeof answer.text !== "string" || typeof answer.edited !== "boolean") {
        return false;
      }
      const length = answer.text.trim().length;
      return length >= (ask.minLength ?? 0)
        && length <= getFeedbackTextAnswerMaxLength(ask.maxLength);
    }
    case "confirm":
      return typeof answer.value === "boolean";
    case "rating":
      return typeof answer.value === "number"
        && Number.isFinite(answer.value)
        && answer.value >= ask.min
        && answer.value <= ask.max;
  }
}

export function validateFeedbackResponse(
  request: FeedbackResponseValidationShape,
  response: FeedbackResponse
): FeedbackResponseValidationResult {
  const errors: FeedbackResponseValidationError[] = [];
  const ask = request.asks.find((candidate) => candidate.id === response.askId);

  if (response.requestId !== request.id) {
    errors.push({
      code: "requestMismatch",
      message: "Response requestId does not match the feedback request.",
    });
  }
  if (request.lifecycle.status !== "open") {
    errors.push({
      code: "requestNotOpen",
      message: "Only open feedback requests accept responses.",
    });
  }
  if (!ask) {
    errors.push({ code: "unknownAsk", message: "Response askId is unknown." });
  }
  if (
    !request.recipients.some(
      (recipient) => recipient.userId === response.recipientUserId
    )
  ) {
    errors.push({
      code: "unknownRecipient",
      message: "Response recipient is not part of the request.",
    });
  }
  if (
    !request.assignments.some(
      (assignment) =>
        assignment.askId === response.askId &&
        assignment.target.kind === "user" &&
        assignment.target.userId === response.recipientUserId
    )
  ) {
    errors.push({
      code: "askNotAssigned",
      message: "The ask is not assigned to this recipient.",
    });
  }
  const answer = (response as { answer?: unknown }).answer;
  const answerType = answer && typeof answer === "object"
    ? (answer as { type?: unknown }).type
    : undefined;
  if (ask && ask.type !== answerType) {
    errors.push({
      code: "answerTypeMismatch",
      message: `Ask type ${ask.type} cannot accept answer type ${String(answerType)}.`,
    });
  } else if (ask && !feedbackAnswerIsValid(ask, answer)) {
    errors.push({
      code: "invalidAnswer",
      message: "Response answer does not satisfy the ask's options or bounds.",
    });
  }

  return { valid: errors.length === 0, errors };
}

export function applyFeedbackResponse(
  request: FeedbackRequest,
  response: FeedbackResponse
): FeedbackRequest {
  const validation = validateFeedbackResponse(request, response);
  if (!validation.valid) {
    throw new Error(validation.errors.map((error) => error.code).join(","));
  }

  return {
    ...request,
    responses: [
      ...request.responses.filter(
        (existing) =>
          existing.askId !== response.askId ||
          existing.recipientUserId !== response.recipientUserId
      ),
      response,
    ],
    updatedAt: response.updatedAt,
  };
}

export function transitionFeedbackRequestLifecycle(
  request: FeedbackRequest,
  status: Exclude<FeedbackRequestLifecycleStatus, "open">,
  changedAt: number
): FeedbackRequest {
  if (request.lifecycle.status !== "open") {
    throw new Error(
      `Cannot transition feedback request from ${request.lifecycle.status} to ${status}.`
    );
  }
  return {
    ...request,
    lifecycle: { status, changedAt },
    updatedAt: changedAt,
  };
}

type FeedbackResponseReadModelForType<Type extends FeedbackAskType> = Omit<
  FeedbackResponseForType<Type>,
  "recipientUserId"
> & {
  recipientUserId?: string;
};

export type FeedbackResponseReadModel = {
  [Type in FeedbackAskType]: FeedbackResponseReadModelForType<Type>;
}[FeedbackAskType];

function responseReadModel(
  response: FeedbackResponse,
  attributed: boolean
): FeedbackResponseReadModel {
  if (attributed) return response;
  const { recipientUserId: _recipientUserId, ...anonymous } = response;
  return anonymous;
}

/**
 * Applies the request's sole visibility/attribution setting to response reads.
 * Hidden results remain anonymous. A non-author sees only their own stored
 * answers until every ask assigned to them has been answered.
 */
export function getFeedbackResponsesForViewer(
  request: FeedbackRequest,
  viewerUserId: string
): FeedbackResponseReadModel[] {
  if (request.visibility === "open") {
    return request.responses.map((response) =>
      responseReadModel(response, true)
    );
  }

  const isAuthor = request.author.onBehalfOfUserId === viewerUserId;
  const canSeeAll =
    isAuthor || hasRecipientAnsweredAssignedAsks(request, viewerUserId);
  const visibleResponses = canSeeAll
    ? request.responses
    : request.responses.filter(
        (response) => response.recipientUserId === viewerUserId
      );
  return visibleResponses.map((response) => responseReadModel(response, false));
}
