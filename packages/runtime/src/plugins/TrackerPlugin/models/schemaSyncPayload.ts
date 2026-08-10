/**
 * Wire payload for team tracker-schema sync.
 *
 * A schema definition travels between teammates as a JSON string. There are two
 * shapes:
 *
 *  - a FULL model (a custom type the team owns outright), and
 *  - a PATCH against a builtin (an override of `bug`, `task`, ...).
 *
 * Overrides of builtins must travel as a delta. A full copy freezes the type at
 * the sender's app version for the whole team: every field shipped in a later
 * builtin (Collections, the review lane, tags) becomes invisible to everyone,
 * with no warning and no way back. Sending the delta lets each peer resolve it
 * against ITS OWN builtin, so upstream improvements keep flowing (#1178).
 *
 * Old-client tolerance is deliberate: a patch payload carries no top-level
 * `type` + `fields[]`, which is exactly what a pre-patch client validates a
 * model on, so it rejects the payload and stays on its builtin rather than
 * ingesting a half-understood schema.
 */

import type { TrackerDataModel } from './TrackerDataModel';
import { isTrackerSchemaPatch, type TrackerSchemaPatch } from './schemaPatch';

/** Discriminator for a delta payload. */
export const TRACKER_SCHEMA_PATCH_PAYLOAD = 'trackerSchemaPatch';

export interface TrackerSchemaPatchPayload {
  payloadKind: typeof TRACKER_SCHEMA_PATCH_PAYLOAD;
  /** Bumped only if the delta grammar itself changes. */
  version: 1;
  patch: TrackerSchemaPatch;
}

export type DecodedTrackerSchemaPayload =
  | { kind: 'patch'; patch: TrackerSchemaPatch }
  | { kind: 'model'; model: TrackerDataModel };

/** Serialize a builtin override as a delta payload. */
export function encodeTrackerSchemaPatchPayload(patch: TrackerSchemaPatch): string {
  const payload: TrackerSchemaPatchPayload = {
    payloadKind: TRACKER_SCHEMA_PATCH_PAYLOAD,
    version: 1,
    patch,
  };
  return JSON.stringify(payload);
}

/**
 * Classify an inbound payload. Returns null when the JSON is unparseable or
 * matches neither shape — the caller drops it rather than guessing, so a
 * malformed delta can never register a broken model.
 */
export function decodeTrackerSchemaPayload(
  type: string,
  json: string,
): DecodedTrackerSchemaPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const candidate = parsed as Record<string, unknown>;
  if (candidate.payloadKind === TRACKER_SCHEMA_PATCH_PAYLOAD) {
    const patch = candidate.patch;
    if (!isTrackerSchemaPatch(patch) || patch.type !== type) return null;
    return { kind: 'patch', patch };
  }

  if (candidate.type !== type || !Array.isArray(candidate.fields)) return null;
  return { kind: 'model', model: parsed as TrackerDataModel };
}
