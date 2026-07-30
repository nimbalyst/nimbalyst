/**
 * The live wiring behind `OrgWizardApi` — every call the wizard makes goes
 * through an existing path (team create/invite IPC, the conversation directory
 * client, the conversation append channel). Nothing new was added server-side.
 */

import {
  createDirectoryConversation,
  listConversationDirectory,
} from '../../../services/conversationDirectoryClient';
import type { CreateConversationInput } from '../../../../shared/conversationDirectory';
import { resolveViewerMemberId, type OrgRosterMember } from '../useOrgRoster';
import type { OrgWizardApi } from './orgWizardRunner';

function mutationId(): string {
  return `org-welcome-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createOrgWizardApi(): OrgWizardApi {
  return {
    async createOrganization({ name, sourcePersonalOrgId }) {
      const result = await window.electronAPI.organization.create({
        name,
        sourcePersonalOrgId,
      });
      if (!result?.success || !result.team?.orgId) {
        throw new Error(result?.error ?? 'Could not create the organization');
      }
      return { orgId: result.team.orgId as string };
    },

    async inviteMember(orgId, email) {
      const result = await window.electronAPI.organization.inviteMember(orgId, email);
      if (result?.success === false) {
        throw new Error(result.error ?? 'Could not send the invitation');
      }
    },

    listConversations(orgId) {
      return listConversationDirectory({ orgId, includeArchived: true });
    },

    async createConversation(orgId: string, input: CreateConversationInput) {
      await createDirectoryConversation({ orgId, input });
    },

    async resolveViewerUserId(orgId) {
      const [roster, accounts] = await Promise.all([
        window.electronAPI?.organization?.listMembers?.(orgId),
        window.electronAPI?.stytch?.getAccounts?.(),
      ]);
      const members: OrgRosterMember[] = roster?.success && Array.isArray(roster.members)
        ? roster.members
        : [];
      const accountRows = Array.isArray(accounts) ? accounts : [];
      return resolveViewerMemberId(
        members,
        accountRows.map((account: { email?: string | null }) => account.email),
      );
    },

    async postMessage({ orgId, conversationId, userId, text }) {
      await window.electronAPI.invoke('conversation:append', {
        orgId,
        conversationId,
        input: {
          clientMutationId: mutationId(),
          actor: { kind: 'user', userId, onBehalfOfUserId: userId },
          operation: 'messageCreated',
          payload: {
            body: { version: 1, format: 'plainText', text },
          },
        },
      });
    },
  };
}
