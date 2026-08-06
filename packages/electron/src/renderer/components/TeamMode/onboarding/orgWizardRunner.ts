/**
 * The wizard's side effects, expressed as `state -> Promise<state>` steps over
 * an injected set of APIs.
 *
 * Splitting them out of the component keeps every guard in
 * `orgWizardModel.ts` observable from a test: "run the create step twice, get
 * one organization" is a two-line assertion here and an unmockable UI dance
 * inside the dialog.
 */

import {
  markInvited,
  pendingInvites,
  type OrgWizardState,
  type PendingOrgInvitation,
} from './orgWizardModel';

export interface OrgWizardApi {
  findPendingInvitation(email: string): Promise<PendingOrgInvitation | null>;
  acceptInvitation(orgId: string): Promise<{ orgId: string }>;
  createOrganization(input: {
    name: string;
    sourcePersonalOrgId?: string;
    /** Adopts this project into the new org, as the Sharing panel used to. */
    workspacePath?: string;
  }): Promise<{ orgId: string }>;
  inviteMember(orgId: string, email: string): Promise<void>;
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
      workspacePath: state.workspacePath || undefined,
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

