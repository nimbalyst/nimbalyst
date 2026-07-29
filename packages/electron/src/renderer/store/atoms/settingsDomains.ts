import { atom, useAtom } from 'jotai';
import type { ProjectSettingsTarget } from '../../components/Settings/panels/ProjectSharingPanel';

export interface PersonalAccountSummary {
  personalOrgId: string;
  personalUserId: string | null;
  email: string | null;
  userName?: string;
  isSyncAccount: boolean;
  sessionStatus: 'active' | 'expired';
}

export interface PersonalSyncProfileSummary {
  enabledProjects: string[];
  docSyncEnabledProjects: string[];
  preventSleepMode?: 'off' | 'always' | 'pluggedIn';
}

export interface OrganizationDirectoryEntry {
  orgId: string;
  name: string;
  role: string;
  membershipType?: string;
  sourcePersonalOrgId?: string;
  owningPersonalOrgId?: string | null;
  sourceEmail?: string | null;
  /** Project registry for the org; absent on snapshots from older workers. */
  projects?: Array<{ projectId: string; name: string | null; slug: string | null }>;
  /** Every signed-in account that resolved a membership in this org. */
  accountBindings?: Array<{ personalOrgId: string; teamMemberId: string }>;
  /** Account chosen from the explicit local binding — the one whose JWT this org uses. */
  boundPersonalOrgId?: string | null;
}

// These domains deliberately do not reference each other. Switching a personal
// sync account cannot mutate organization selection or project attachment.
export const personalAccountsAtom = atom<PersonalAccountSummary[]>([]);
export const personalSyncProfilesAtom = atom<Record<string, PersonalSyncProfileSummary>>({});
export const organizationDirectoryAtom = atom<OrganizationDirectoryEntry[]>([]);

/**
 * Teams is an invite-only alpha: org-creation affordances (New organization
 * buttons, create-team-from-workspace) only render in dev builds. The packaged
 * app also blocks the `team:create` IPC handler, so this is presentation-side
 * of the same policy.
 */
export const organizationCreationEnabled = import.meta.env.DEV;

/**
 * Whether the Teams/organization surfaces (settings routes, account org list,
 * org window entry points) should be visible at all. True once the account has
 * any org membership — active or pending invite — so invited users can still
 * accept. Dev builds always show the surfaces to keep the flows testable.
 */
export const teamsConfiguredAtom = atom((get) =>
  organizationCreationEnabled || get(organizationDirectoryAtom).length > 0);
export const projectSettingsContextAtom = atom<ProjectSettingsTarget | undefined>(undefined);

export const usePersonalAccounts = () => useAtom(personalAccountsAtom);
export const usePersonalSyncProfiles = () => useAtom(personalSyncProfilesAtom);
export const useOrganizationDirectory = () => useAtom(organizationDirectoryAtom);
