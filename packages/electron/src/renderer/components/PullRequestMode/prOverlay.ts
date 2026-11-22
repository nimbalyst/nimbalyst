/**
 * What starting a review session writes to a PR's local overlay.
 *
 * The status is read from whichever `github-pr` schema is active: the shipped
 * builtin says `reviewing`, this repo's triage schema says `inspecting`. A
 * review never reopens an item that is already past its unstarted stage, so
 * clicking Review on a merged or rejected PR leaves its status alone.
 */

import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { getRecordStatus } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import {
  getWorkflowStatusOptions,
  resolveKnownStatusCategory,
  resolveStatusCategory,
} from '@nimbalyst/tracker-schema';

export const PR_OVERLAY_TYPE = 'github-pr';

/** Status names that mean "under review", most specific first. */
const REVIEW_STATUS_NAMES = ['reviewing', 'inspecting', 'in-review', 'in-progress'];

/**
 * The first of `names` the type's active schema offers, else its first status
 * declared (or conventionally named) as started; undefined when it has neither,
 * so the caller leaves the status alone.
 */
export function resolveStartedStatus(type: string, names: ReadonlyArray<string>): string | undefined {
  const values = getWorkflowStatusOptions(type).map((option) => option.value);
  const named = names.find((name) => values.includes(name));
  if (named) return named;
  return values.find((value) => resolveKnownStatusCategory(type, value) === 'started');
}

/** The status a review session moves a PR overlay to. */
export function resolveReviewStatus(type: string = PR_OVERLAY_TYPE): string | undefined {
  return resolveStartedStatus(type, REVIEW_STATUS_NAMES);
}

/** The PR's overlay among the items referencing it, or null. */
export function findPrOverlay(references: ReadonlyArray<TrackerRecord>): TrackerRecord | null {
  return references.find((record) => record.primaryType === PR_OVERLAY_TYPE) ?? null;
}

export interface PrReviewOverlayWrite {
  /** Status for a newly created overlay. */
  status?: string;
  /** Updates for an overlay that already exists. */
  updates?: Record<string, unknown>;
}

export function planPrReviewOverlayWrite(
  existing: TrackerRecord | null,
  reviewStatus: string | undefined,
): PrReviewOverlayWrite {
  if (!reviewStatus) return {};
  if (!existing) return { status: reviewStatus };
  const category = resolveStatusCategory(existing.primaryType, getRecordStatus(existing));
  if (category !== 'backlog' && category !== 'unstarted') return {};
  return { updates: { status: reviewStatus } };
}
