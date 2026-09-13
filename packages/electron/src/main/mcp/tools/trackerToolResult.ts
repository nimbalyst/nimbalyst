import {
  TRACKER_LOCAL_ISSUE_KEY_MESSAGE,
  TRACKER_NO_TEAM_ISSUE_KEY_MESSAGE,
  TRACKER_UNASSIGNED_ISSUE_KEY_MESSAGE,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerLifecycle';
import {
  isLocalIssueKey,
  resolveDisplayIssueKey,
  type IssueKeyStatus,
} from '../../../shared/localIssueKey';
import { TrackerSchemaChangeBlockedError } from '../../services/tracker/trackerSchemaChangeGuard';

export type McpToolResult = {
  content: Array<{ type: string; text?: string }>;
  isError: boolean;
};

export const TRACKER_TRACKS_EXPLANATION =
  'Items in different tracks have no declared dependency edge between them, but may still touch the same files and conflict.';

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

/**
 * Re-exported, not restated. This sentence used to be hand-copied here and in
 * the CLI, and both copies missed `TRACKER_LOCAL_ISSUE_KEY_MESSAGE` when local
 * numbers landed -- which is how a numbered `idea` item came to report "no key
 * until it is published" on a tracker where publishing is refused (#1346).
 */
export const UNPUBLISHED_ISSUE_KEY_MESSAGE = TRACKER_UNASSIGNED_ISSUE_KEY_MESSAGE;
const PUBLISHED_ISSUE_KEY_PENDING_MESSAGE = 'This item is published, but its server-issued key is still pending.';
const COLLABORATIVE_BODY_WRITE_FAILURE_MESSAGE =
  'The item fields and local body snapshot were saved, but the body was not stored in collaborative tracker content. Retry the body write before treating it as available to collaborators.';
const KEY_CUSTODY_UNAVAILABLE_BODY_WRITE_FAILURE_MESSAGE =
  'The item fields and local body snapshot were saved, but server-managed key custody is unavailable for this team, so the body was not stored in collaborative tracker content. Retrying will not help until team key custody is restored.';

export type BodyWriteDiagnostic = {
  code: 'key_custody_unavailable';
  retryable: false;
};

export type BodyWriteFailure = {
  status: 'failed';
  itemFieldsStored: true;
  localSnapshotStored: boolean;
  collaborativeBodyStored: false;
  diagnostic?: BodyWriteDiagnostic;
  message: string;
};

export function bodyWriteFailure(
  localSnapshotStored: boolean,
  serverDiagnostic?: { code: string; message: string } | null,
): BodyWriteFailure {
  const custodyUnavailable = serverDiagnostic?.code === 'key_custody_unavailable';
  return {
    status: 'failed',
    itemFieldsStored: true,
    localSnapshotStored,
    collaborativeBodyStored: false,
    ...(custodyUnavailable
      ? { diagnostic: { code: 'key_custody_unavailable' as const, retryable: false as const } }
      : {}),
    message: custodyUnavailable
      ? KEY_CUSTODY_UNAVAILABLE_BODY_WRITE_FAILURE_MESSAGE
      : localSnapshotStored
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

/**
 * `IssueKeyStatus` is re-exported, not restated: the runtime owns it (see
 * `localIssueKey`), and the three states exist because reporting a numbered
 * item as `unassigned` sent agents to a publish action that a personal tracker
 * refuses outright (#1346).
 */
export type { IssueKeyStatus };

export interface IssueKeyContext {
  /** Whether the item has been published to its team room. */
  published?: boolean;
  /**
   * Whether a room exists that could mint a key at all. False for a workspace
   * with no team -- the case where "publish it to get a key" is a dead end.
   * Defaults to true so a caller that genuinely does not know does not invent
   * a claim about the workspace.
   */
  canIssueKeys?: boolean;
}

export type IssueKeyRef = { issueKey?: string | null; localKey?: string | null };

export function issueKeyStatus(item: IssueKeyRef): IssueKeyStatus {
  if (getAssignedIssueKey(item)) return 'assigned';
  return item.localKey ? 'local' : 'unassigned';
}

/**
 * What to tell a reader about a reference that is not a shared key, or nothing
 * at all when it is one.
 *
 * The absent-room case wins over every other explanation because it is the one
 * that changes what the reader should do next: no amount of publishing, waiting
 * or retrying produces a key without a team.
 */
export function issueKeyMessage(item: IssueKeyRef, context: IssueKeyContext = {}): string {
  const { published = false, canIssueKeys = true } = context;
  const status = issueKeyStatus(item);
  if (status === 'assigned') return '';
  if (status === 'local') {
    return canIssueKeys
      ? TRACKER_LOCAL_ISSUE_KEY_MESSAGE
      : `${TRACKER_NO_TEAM_ISSUE_KEY_MESSAGE} ${TRACKER_LOCAL_ISSUE_KEY_MESSAGE}`;
  }
  if (!published) return TRACKER_UNASSIGNED_ISSUE_KEY_MESSAGE;
  return canIssueKeys ? PUBLISHED_ISSUE_KEY_PENDING_MESSAGE : TRACKER_NO_TEAM_ISSUE_KEY_MESSAGE;
}

/**
 * A list response explains private local numbers once, after all rows. The
 * wording still comes from `issueKeyMessage`; this helper only deduplicates it.
 */
export function localIssueKeyResponseMessage(
  items: readonly IssueKeyRef[],
  context: IssueKeyContext = {},
): string {
  const localItem = items.find((item) => issueKeyStatus(item) === 'local');
  return localItem ? issueKeyMessage(localItem, context) : '';
}

export function issueKeyAvailabilityNote(item: IssueKeyRef, context: IssueKeyContext = {}): string {
  const message = issueKeyMessage(item, context);
  return message ? `\n- **Issue key**: ${message}` : '';
}
