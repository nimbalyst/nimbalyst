/**
 * The review lane on the workflow-status role.
 *
 * Work moves `in-progress` -> `in-review` -> `approved` (or back out through
 * `changes-requested`). The lane exists so a colleague reviewing your
 * implementation has a state to leave the item in that is neither "still being
 * worked" nor "done".
 *
 * The house rule this module enforces: **an agent may move an item into review,
 * but only a human may promote it past.** An agent marking its own work
 * approved would make the review lane meaningless, so `approved` is refused at
 * the agent tool boundary rather than merely discouraged in a prompt.
 */

import { getRoleField, globalRegistry } from './TrackerDataModel';

export const REVIEW_IN_REVIEW = 'in-review';
export const REVIEW_APPROVED = 'approved';
export const REVIEW_CHANGES_REQUESTED = 'changes-requested';

/** The lane, in the order a reviewer walks it. */
export const REVIEW_LANE_STATUSES = [
  REVIEW_IN_REVIEW,
  REVIEW_CHANGES_REQUESTED,
  REVIEW_APPROVED,
] as const;

/**
 * Statuses only a human may set. Kept as a set (rather than a single constant)
 * so a type that models sign-off differently can be added here without
 * reworking callers.
 */
const HUMAN_ONLY_STATUSES = new Set<string>([REVIEW_APPROVED]);

export function isReviewLaneStatus(status: string): boolean {
  return (REVIEW_LANE_STATUSES as readonly string[]).includes(status);
}

/** Whether a status is one an agent must not set on a user's behalf. */
export function isHumanOnlyStatus(status: string | undefined | null): boolean {
  return typeof status === 'string' && HUMAN_ONLY_STATUSES.has(status.trim().toLowerCase());
}

/**
 * The message an agent gets when it tries to promote its own work. Phrased as
 * the next action rather than a bare refusal, so the agent moves the item to
 * `in-review` instead of retrying.
 */
export function humanOnlyStatusMessage(status: string): string {
  return `'${status}' can only be set by a person. Move the item to '${REVIEW_IN_REVIEW}' `
    + 'and let a reviewer promote it.';
}

/** Which review-lane statuses a type actually offers, in lane order. */
export function reviewLaneFor(type: string): string[] {
  const model = globalRegistry.get(type);
  if (!model) return [];
  const fieldName = getRoleField(model, 'workflowStatus') ?? 'status';
  const options = model.fields.find((f) => f.name === fieldName)?.options ?? [];
  const values = new Set(options.map((o) => (typeof o === 'string' ? o : o.value)));
  return REVIEW_LANE_STATUSES.filter((status) => values.has(status));
}

/** Whether a type has a review lane at all. */
export function hasReviewLane(type: string): boolean {
  return reviewLaneFor(type).includes(REVIEW_IN_REVIEW);
}
