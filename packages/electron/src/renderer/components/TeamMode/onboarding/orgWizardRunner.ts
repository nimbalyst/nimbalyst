/**
 * The wizard's side effects, expressed as `state -> Promise<state>` steps over
 * an injected set of APIs.
 *
 * Splitting them out of the component keeps every guard in
 * `orgWizardModel.ts` observable from a test: "run the create step twice, get
 * one organization" is a two-line assertion here and an unmockable UI dance
 * inside the dialog.
 */

import type { ConversationDirectoryEntry } from '../../../../shared/conversationDirectory';
import type { CreateConversationInput } from '../../../../shared/conversationDirectory';
import {
  markInvited,
  markRoomsCreated,
  pendingInvites,
  pendingStarterRooms,
  shouldPostWelcome,
  starterRoomCreateInput,
  welcomeMessageBody,
  type OrgWizardState,
} from './orgWizardModel';

export interface OrgWizardApi {
  createOrganization(input: {
    name: string;
    sourcePersonalOrgId?: string;
  }): Promise<{ orgId: string }>;
  inviteMember(orgId: string, email: string): Promise<void>;
  listConversations(orgId: string): Promise<ConversationDirectoryEntry[]>;
  createConversation(orgId: string, input: CreateConversationInput): Promise<void>;
  /** Resolves the caller's member id inside the new org; null when unknown. */
  resolveViewerUserId(orgId: string): Promise<string | null>;
  postMessage(input: {
    orgId: string;
    conversationId: string;
    userId: string;
    text: string;
  }): Promise<void>;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Step 1. Idempotent: an org already created by this wizard run is returned
 * unchanged, so a retry after a later step failed never mints a second org.
 */
export async function runCreateOrganization(
  state: OrgWizardState,
  api: OrgWizardApi,
): Promise<OrgWizardState> {
  if (state.createdOrgId) return { ...state, error: null };
  const name = state.orgName.trim();
  if (!name) return { ...state, error: 'Enter a name for the organization.' };
  try {
    const { orgId } = await api.createOrganization({
      name,
      sourcePersonalOrgId: state.sourcePersonalOrgId || undefined,
    });
    return { ...state, createdOrgId: orgId, error: null };
  } catch (reason) {
    return { ...state, error: errorMessage(reason) };
  }
}

/**
 * Step 2. Sends only the addresses the server has not already accepted, and
 * records each success individually so a mid-list failure does not re-invite
 * the people who already got their email.
 */
export async function runSendInvites(
  state: OrgWizardState,
  api: OrgWizardApi,
): Promise<OrgWizardState> {
  const orgId = state.createdOrgId;
  if (!orgId) return { ...state, error: 'The organization has not been created yet.' };
  let next = state;
  const failures: string[] = [];
  for (const email of pendingInvites(state)) {
    try {
      await api.inviteMember(orgId, email);
      next = markInvited(next, [email]);
    } catch (reason) {
      failures.push(`${email}: ${errorMessage(reason)}`);
    }
  }
  return {
    ...next,
    error: failures.length > 0 ? `Some invitations failed — ${failures.join('; ')}` : null,
  };
}

/**
 * Step 3. Skips rooms the org already has (including `#general`, which the
 * server seeds) so re-running the step is a no-op rather than a slug collision.
 */
export async function runCreateStarterRooms(
  state: OrgWizardState,
  api: OrgWizardApi,
): Promise<OrgWizardState> {
  const orgId = state.createdOrgId;
  if (!orgId) return { ...state, error: 'The organization has not been created yet.' };
  let existingRoomIds: string[] = [];
  try {
    const directory = await api.listConversations(orgId);
    existingRoomIds = directory.map((entry) => entry.id);
  } catch {
    // A directory that cannot be read is treated as empty: the create call
    // itself is the authority on collisions, and blocking here would strand
    // the wizard on an optional step.
  }
  let next = state;
  const failures: string[] = [];
  for (const option of pendingStarterRooms(state, existingRoomIds)) {
    try {
      await api.createConversation(orgId, starterRoomCreateInput(option));
      next = markRoomsCreated(next, [option.id]);
    } catch (reason) {
      failures.push(`#${option.id}: ${errorMessage(reason)}`);
    }
  }
  return {
    ...next,
    error: failures.length > 0 ? `Some rooms were not created — ${failures.join('; ')}` : null,
  };
}

/**
 * Step 4. The welcome message explains the window to whoever lands in
 * `#general` next; it is posted once and a failure is not fatal — the org is
 * complete without it.
 */
export async function runPostWelcomeMessage(
  state: OrgWizardState,
  api: OrgWizardApi,
  conversationId: string,
): Promise<OrgWizardState> {
  if (!shouldPostWelcome(state)) return state;
  const orgId = state.createdOrgId;
  if (!orgId) return state;
  try {
    const userId = await api.resolveViewerUserId(orgId);
    if (!userId) return state;
    await api.postMessage({
      orgId,
      conversationId,
      userId,
      text: welcomeMessageBody(state.orgName).text,
    });
    return { ...state, welcomePosted: true };
  } catch {
    // Leave `welcomePosted` false so a later run can try again.
    return state;
  }
}
