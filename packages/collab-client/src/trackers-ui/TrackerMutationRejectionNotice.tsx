import React from 'react';
import type { TrackerMutationRejection } from '@nimbalyst/collab-client/trackers';

const REJECTION_EXPLANATIONS: Record<TrackerMutationRejection['code'], string> = {
  recoveryConflict: 'An older queued edit needs review against the recovered item.',
  forbidden: 'Your permission no longer allows this change.',
  staleKeyEpoch: 'The tracker encryption state changed before the server could accept this change.',
  rotationLocked: 'The tracker is temporarily locked while its encryption state changes.',
  custodyUnavailable: 'The team encryption service is unavailable for this tracker.',
  malformed: 'The server could not accept the submitted tracker data.',
  legacy_encryption_retired: 'This team must be migrated before tracker changes can be accepted.',
  issueKeyPrefixConflict: 'The tracker key prefix conflicts with another project in this team.',
  adminRequired: 'This change requires a team administrator.',
  schemaExists: 'Someone else already created a type with this name.',
  serverError: 'The server hit an error and saved nothing. Try the change again.',
};

export function formatTrackerMutationRejection(rejection: TrackerMutationRejection): string {
  const explanation = REJECTION_EXPLANATIONS[rejection.code] ?? 'The server refused this change.';
  const detail = rejection.message?.trim();
  const outcome = rejection.code === 'recoveryConflict' ? 'Queued edit retained for review.' : 'Change rolled back.';
  return `${outcome} ${explanation}${detail ? ` ${detail}` : ''}`;
}

export interface TrackerMutationRejectionNoticeProps {
  rejection: TrackerMutationRejection | null;
}

/** The visible counterpart to the engine's optimistic rollback. */
export function TrackerMutationRejectionNotice({ rejection }: TrackerMutationRejectionNoticeProps) {
  if (!rejection) return null;
  return (
    <div
      className="tracker-mutation-rejection flex items-start gap-2 border-b border-nim-error bg-[color-mix(in_srgb,var(--nim-error)_10%,transparent)] px-3 py-2 text-xs text-nim-error"
      data-rejection-code={rejection.code}
      data-item-id={rejection.itemId}
      role="alert"
    >
      <strong className="shrink-0">Server rejected the change.</strong>
      <span>{formatTrackerMutationRejection(rejection)}</span>
    </div>
  );
}
