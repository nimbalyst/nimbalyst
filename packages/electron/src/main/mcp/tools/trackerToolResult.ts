import { isLocalIssueKey, resolveDisplayIssueKey } from '../../../shared/localIssueKey';
import { TrackerSchemaChangeBlockedError } from '../../services/tracker/trackerSchemaChangeGuard';

export type McpToolResult = {
  content: Array<{ type: string; text?: string }>;
  isError: boolean;
};

/**
 * A tool call cannot show a modal, so the confirmation an agent needs has to be
 * something it can obtain and then state. The refusal it gets first carries the
 * blast radius counted from the real item table; this flag is the agent asserting
 * it relayed that and the user said yes. It is deliberately NOT a way past D3:
 * on a team tracker a non-admin is refused whatever this is set to.
 */
export const DESTRUCTIVE_CONFIRM_PARAM_DESCRIPTION =
  "Set only after a prior call was refused as destructive and you showed the user that refusal's blast radius and got an explicit go-ahead. " +
  "Never set it pre-emptively: without the refusal you have no blast radius to show, so there is nothing for the user to have agreed to. " +
  "Additive changes (new field, new status, new option, widened constraint) never need it. " +
  "On a team tracker, removals and renames additionally require a team admin and this flag cannot substitute for that.";

/** Map the guard rail's refusal into a tool result an agent can act on. */
export function destructiveSchemaChangeToolResult(error: TrackerSchemaChangeBlockedError): McpToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          structured: {
            action: "schema-change-blocked" as const,
            type: error.type,
            reason: error.reason,
            classification: error.decision.classification.classification,
            blastRadius: error.decision.blastRadiusText,
            changeScope: error.decision.sharing === 'team' ? 'team' : 'personal',
            // Rename first: a remove-plus-add is indistinguishable from a rename
            // without stated intent, and the user holds that intent.
            options: error.decision.copy?.options.map((option) => ({
              id: option.id,
              label: option.label,
              description: option.description,
            })),
          },
          summary: error.message,
        }),
      },
    ],
    isError: true,
  };
}

export const UNPUBLISHED_ISSUE_KEY_MESSAGE = 'This item has no key until it is published.';
const PUBLISHED_ISSUE_KEY_PENDING_MESSAGE = 'This item is published, but its server-issued key is still pending.';
const COLLABORATIVE_BODY_WRITE_FAILURE_MESSAGE =
  'The item fields and local body snapshot were saved, but the body was not stored in collaborative tracker content. Retry the body write before treating it as available to collaborators.';

export type BodyWriteFailure = {
  status: 'failed';
  itemFieldsStored: true;
  localSnapshotStored: boolean;
  collaborativeBodyStored: false;
  message: string;
};

export function bodyWriteFailure(localSnapshotStored: boolean): BodyWriteFailure {
  return {
    status: 'failed',
    itemFieldsStored: true,
    localSnapshotStored,
    collaborativeBodyStored: false,
    message: localSnapshotStored
      ? COLLABORATIVE_BODY_WRITE_FAILURE_MESSAGE
      : 'The item fields were saved, but the body write did not complete locally or in collaborative tracker content. Retry the body write before treating it as stored.',
  };
}

export function getAssignedIssueKey(item: { issueKey?: string | null }): string | undefined {
  return item.issueKey && !isLocalIssueKey(item.issueKey) ? item.issueKey : undefined;
}

/**
 * The best reference to show an agent for an item: the same precedence the
 * tracker's Key column shows, with the raw id as a last resort.
 */
export function getTrackerDisplayRef(item: { issueKey?: string; localKey?: string; id: string }): string {
  return resolveDisplayIssueKey(item) ?? item.id;
}

export function issueKeyAvailabilityNote(
  item: { issueKey?: string | null },
  published = false,
): string {
  if (getAssignedIssueKey(item)) return '';
  return `\n- **Issue key**: ${published ? PUBLISHED_ISSUE_KEY_PENDING_MESSAGE : UNPUBLISHED_ISSUE_KEY_MESSAGE}`;
}

export function issueKeyStatus(item: { issueKey?: string | null }): 'assigned' | 'unassigned' {
  return getAssignedIssueKey(item) ? 'assigned' : 'unassigned';
}
