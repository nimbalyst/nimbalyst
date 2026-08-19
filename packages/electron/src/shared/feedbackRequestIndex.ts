import type {
  FeedbackRequestIndexEntry,
  ResourceRef,
} from '@nimbalyst/collab-protocol';
import type { TeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

export interface FeedbackRequestIndexTarget {
  workspacePath: string;
  orgId: string;
}

export interface FeedbackRequestIndexViewerTarget
  extends FeedbackRequestIndexTarget {
  teamMemberId: TeamMemberId;
}

export interface FeedbackRequestIndexSnapshotIpcRequest {
  target: FeedbackRequestIndexTarget;
  /** Team-room identity; main verifies this against a fresh team JWT. */
  teamMemberId: TeamMemberId;
  entries: FeedbackRequestIndexEntry[];
}

export interface FeedbackRequestIndexUpsertIpcRequest {
  target: FeedbackRequestIndexTarget;
  /** Team-room identity; main verifies this against a fresh team JWT. */
  teamMemberId: TeamMemberId;
  entry: FeedbackRequestIndexEntry;
}

export type FeedbackRequestSubjectRef = Pick<ResourceRef, 'kind' | 'sourceId'>;

export interface FeedbackRequestIndexSubjectIpcRequest {
  target: FeedbackRequestIndexTarget;
  subject: FeedbackRequestSubjectRef;
}

/**
 * Whether a request is about one artifact. Kind is part of the identity, not
 * decoration: a tracker item and a document can carry the same `sourceId`, and
 * matching on the id alone would show one artifact's feedback on the other.
 * Single-sourced because the main-process lookup and the renderer's atom both
 * answer this question and must never drift apart.
 */
export function feedbackRequestIndexEntryHasSubject(
  entry: Pick<FeedbackRequestIndexEntry, 'subjects'>,
  subject: FeedbackRequestSubjectRef,
): boolean {
  return entry.subjects.some(({ ref }) => (
    ref.kind === subject.kind && ref.sourceId === subject.sourceId
  ));
}

export interface FeedbackRequestIndexChangedPayload
  extends FeedbackRequestIndexViewerTarget {
  entries: FeedbackRequestIndexEntry[];
}
